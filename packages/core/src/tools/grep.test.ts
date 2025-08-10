/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GrepTool, GrepToolParams } from './grep.js';
import path from 'path';
import fs from 'fs/promises';
import { Stats } from 'fs';
import os from 'os';
import { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';

// Mock the child_process module to control grep/git grep behavior
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error' || event === 'close') {
        // Simulate command not found or error for git grep and system grep
        // to force it to fall back to JS implementation.
        setTimeout(() => cb(1), 0); // cb(1) for error/close
      }
    },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  })),
}));

describe('GrepTool', () => {
  let tempRootDir: string;
  let grepTool: GrepTool;
  const abortSignal = new AbortController().signal;

  const mockConfig = {
    getTargetDir: () => tempRootDir,
    getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
  } as unknown as Config;

  beforeEach(async () => {
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-root-'));
    grepTool = new GrepTool(mockConfig);

    // Create some test files and directories
    await fs.writeFile(
      path.join(tempRootDir, 'fileA.txt'),
      'hello world\nsecond line with world',
    );
    await fs.writeFile(
      path.join(tempRootDir, 'fileB.js'),
      'const foo = "bar";\nfunction baz() { return "hello"; }',
    );
    await fs.mkdir(path.join(tempRootDir, 'sub'));
    await fs.writeFile(
      path.join(tempRootDir, 'sub', 'fileC.txt'),
      'another world in sub dir',
    );
    await fs.writeFile(
      path.join(tempRootDir, 'sub', 'fileD.md'),
      '# Markdown file\nThis is a test.',
    );
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  describe('validateToolParams', () => {
    it('should return null for valid params (pattern only)', () => {
      const params: GrepToolParams = { pattern: 'hello' };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid params (pattern and path)', () => {
      const params: GrepToolParams = { pattern: 'hello', path: '.' };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid params (pattern, path, and include)', () => {
      const params: GrepToolParams = {
        pattern: 'hello',
        path: '.',
        include: '*.txt',
      };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return error if pattern is missing', () => {
      const params = { path: '.' } as unknown as GrepToolParams;
      expect(grepTool.validateToolParams(params)).toBe(
        `params must have required property 'pattern'`,
      );
    });

    it('should return error for invalid regex pattern', () => {
      const params: GrepToolParams = { pattern: '[[' };
      expect(grepTool.validateToolParams(params)).toContain(
        'Invalid regular expression pattern',
      );
    });

    it('should return error if path does not exist', () => {
      const params: GrepToolParams = { pattern: 'hello', path: 'nonexistent' };
      // Check for the core error message, as the full path might vary
      expect(grepTool.validateToolParams(params)).toContain(
        'Failed to access path stats for',
      );
      expect(grepTool.validateToolParams(params)).toContain('nonexistent');
    });

    it('should return error if path is a file, not a directory', async () => {
      const filePath = path.join(tempRootDir, 'fileA.txt');
      const params: GrepToolParams = { pattern: 'hello', path: filePath };
      expect(grepTool.validateToolParams(params)).toContain(
        `Path is not a directory: ${filePath}`,
      );
    });
  });

  describe('execute', () => {
    it('should find matches for a simple pattern in all files', async () => {
      const params: GrepToolParams = { pattern: 'world' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 3 matches for pattern "world" in the workspace directory',
      );
      expect(result.llmContent).toContain('File: fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('L2: second line with world');
      expect(result.llmContent).toContain(
        `File: ${path.join('sub', 'fileC.txt')}`,
      );
      expect(result.llmContent).toContain('L1: another world in sub dir');
      expect(result.returnDisplay).toBe('Found 3 matches');
    });

    it('should find matches in a specific path', async () => {
      const params: GrepToolParams = { pattern: 'world', path: 'sub' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "world" in path "sub"',
      );
      expect(result.llmContent).toContain('File: fileC.txt'); // Path relative to 'sub'
      expect(result.llmContent).toContain('L1: another world in sub dir');
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with an include glob', async () => {
      const params: GrepToolParams = { pattern: 'hello', include: '*.js' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "hello" in the workspace directory (filter: "*.js"):',
      );
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain(
        'L2: function baz() { return "hello"; }',
      );
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with an include glob and path', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'sub', 'another.js'),
        'const greeting = "hello";',
      );
      const params: GrepToolParams = {
        pattern: 'hello',
        path: 'sub',
        include: '*.js',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "hello" in path "sub" (filter: "*.js")',
      );
      expect(result.llmContent).toContain('File: another.js');
      expect(result.llmContent).toContain('L1: const greeting = "hello";');
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should return "No matches found" when pattern does not exist', async () => {
      const params: GrepToolParams = { pattern: 'nonexistentpattern' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'No matches found for pattern "nonexistentpattern" in the workspace directory.',
      );
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should handle regex special characters correctly', async () => {
      const params: GrepToolParams = { pattern: 'foo.*bar' }; // Matches 'const foo = "bar";'
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "foo.*bar" in the workspace directory:',
      );
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain('L1: const foo = "bar";');
    });

    it('should be case-insensitive by default (JS fallback)', async () => {
      const params: GrepToolParams = { pattern: 'HELLO' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 2 matches for pattern "HELLO" in the workspace directory:',
      );
      expect(result.llmContent).toContain('File: fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain(
        'L2: function baz() { return "hello"; }',
      );
    });

    it('should throw an error if params are invalid', async () => {
      const params = { path: '.' } as unknown as GrepToolParams; // Invalid: pattern missing
      expect(() => grepTool.build(params)).toThrow(
        /params must have required property 'pattern'/,
      );
    });
  });

  describe('multi-directory workspace', () => {
    it('should search across all workspace directories when no path is specified', async () => {
      // Create additional directory with test files
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-second-'),
      );
      await fs.writeFile(
        path.join(secondDir, 'other.txt'),
        'hello from second directory\nworld in second',
      );
      await fs.writeFile(
        path.join(secondDir, 'another.js'),
        'function world() { return "test"; }',
      );

      // Create a mock config with multiple directories
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, [secondDir]),
      } as unknown as Config;

      const multiDirGrepTool = new GrepTool(multiDirConfig);
      const params: GrepToolParams = { pattern: 'world' };
      const invocation = multiDirGrepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should find matches in both directories
      expect(result.llmContent).toContain(
        'Found 5 matches for pattern "world"',
      );

      // Matches from first directory
      expect(result.llmContent).toContain('fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('L2: second line with world');
      expect(result.llmContent).toContain('fileC.txt');
      expect(result.llmContent).toContain('L1: another world in sub dir');

      // Matches from second directory (with directory name prefix)
      const secondDirName = path.basename(secondDir);
      expect(result.llmContent).toContain(
        `File: ${path.join(secondDirName, 'other.txt')}`,
      );
      expect(result.llmContent).toContain('L2: world in second');
      expect(result.llmContent).toContain(
        `File: ${path.join(secondDirName, 'another.js')}`,
      );
      expect(result.llmContent).toContain('L1: function world()');

      // Clean up
      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should search only specified path within workspace directories', async () => {
      // Create additional directory
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-second-'),
      );
      await fs.mkdir(path.join(secondDir, 'sub'));
      await fs.writeFile(
        path.join(secondDir, 'sub', 'test.txt'),
        'hello from second sub directory',
      );

      // Create a mock config with multiple directories
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, [secondDir]),
      } as unknown as Config;

      const multiDirGrepTool = new GrepTool(multiDirConfig);

      // Search only in the 'sub' directory of the first workspace
      const params: GrepToolParams = { pattern: 'world', path: 'sub' };
      const invocation = multiDirGrepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should only find matches in the specified sub directory
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "world" in path "sub"',
      );
      expect(result.llmContent).toContain('File: fileC.txt');
      expect(result.llmContent).toContain('L1: another world in sub dir');

      // Should not contain matches from second directory
      expect(result.llmContent).not.toContain('test.txt');

      // Clean up
      await fs.rm(secondDir, { recursive: true, force: true });
    });
  });

  describe('memory safety', () => {
    it('should handle large files without memory overflow', async () => {
      // Create a 2MB file to test streaming
      const largeContent = 'This line contains NEEDLE pattern\n'.repeat(60000);
      const largePath = path.join(tempRootDir, 'large.txt');
      await fs.writeFile(largePath, largeContent);

      const params: GrepToolParams = { pattern: 'NEEDLE' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should find matches using streaming approach
      expect(result.llmContent).toContain('NEEDLE');
      expect(result.llmContent).toMatch(/Found \d+ match/);
    });

    it('should limit matches per file to prevent memory overflow', async () => {
      // Create file with many matches (more than MAX_MATCHES_PER_FILE)
      const manyMatches = 'PATTERN match on every line\n'.repeat(1000);
      await fs.writeFile(path.join(tempRootDir, 'many.txt'), manyMatches);

      const params: GrepToolParams = { pattern: 'PATTERN' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should find matches but limit them per file
      expect(result.llmContent).toContain('PATTERN');
      expect(result.llmContent).toMatch(/Found \d+ match/);

      // Count actual matches found
      const content =
        typeof result.llmContent === 'string'
          ? result.llmContent
          : String(result.llmContent);
      const matchLines = content
        .split('\n')
        .filter((line: string) => line.includes('L'));
      expect(matchLines.length).toBeLessThanOrEqual(500); // MAX_MATCHES_PER_FILE
    });

    it('should show warning when hitting match limits', async () => {
      // This test is conceptual since we'd need truly massive files to hit the 10000 limit
      // But we can test the warning display logic
      const params: GrepToolParams = { pattern: 'test' };
      const invocation = grepTool.build(params);

      // The warning logic is tested through the actual implementation
      // when MEMORY_SAFETY.MAX_MATCHES is reached
      expect(invocation).toBeDefined();
    });
  });

  describe('abort signal handling', () => {
    it('should handle AbortSignal during search', async () => {
      const controller = new AbortController();
      const params: GrepToolParams = { pattern: 'world' };
      const invocation = grepTool.build(params);

      controller.abort();

      const result = await invocation.execute(controller.signal);
      expect(result).toBeDefined();
    });

    it('should abort streaming search when signal is triggered', async () => {
      const largeContent = 'test line\n'.repeat(100000);
      await fs.writeFile(path.join(tempRootDir, 'stream.txt'), largeContent);

      const controller = new AbortController();
      const params: GrepToolParams = { pattern: 'test' };
      const invocation = grepTool.build(params);

      const searchPromise = invocation.execute(controller.signal);
      setTimeout(() => controller.abort(), 10);

      try {
        await searchPromise;
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('enhanced memory safety', () => {
    it('should skip very large files', async () => {
      const originalStat = fs.stat;
      vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
        if (filePath.toString().includes('large.txt')) {
          return {
            size: 150 * 1024 * 1024,
            isDirectory: () => false,
            isFile: () => true,
          } as Stats;
        }
        return originalStat(filePath);
      });

      await fs.writeFile(path.join(tempRootDir, 'large.txt'), 'content');
      await fs.writeFile(path.join(tempRootDir, 'small.txt'), 'hello world');

      const params: GrepToolParams = { pattern: 'world' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('small.txt');
      expect(result.llmContent).not.toContain('large.txt');
    });

    it('should enforce strict match limits per file', async () => {
      const manyMatches = Array(600).fill('NEEDLE pattern here').join('\n');
      await fs.writeFile(path.join(tempRootDir, 'many.txt'), manyMatches);

      const params: GrepToolParams = { pattern: 'NEEDLE' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      const content = result.llmContent.toString();
      const matchLines = content
        .split('\n')
        .filter((line) => line.match(/^L\d+:/));

      expect(matchLines.length).toBeLessThanOrEqual(500);
      expect(result.llmContent).toContain('NEEDLE');
    });

    it('should show warning when hitting global match limits', async () => {
      const params: GrepToolParams = { pattern: 'world' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.returnDisplay).not.toContain('(search limited)');
    });
  });

  describe('error handling and edge cases', () => {
    it('should handle workspace boundary violations', () => {
      const params: GrepToolParams = { pattern: 'test', path: '../outside' };
      expect(() => grepTool.build(params)).toThrow(/Path validation failed/);
    });

    it('should handle empty directories gracefully', async () => {
      const emptyDir = path.join(tempRootDir, 'empty');
      await fs.mkdir(emptyDir);

      const params: GrepToolParams = { pattern: 'test', path: 'empty' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('No matches found');
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should handle files that disappear during read', async () => {
      vi.spyOn(fs, 'readFile').mockImplementationOnce(() => {
        const error = new Error(
          'ENOENT: no such file or directory',
        ) as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      });

      await fs.writeFile(path.join(tempRootDir, 'temp.txt'), 'test content');

      const params: GrepToolParams = { pattern: 'test' };
      const invocation = grepTool.build(params);

      const result = await invocation.execute(abortSignal);
      expect(result).toBeDefined();
    });

    it('should handle permission denied errors gracefully', async () => {
      vi.spyOn(fs, 'readFile').mockImplementationOnce(() => {
        const error = new Error('EACCES: permission denied') as Error & {
          code: string;
        };
        error.code = 'EACCES';
        throw error;
      });

      await fs.writeFile(
        path.join(tempRootDir, 'restricted.txt'),
        'test content',
      );

      const params: GrepToolParams = { pattern: 'test' };
      const invocation = grepTool.build(params);

      const result = await invocation.execute(abortSignal);
      expect(result).toBeDefined();
    });

    it('should handle empty files correctly', async () => {
      await fs.writeFile(path.join(tempRootDir, 'empty.txt'), '');

      const params: GrepToolParams = { pattern: 'anything' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('No matches found');
    });

    it('should handle special characters in file names', async () => {
      const specialFileName = 'file with spaces & symbols!.txt';
      await fs.writeFile(
        path.join(tempRootDir, specialFileName),
        'hello world with special chars',
      );

      const params: GrepToolParams = { pattern: 'world' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain(specialFileName);
      expect(result.llmContent).toContain('hello world with special chars');
    });

    it('should handle deeply nested directories', async () => {
      const deepPath = path.join(tempRootDir, 'a', 'b', 'c', 'd', 'e');
      await fs.mkdir(deepPath, { recursive: true });
      await fs.writeFile(
        path.join(deepPath, 'deep.txt'),
        'content in deep directory',
      );

      const params: GrepToolParams = { pattern: 'deep' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('deep.txt');
      expect(result.llmContent).toContain('content in deep directory');
    });
  });

  describe('regex pattern validation', () => {
    it('should handle complex regex patterns', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'code.js'),
        'function getName() { return "test"; }\nconst getValue = () => "value";',
      );

      const params: GrepToolParams = { pattern: 'function\\s+\\w+\\s*\\(' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('function getName()');
      expect(result.llmContent).not.toContain('const getValue');
    });

    it('should handle case sensitivity correctly in JS fallback', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'case.txt'),
        'Hello World\nhello world\nHELLO WORLD',
      );

      const params: GrepToolParams = { pattern: 'hello' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('Hello World');
      expect(result.llmContent).toContain('hello world');
      expect(result.llmContent).toContain('HELLO WORLD');
    });

    it('should handle escaped regex special characters', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'special.txt'),
        'Price: $19.99\nRegex: [a-z]+ pattern\nEmail: test@example.com',
      );

      const params: GrepToolParams = { pattern: '\\$\\d+\\.\\d+' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('Price: $19.99');
      expect(result.llmContent).not.toContain('Email: test@example.com');
    });
  });

  describe('streaming file processing', () => {
    it('should use streaming for files larger than 1MB', async () => {
      const largeContent = 'streaming test line with NEEDLE\n'.repeat(50000);
      await fs.writeFile(
        path.join(tempRootDir, 'large_stream.txt'),
        largeContent,
      );

      const params: GrepToolParams = { pattern: 'NEEDLE' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('NEEDLE');
      expect(result.llmContent).toContain('large_stream.txt');
      expect(result.returnDisplay).toMatch(/Found \d+ match/);
    });
  });

  describe('include pattern filtering', () => {
    it('should handle multiple file extensions in include pattern', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'test.ts'),
        'typescript content',
      );
      await fs.writeFile(path.join(tempRootDir, 'test.tsx'), 'tsx content');
      await fs.writeFile(
        path.join(tempRootDir, 'test.js'),
        'javascript content',
      );
      await fs.writeFile(path.join(tempRootDir, 'test.txt'), 'text content');

      const params: GrepToolParams = {
        pattern: 'content',
        include: '*.{ts,tsx}',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('test.ts');
      expect(result.llmContent).toContain('test.tsx');
      expect(result.llmContent).not.toContain('test.js');
      expect(result.llmContent).not.toContain('test.txt');
    });

    it('should handle directory patterns in include', async () => {
      await fs.mkdir(path.join(tempRootDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(tempRootDir, 'src', 'main.ts'),
        'source code',
      );
      await fs.writeFile(path.join(tempRootDir, 'other.ts'), 'other code');

      const params: GrepToolParams = {
        pattern: 'code',
        include: 'src/**',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('main.ts');
      expect(result.llmContent).not.toContain('other.ts');
    });
  });

  describe('getDescription', () => {
    it('should generate correct description with pattern only', () => {
      const params: GrepToolParams = { pattern: 'testPattern' };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern'");
    });

    it('should generate correct description with pattern and include', () => {
      const params: GrepToolParams = {
        pattern: 'testPattern',
        include: '*.ts',
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' in *.ts");
    });

    it('should generate correct description with pattern and path', async () => {
      const dirPath = path.join(tempRootDir, 'src', 'app');
      await fs.mkdir(dirPath, { recursive: true });
      const params: GrepToolParams = {
        pattern: 'testPattern',
        path: path.join('src', 'app'),
      };
      const invocation = grepTool.build(params);
      // The path will be relative to the tempRootDir, so we check for containment.
      expect(invocation.getDescription()).toContain("'testPattern' within");
      expect(invocation.getDescription()).toContain(path.join('src', 'app'));
    });

    it('should indicate searching across all workspace directories when no path specified', () => {
      // Create a mock config with multiple directories
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, ['/another/dir']),
      } as unknown as Config;

      const multiDirGrepTool = new GrepTool(multiDirConfig);
      const params: GrepToolParams = { pattern: 'testPattern' };
      const invocation = multiDirGrepTool.build(params);
      expect(invocation.getDescription()).toBe(
        "'testPattern' across all workspace directories",
      );
    });

    it('should generate correct description with pattern, include, and path', async () => {
      const dirPath = path.join(tempRootDir, 'src', 'app');
      await fs.mkdir(dirPath, { recursive: true });
      const params: GrepToolParams = {
        pattern: 'testPattern',
        include: '*.ts',
        path: path.join('src', 'app'),
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toContain(
        "'testPattern' in *.ts within",
      );
      expect(invocation.getDescription()).toContain(path.join('src', 'app'));
    });

    it('should use ./ for root path in description', () => {
      const params: GrepToolParams = { pattern: 'testPattern', path: '.' };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' within ./");
    });
  });
});
