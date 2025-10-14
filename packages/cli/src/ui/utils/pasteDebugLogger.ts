/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find project root (assuming packages/cli/src/ui/utils structure)
const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const LOG_FILE = path.join(PROJECT_ROOT, 'paste-debug.log');

// Check if paste debugging is enabled
const PASTE_DEBUG_ENABLED =
  process.env['PASTE_DEBUG'] === '1' || process.env['PASTE_DEBUG'] === 'true';

let eventCounter = 0;
let logStream: fs.WriteStream | null = null;

/**
 * Initialize the log file
 */
function initLogFile(): void {
  if (!PASTE_DEBUG_ENABLED || logStream) return;

  try {
    // Create or truncate the log file
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const startMsg =
      `\n${'='.repeat(80)}\n` +
      `Paste Debug Session Started: ${new Date().toISOString()}\n` +
      `Platform: ${process.platform}\n` +
      `Node: ${process.version}\n` +
      `${'='.repeat(80)}\n`;
    logStream.write(startMsg);
  } catch (error) {
    console.error('Failed to initialize paste debug log:', error);
  }
}

/**
 * Format a timestamp with milliseconds
 */
function getTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Escape special characters for logging
 */
function escapeForLog(str: string): string {
  return (
    str
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b/g, '\\x1b')
  );
}

/**
 * Count newline types in a string
 */
function countNewlines(str: string): { crlf: number; lf: number; cr: number } {
  const crlf = (str.match(/\r\n/g) || []).length;
  const cr = (str.match(/\r/g) || []).length - crlf; // exclude CRLFs
  const lf = (str.match(/\n/g) || []).length - crlf; // exclude CRLFs
  return { crlf, lf, cr };
}

/**
 * Write a log entry
 */
function writeLog(
  type: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!PASTE_DEBUG_ENABLED) return;

  if (!logStream) {
    initLogFile();
  }

  if (!logStream) return;

  const timestamp = getTimestamp();
  let logLine = `[${timestamp}] [${type}] ${message}`;

  if (data) {
    const dataStr = Object.entries(data)
      .map(([key, value]) => {
        if (typeof value === 'string') {
          return `${key}="${escapeForLog(value)}"`;
        }
        return `${key}=${JSON.stringify(value)}`;
      })
      .join(', ');
    logLine += ` | ${dataStr}`;
  }

  logLine += '\n';
  logStream.write(logLine);
}

/**
 * Log paste start event
 */
export function logPasteStart(trusted: boolean, kittyProtocol: boolean): void {
  eventCounter = 0; // Reset counter for new paste
  writeLog('PASTE-START', 'Paste operation started', {
    trusted,
    kittyProtocol,
    platform: process.platform,
  });
}

/**
 * Log paste end event
 */
export function logPasteEnd(totalContent: string, lineCount: number): void {
  const newlines = countNewlines(totalContent);
  writeLog('PASTE-END', 'Paste operation completed', {
    totalChars: totalContent.length,
    lines: lineCount,
    crlf: newlines.crlf,
    lf: newlines.lf,
    cr: newlines.cr,
    preview: escapeForLog(totalContent.slice(0, 100)),
  });
}

/**
 * Log keypress event
 */
export function logKeypress(
  sequence: string,
  isPaste: boolean,
  name: string,
  ctrl: boolean,
  meta: boolean,
): void {
  eventCounter++;
  const newlines = countNewlines(sequence);
  writeLog('KEYPRESS', `Event #${eventCounter}`, {
    sequence: escapeForLog(sequence),
    length: sequence.length,
    paste: isPaste,
    name: name || '(empty)',
    ctrl,
    meta,
    crlf: newlines.crlf,
    lf: newlines.lf,
    cr: newlines.cr,
  });
}

/**
 * Log buffer insert operation
 */
export function logBufferInsert(
  beforeLength: number,
  afterLength: number,
  insertedContent: string,
  isPaste: boolean,
): void {
  const newlines = countNewlines(insertedContent);
  writeLog('BUFFER-INSERT', 'Text buffer insert', {
    beforeChars: beforeLength,
    afterChars: afterLength,
    insertedChars: insertedContent.length,
    paste: isPaste,
    crlf: newlines.crlf,
    lf: newlines.lf,
    cr: newlines.cr,
    preview: escapeForLog(insertedContent.slice(0, 50)),
  });
}

/**
 * Log buffer state
 */
export function logBufferState(
  text: string,
  cursorRow: number,
  cursorCol: number,
): void {
  writeLog('BUFFER-STATE', 'Current buffer state', {
    totalChars: text.length,
    lines: text.split('\n').length,
    cursorRow,
    cursorCol,
  });
}

/**
 * Log paste protection triggered
 */
export function logPasteProtection(
  reason: string,
  timeSincePaste?: number,
): void {
  writeLog('PASTE-PROTECT', 'Paste protection triggered', {
    reason,
    timeSincePaste,
  });
}

/**
 * Log newline normalization
 */
export function logNewlineNormalization(before: string, after: string): void {
  const beforeNewlines = countNewlines(before);
  const afterNewlines = countNewlines(after);
  writeLog('NORMALIZE', 'Newline normalization', {
    beforeCRLF: beforeNewlines.crlf,
    beforeLF: beforeNewlines.lf,
    beforeCR: beforeNewlines.cr,
    afterCRLF: afterNewlines.crlf,
    afterLF: afterNewlines.lf,
    afterCR: afterNewlines.cr,
    changed: before !== after,
  });
}

/**
 * Log paste buffer accumulation
 */
export function logPasteBufferAccumulation(
  currentBufferSize: number,
  addedContent: string,
): void {
  writeLog('PASTE-BUFFER', 'Paste buffer accumulation', {
    currentSize: currentBufferSize,
    addedSize: addedContent.length,
    addedPreview: escapeForLog(addedContent.slice(0, 30)),
  });
}

/**
 * Log drag and drop detection
 */
export function logDragDrop(
  isDragging: boolean,
  bufferContent: string,
  timeout: number,
): void {
  writeLog('DRAG-DROP', 'Drag and drop state', {
    isDragging,
    bufferSize: bufferContent.length,
    timeout,
    preview: escapeForLog(bufferContent.slice(0, 50)),
  });
}

/**
 * Log unsafe paste time window
 */
export function logUnsafePasteWindow(timeSet: number, windowMs: number): void {
  writeLog('UNSAFE-PASTE', 'Unsafe paste protection window set', {
    timestamp: timeSet,
    windowMs,
  });
}

/**
 * Log general message
 */
export function logGeneral(
  message: string,
  data?: Record<string, unknown>,
): void {
  writeLog('GENERAL', message, data);
}

/**
 * Cleanup log stream on exit
 */
if (PASTE_DEBUG_ENABLED) {
  const cleanup = () => {
    if (logStream) {
      logStream.end();
      logStream = null;
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
