/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { EOL } from 'os';
import { spawn } from 'child_process';
import { globStream } from 'glob';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Icon,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { isGitRepository } from '../utils/gitUtils.js';
import { Config } from '../config/config.js';

/**
 * Memory safety constants to prevent heap overflow
 */
const MEMORY_SAFETY = {
  /** Maximum file size to process (50MB - conservative limit for memory safety) */
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  /** Maximum number of files to process in JavaScript fallback */
  MAX_FILES_TO_PROCESS: 10000,
  /** Maximum number of matches to collect before stopping */
  MAX_MATCHES: 10000,
  /** Maximum number of matches per file */
  MAX_MATCHES_PER_FILE: 500,
  /** Check memory usage every N files (more frequent checks) */
  MEMORY_CHECK_INTERVAL: 50,
  /** Memory usage threshold (MB) - conservative limit for broad compatibility */
  MEMORY_THRESHOLD_MB: 1000,
  /** Maximum line length to prevent memory spikes from very long lines (matches fileUtils limit) */
  MAX_LINE_LENGTH: 2000,
} as const;

/**
 * Check if memory usage is within safe limits
 */
function isMemoryUsageSafe(): boolean {
  try {
    const usage = process.memoryUsage();
    const heapUsedMB = usage.heapUsed / 1024 / 1024;
    return heapUsedMB < MEMORY_SAFETY.MEMORY_THRESHOLD_MB;
  } catch {
    // If we can't check memory, assume it's not safe
    return false;
  }
}

/**
 * Stream search through a file without loading it entirely into memory
 */
async function searchFileStream(
  filePath: string,
  regex: RegExp,
  basePath: string,
  signal: AbortSignal,
  maxMatches: number = MEMORY_SAFETY.MAX_MATCHES_PER_FILE,
): Promise<{ matches: GrepMatch[]; hasLongLines: boolean }> {
  return new Promise((resolve, reject) => {
    const matches: GrepMatch[] = [];
    let lineNumber = 0;
    let hasLongLines = false;

    const fileStream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const cleanup = () => {
      rl.close();
      fileStream.destroy();
    };

    const abortHandler = () => {
      cleanup();
      reject(new Error('Search aborted'));
    };

    signal.addEventListener('abort', abortHandler, { once: true });

    rl.on('line', (line) => {
      lineNumber++;

      // Warn about extremely long lines but continue processing
      if (line.length > MEMORY_SAFETY.MAX_LINE_LENGTH) {
        hasLongLines = true;
        console.debug(
          `GrepLogic: Warning - Found long line (${line.length} chars) in ${filePath} at line ${lineNumber}. Search continues but performance may be affected.`,
        );
      }

      if (regex.test(line)) {
        matches.push({
          filePath:
            path.relative(basePath, filePath) || path.basename(filePath),
          lineNumber,
          line,
        });

        // Stop if we've found enough matches in this file
        if (matches.length >= maxMatches) {
          cleanup();
          signal.removeEventListener('abort', abortHandler);
          resolve({ matches, hasLongLines });
          return;
        }
      }
    });

    rl.on('error', (error) => {
      cleanup();
      signal.removeEventListener('abort', abortHandler);
      reject(error);
    });

    rl.on('close', () => {
      signal.removeEventListener('abort', abortHandler);
      resolve({ matches, hasLongLines });
    });
  });
}

/**
 * Parameters for the GrepTool
 */
export interface GrepToolParams {
  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory relative to root)
   */
  path?: string;

  /**
   * File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")
   */
  include?: string;
}

/**
 * Result object for a single grep match
 */
interface GrepMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

class GrepToolInvocation extends BaseToolInvocation<
  GrepToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: GrepToolParams,
  ) {
    super(params);
  }

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists, or null if no path specified (to search all directories).
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string | null {
    // If no path specified, return null to indicate searching all workspace directories
    if (!relativePath) {
      return null;
    }

    const targetPath = path.resolve(this.config.getTargetDir(), relativePath);

    // Security Check: Ensure the resolved path is within workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        `Path validation failed: Attempted path "${relativePath}" resolves outside the allowed workspace directories: ${directories.join(', ')}`,
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access path stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const workspaceContext = this.config.getWorkspaceContext();
      const searchDirAbs = this.resolveAndValidatePath(this.params.path);
      const searchDirDisplay = this.params.path || '.';

      // Determine which directories to search
      let searchDirectories: readonly string[];
      if (searchDirAbs === null) {
        // No path specified - search all workspace directories
        searchDirectories = workspaceContext.getDirectories();
      } else {
        // Specific path provided - search only that directory
        searchDirectories = [searchDirAbs];
      }

      // Collect matches from all search directories
      let allMatches: GrepMatch[] = [];
      let hasLongLinesWarning = false;
      for (const searchDir of searchDirectories) {
        const searchResult = await this.performGrepSearch({
          pattern: this.params.pattern,
          path: searchDir,
          include: this.params.include,
          signal,
        });

        // Add directory prefix if searching multiple directories
        if (searchDirectories.length > 1) {
          const dirName = path.basename(searchDir);
          searchResult.matches.forEach((match) => {
            match.filePath = path.join(dirName, match.filePath);
          });
        }

        allMatches = allMatches.concat(searchResult.matches);
        if (searchResult.hasLongLinesWarning) {
          hasLongLinesWarning = true;
        }
      }

      let searchLocationDescription: string;
      if (searchDirAbs === null) {
        const numDirs = workspaceContext.getDirectories().length;
        searchLocationDescription =
          numDirs > 1
            ? `across ${numDirs} workspace directories`
            : `in the workspace directory`;
      } else {
        searchLocationDescription = `in path "${searchDirDisplay}"`;
      }

      if (allMatches.length === 0) {
        const noMatchMsg = `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${this.params.include ? ` (filter: "${this.params.include}")` : ''}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }

      // Group matches by file
      const matchesByFile = allMatches.reduce(
        (acc, match) => {
          const fileKey = match.filePath;
          if (!acc[fileKey]) {
            acc[fileKey] = [];
          }
          acc[fileKey].push(match);
          acc[fileKey].sort((a, b) => a.lineNumber - b.lineNumber);
          return acc;
        },
        {} as Record<string, GrepMatch[]>,
      );

      const matchCount = allMatches.length;
      const matchTerm = matchCount === 1 ? 'match' : 'matches';

      // Check if we hit any limits and add appropriate warnings
      const limitWarnings: string[] = [];
      if (matchCount >= MEMORY_SAFETY.MAX_MATCHES) {
        limitWarnings.push(
          `⚠️  Search stopped at ${MEMORY_SAFETY.MAX_MATCHES} matches limit for memory safety. Try narrowing your search pattern or using the 'include' filter to search specific file types.`,
        );
      }
      if (hasLongLinesWarning) {
        limitWarnings.push(
          `⚠️  Some files contain very long lines (>${MEMORY_SAFETY.MAX_LINE_LENGTH} characters). Performance may be affected.`,
        );
      }

      let llmContent = `Found ${matchCount} ${matchTerm} for pattern "${this.params.pattern}" ${searchLocationDescription}${this.params.include ? ` (filter: "${this.params.include}")` : ''}`;

      if (limitWarnings.length > 0) {
        llmContent += `\n\n${limitWarnings.join('\n')}`;
      }

      llmContent += `:\n---\n`;

      for (const filePath in matchesByFile) {
        llmContent += `File: ${filePath}\n`;
        matchesByFile[filePath].forEach((match) => {
          const trimmedLine = match.line.trim();
          llmContent += `L${match.lineNumber}: ${trimmedLine}\n`;
        });
        llmContent += '---\n';
      }

      let displayMessage = `Found ${matchCount} ${matchTerm}`;
      if (limitWarnings.length > 0) {
        displayMessage += ' (search limited)';
      }

      return {
        llmContent: llmContent.trim(),
        returnDisplay: displayMessage,
      };
    } catch (error) {
      console.error(`Error during GrepLogic execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  /**
   * Checks if a command is available in the system's PATH.
   * @param {string} command The command name (e.g., 'git', 'grep').
   * @returns {Promise<boolean>} True if the command is available, false otherwise.
   */
  private isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const checkCommand = process.platform === 'win32' ? 'where' : 'command';
      const checkArgs =
        process.platform === 'win32' ? [command] : ['-v', command];
      try {
        const child = spawn(checkCommand, checkArgs, {
          stdio: 'ignore',
          shell: process.platform === 'win32',
        });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Parses the standard output of grep-like commands (git grep, system grep).
   * Expects format: filePath:lineNumber:lineContent
   * Handles colons within file paths and line content correctly.
   * @param {string} output The raw stdout string.
   * @param {string} basePath The absolute directory the search was run from, for relative paths.
   * @returns {GrepMatch[]} Array of match objects.
   */
  private parseGrepOutput(output: string, basePath: string): GrepMatch[] {
    const results: GrepMatch[] = [];
    if (!output) return results;

    const lines = output.split(EOL); // Use OS-specific end-of-line

    for (const line of lines) {
      if (!line.trim()) continue;

      // Find the index of the first colon.
      const firstColonIndex = line.indexOf(':');
      if (firstColonIndex === -1) continue; // Malformed

      // Find the index of the second colon, searching *after* the first one.
      const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
      if (secondColonIndex === -1) continue; // Malformed

      // Extract parts based on the found colon indices
      const filePathRaw = line.substring(0, firstColonIndex);
      const lineNumberStr = line.substring(
        firstColonIndex + 1,
        secondColonIndex,
      );
      const lineContent = line.substring(secondColonIndex + 1);

      const lineNumber = parseInt(lineNumberStr, 10);

      if (!isNaN(lineNumber)) {
        const absoluteFilePath = path.resolve(basePath, filePathRaw);
        const relativeFilePath = path.relative(basePath, absoluteFilePath);

        results.push({
          filePath: relativeFilePath || path.basename(absoluteFilePath),
          lineNumber,
          line: lineContent,
        });
      }
    }
    return results;
  }

  /**
   * Gets a description of the grep operation
   * @param params Parameters for the grep operation
   * @returns A string describing the grep
   */
  getDescription(): string {
    let description = `'${this.params.pattern}'`;
    if (this.params.include) {
      description += ` in ${this.params.include}`;
    }
    if (this.params.path) {
      const resolvedPath = path.resolve(
        this.config.getTargetDir(),
        this.params.path,
      );
      if (
        resolvedPath === this.config.getTargetDir() ||
        this.params.path === '.'
      ) {
        description += ` within ./`;
      } else {
        const relativePath = makeRelative(
          resolvedPath,
          this.config.getTargetDir(),
        );
        description += ` within ${shortenPath(relativePath)}`;
      }
    } else {
      // When no path is specified, indicate searching all workspace directories
      const workspaceContext = this.config.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();
      if (directories.length > 1) {
        description += ` across all workspace directories`;
      }
    }
    return description;
  }

  /**
   * Performs the actual search using the prioritized strategies.
   * @param options Search options including pattern, absolute path, and include glob.
   * @returns A promise resolving to search results with matches and warning flags.
   */
  private async performGrepSearch(options: {
    pattern: string;
    path: string; // Expects absolute path
    include?: string;
    signal: AbortSignal;
  }): Promise<{ matches: GrepMatch[]; hasLongLinesWarning: boolean }> {
    const { pattern, path: absolutePath, include } = options;
    let strategyUsed = 'none';

    // Check if operation was already aborted
    if (options.signal.aborted) {
      throw new Error('Search aborted');
    }

    try {
      // Strategy 1: git grep
      const isGit = isGitRepository(absolutePath);
      const gitAvailable = isGit && (await this.isCommandAvailable('git'));

      if (gitAvailable) {
        strategyUsed = 'git grep';
        const gitArgs = [
          'grep',
          '--untracked',
          '-n',
          '-E',
          '--ignore-case',
          pattern,
        ];
        if (include) {
          gitArgs.push('--', include);
        }

        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('git', gitArgs, {
              cwd: absolutePath,
              windowsHide: true,
            });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
            child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
            child.on('error', (err) =>
              reject(new Error(`Failed to start git grep: ${err.message}`)),
            );
            child.on('close', (code) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
              const stderrData = Buffer.concat(stderrChunks).toString('utf8');
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve(''); // No matches
              else
                reject(
                  new Error(`git grep exited with code ${code}: ${stderrData}`),
                );
            });
          });
          return {
            matches: this.parseGrepOutput(output, absolutePath),
            hasLongLinesWarning: false,
          };
        } catch (gitError: unknown) {
          console.debug(
            `GrepLogic: git grep failed: ${getErrorMessage(
              gitError,
            )}. Falling back...`,
          );
        }
      }

      // Strategy 2: System grep
      const grepAvailable = await this.isCommandAvailable('grep');
      if (grepAvailable) {
        strategyUsed = 'system grep';
        const grepArgs = ['-r', '-n', '-H', '-E'];
        const commonExcludes = ['.git', 'node_modules', 'bower_components'];
        commonExcludes.forEach((dir) => grepArgs.push(`--exclude-dir=${dir}`));
        if (include) {
          grepArgs.push(`--include=${include}`);
        }
        grepArgs.push(pattern);
        grepArgs.push('.');

        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('grep', grepArgs, {
              cwd: absolutePath,
              windowsHide: true,
            });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            const onData = (chunk: Buffer) => stdoutChunks.push(chunk);
            const onStderr = (chunk: Buffer) => {
              const stderrStr = chunk.toString();
              // Suppress common harmless stderr messages
              if (
                !stderrStr.includes('Permission denied') &&
                !/grep:.*: Is a directory/i.test(stderrStr)
              ) {
                stderrChunks.push(chunk);
              }
            };
            const onError = (err: Error) => {
              cleanup();
              reject(new Error(`Failed to start system grep: ${err.message}`));
            };
            const onClose = (code: number | null) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
              const stderrData = Buffer.concat(stderrChunks)
                .toString('utf8')
                .trim();
              cleanup();
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve(''); // No matches
              else {
                if (stderrData)
                  reject(
                    new Error(
                      `System grep exited with code ${code}: ${stderrData}`,
                    ),
                  );
                else resolve(''); // Exit code > 1 but no stderr, likely just suppressed errors
              }
            };

            const cleanup = () => {
              child.stdout.removeListener('data', onData);
              child.stderr.removeListener('data', onStderr);
              child.removeListener('error', onError);
              child.removeListener('close', onClose);
              if (child.connected) {
                child.disconnect();
              }
            };

            child.stdout.on('data', onData);
            child.stderr.on('data', onStderr);
            child.on('error', onError);
            child.on('close', onClose);
          });
          return {
            matches: this.parseGrepOutput(output, absolutePath),
            hasLongLinesWarning: false,
          };
        } catch (grepError: unknown) {
          console.debug(
            `GrepLogic: System grep failed: ${getErrorMessage(
              grepError,
            )}. Falling back...`,
          );
        }
      }

      // Strategy 3: Memory-Safe JavaScript Fallback
      console.debug(
        'GrepLogic: Falling back to memory-safe JavaScript grep implementation.',
      );
      strategyUsed = 'javascript fallback';
      const globPattern = include ? include : '**/*';
      const ignorePatterns = [
        '.git/**',
        'node_modules/**',
        'bower_components/**',
        '.svn/**',
        '.hg/**',
        '*.log',
        '*.bin',
        '*.exe',
        '*.dll',
        '*.so',
        '*.dylib',
        '*.jar',
        '*.class',
        '*.pyc',
        '*.pyo',
        '*.wasm',
      ];

      const filesStream = globStream(globPattern, {
        cwd: absolutePath,
        dot: true,
        ignore: ignorePatterns,
        absolute: true,
        nodir: true,
        signal: options.signal,
      });

      const regex = new RegExp(pattern, 'i');
      const allMatches: GrepMatch[] = [];
      let filesProcessed = 0;
      let skippedFiles = 0;
      let memoryWarning = false;
      let hasLongLinesWarning = false;

      for await (const filePath of filesStream) {
        const fileAbsolutePath = filePath as string;

        // Check if we've hit our limits
        if (filesProcessed >= MEMORY_SAFETY.MAX_FILES_TO_PROCESS) {
          console.debug(
            `GrepLogic: Reached maximum file limit (${MEMORY_SAFETY.MAX_FILES_TO_PROCESS}). Stopping search.`,
          );
          break;
        }

        if (allMatches.length >= MEMORY_SAFETY.MAX_MATCHES) {
          console.debug(
            `GrepLogic: Reached maximum matches limit (${MEMORY_SAFETY.MAX_MATCHES}). Stopping search.`,
          );
          break;
        }

        // Check memory usage periodically
        if (
          filesProcessed % MEMORY_SAFETY.MEMORY_CHECK_INTERVAL === 0 &&
          filesProcessed > 0
        ) {
          if (!isMemoryUsageSafe()) {
            memoryWarning = true;
            console.debug(
              `GrepLogic: Memory usage approaching limit. Stopping search for safety.`,
            );
            break;
          }
        }

        try {
          // Check file size before processing
          const stats = await fsPromises.stat(fileAbsolutePath);
          if (stats.size > MEMORY_SAFETY.MAX_FILE_SIZE) {
            skippedFiles++;
            console.debug(
              `GrepLogic: Skipping large file ${fileAbsolutePath} (${(stats.size / 1024 / 1024).toFixed(1)}MB) - exceeds ${(MEMORY_SAFETY.MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB limit for memory safety`,
            );
            continue;
          }

          // For small files (< 1MB), use the fast approach
          if (stats.size < 1024 * 1024) {
            const content = await fsPromises.readFile(fileAbsolutePath, 'utf8');
            const lines = content.split(/\r?\n/);
            let fileMatchCount = 0;

            lines.forEach((line, index) => {
              // Check for long lines in small files too
              if (line.length > MEMORY_SAFETY.MAX_LINE_LENGTH) {
                hasLongLinesWarning = true;
                console.debug(
                  `GrepLogic: Warning - Found long line (${line.length} chars) in ${fileAbsolutePath} at line ${index + 1}. Performance may be affected.`,
                );
              }

              if (
                fileMatchCount < MEMORY_SAFETY.MAX_MATCHES_PER_FILE &&
                regex.test(line)
              ) {
                allMatches.push({
                  filePath:
                    path.relative(absolutePath, fileAbsolutePath) ||
                    path.basename(fileAbsolutePath),
                  lineNumber: index + 1,
                  line,
                });
                fileMatchCount++;
              }
            });
          } else {
            // For larger files, use streaming approach
            const streamResult = await searchFileStream(
              fileAbsolutePath,
              regex,
              absolutePath,
              options.signal,
              MEMORY_SAFETY.MAX_MATCHES_PER_FILE,
            );
            allMatches.push(...streamResult.matches);
            if (streamResult.hasLongLines) {
              hasLongLinesWarning = true;
            }
          }

          filesProcessed++;
        } catch (readError: unknown) {
          // Ignore errors like permission denied or file gone during read
          if (!isNodeError(readError) || readError.code !== 'ENOENT') {
            console.debug(
              `GrepLogic: Could not read/process ${fileAbsolutePath}: ${getErrorMessage(
                readError,
              )}`,
            );
          }
        }
      }

      // Log summary information and add user-friendly warnings
      if (skippedFiles > 0 || memoryWarning) {
        if (skippedFiles > 0) {
          console.debug(
            `GrepLogic: Skipped ${skippedFiles} large files (>${(MEMORY_SAFETY.MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB each) to prevent memory issues. Consider searching within specific directories or file types.`,
          );
        }

        if (memoryWarning) {
          console.debug(
            `GrepLogic: Search stopped early due to memory constraints. Processed ${filesProcessed} files, found ${allMatches.length} matches. Try searching within specific directories or using more specific patterns.`,
          );
        }
      }

      return { matches: allMatches, hasLongLinesWarning };
    } catch (error: unknown) {
      console.error(
        `GrepLogic: Error in performGrepSearch (Strategy: ${strategyUsed}): ${getErrorMessage(
          error,
        )}`,
      );
      throw error;
    }
  }
}

/**
 * Implementation of the Grep tool logic (moved from CLI)
 */
export class GrepTool extends BaseDeclarativeTool<GrepToolParams, ToolResult> {
  static readonly Name = 'search_file_content';

  constructor(private readonly config: Config) {
    super(
      GrepTool.Name,
      'SearchText',
      'Searches for a regular expression pattern within the content of files in a specified directory (or current working directory). Can filter files by a glob pattern. Returns the lines containing matches, along with their file paths and line numbers.',
      Icon.Regex,
      {
        properties: {
          pattern: {
            description:
              "The regular expression (regex) pattern to search for within file contents (e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').",
            type: Type.STRING,
          },
          path: {
            description:
              'Optional: The absolute path to the directory to search within. If omitted, searches the current working directory.',
            type: Type.STRING,
          },
          include: {
            description:
              "Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). If omitted, searches all files (respecting potential global ignores).",
            type: Type.STRING,
          },
        },
        required: ['pattern'],
        type: Type.OBJECT,
      },
    );
  }

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists, or null if no path specified (to search all directories).
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string | null {
    // If no path specified, return null to indicate searching all workspace directories
    if (!relativePath) {
      return null;
    }

    const targetPath = path.resolve(this.config.getTargetDir(), relativePath);

    // Security Check: Ensure the resolved path is within workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        `Path validation failed: Attempted path "${relativePath}" resolves outside the allowed workspace directories: ${directories.join(', ')}`,
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access path stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
  }

  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  validateToolParams(params: GrepToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    try {
      new RegExp(params.pattern);
    } catch (error) {
      return `Invalid regular expression pattern: "${params.pattern}". ${getErrorMessage(error)}. Please check your pattern syntax and try again.`;
    }

    // Only validate path if one is provided
    if (params.path) {
      try {
        this.resolveAndValidatePath(params.path);
      } catch (error) {
        return getErrorMessage(error);
      }
    }

    return null; // Parameters are valid
  }

  protected createInvocation(
    params: GrepToolParams,
  ): ToolInvocation<GrepToolParams, ToolResult> {
    return new GrepToolInvocation(this.config, params);
  }
}
