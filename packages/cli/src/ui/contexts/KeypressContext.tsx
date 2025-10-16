/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@google/gemini-cli-core';
import {
  KittySequenceOverflowEvent,
  logKittySequenceOverflow,
} from '@google/gemini-cli-core';
import { useStdin } from 'ink';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BACKSLASH_ENTER_DETECTION_WINDOW_MS,
  CHAR_CODE_ESC,
  KITTY_CTRL_C,
  KITTY_KEYCODE_BACKSPACE,
  KITTY_KEYCODE_ENTER,
  KITTY_KEYCODE_NUMPAD_ENTER,
  KITTY_KEYCODE_TAB,
  MAX_KITTY_SEQUENCE_LENGTH,
  KITTY_MODIFIER_BASE,
  KITTY_MODIFIER_EVENT_TYPES_OFFSET,
  MODIFIER_SHIFT_BIT,
  MODIFIER_ALT_BIT,
  MODIFIER_CTRL_BIT,
} from '../utils/platformConstants.js';

import { FOCUS_IN, FOCUS_OUT } from '../hooks/useFocus.js';

const ESC = '\u001B';
export const PASTE_MODE_PREFIX = `${ESC}[200~`;
export const PASTE_MODE_SUFFIX = `${ESC}[201~`;

// Windows paste debugging
const isWindows = os.platform() === 'win32';
let pasteDebugStream: fs.WriteStream | null = null;
let pasteDebugEnabled = false;

function initPasteDebugLog() {
  if (
    !pasteDebugEnabled &&
    (isWindows || process.env['PASTE_DEBUG'] === 'true')
  ) {
    const logPath = path.join(process.cwd(), 'gemini-paste-debug.log');
    pasteDebugStream = fs.createWriteStream(logPath, { flags: 'a' });
    pasteDebugStream.write(
      `\n\n=== New session started at ${new Date().toISOString()} ===\n`,
    );
    pasteDebugStream.write(
      `Platform: ${os.platform()}, Node: ${process.version}\n`,
    );
    pasteDebugStream.write(
      `PASTE_WORKAROUND: ${process.env['PASTE_WORKAROUND'] || 'not set'}\n`,
    );
    pasteDebugStream.write(
      `Terminal: ${process.env['TERM_PROGRAM'] || 'unknown'}\n`,
    );
    pasteDebugStream.write(`TTY: ${process.stdin.isTTY ? 'yes' : 'no'}\n\n`);
    pasteDebugEnabled = true;
  }
}

function logPasteDebug(message: string, data?: unknown) {
  if (pasteDebugStream) {
    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] ${message}`;
    if (data !== undefined) {
      if (Buffer.isBuffer(data)) {
        const str = data.toString();
        const preview = str.length > 50 ? str.substring(0, 50) + '...' : str;
        logMessage += ` | Buffer(${data.length}): ${JSON.stringify(preview)} | Hex(first 20): ${data.toString('hex').substring(0, 40)}`;
      } else if (typeof data === 'string') {
        const preview = data.length > 50 ? data.substring(0, 50) + '...' : data;
        logMessage += ` | String(${data.length}): ${JSON.stringify(preview)}`;
      } else {
        logMessage += ` | Data: ${JSON.stringify(data)}`;
      }
    }
    pasteDebugStream.write(logMessage + '\n');
  }
}
export const DRAG_COMPLETION_TIMEOUT_MS = 100; // Broadcast full path after 100ms if no more input
export const SINGLE_QUOTE = "'";
export const DOUBLE_QUOTE = '"';

const ALT_KEY_CHARACTER_MAP: Record<string, string> = {
  '\u00E5': 'a',
  '\u222B': 'b',
  '\u00E7': 'c',
  '\u2202': 'd',
  '\u00B4': 'e',
  '\u0192': 'f',
  '\u00A9': 'g',
  '\u02D9': 'h',
  '\u02C6': 'i',
  '\u2206': 'j',
  '\u02DA': 'k',
  '\u00AC': 'l',
  '\u00B5': 'm',
  '\u02DC': 'n',
  '\u00F8': 'o',
  '\u03C0': 'p',
  '\u0153': 'q',
  '\u00AE': 'r',
  '\u00DF': 's',
  '\u2020': 't',
  '\u00A8': 'u',
  '\u221A': 'v',
  '\u2211': 'w',
  '\u2248': 'x',
  '\u00A5': 'y',
  '\u03A9': 'z',
};

export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  paste: boolean;
  sequence: string;
  kittyProtocol?: boolean;
}

export type KeypressHandler = (key: Key) => void;

interface KeypressContextValue {
  subscribe: (handler: KeypressHandler) => void;
  unsubscribe: (handler: KeypressHandler) => void;
}

const KeypressContext = createContext<KeypressContextValue | undefined>(
  undefined,
);

export function useKeypressContext() {
  const context = useContext(KeypressContext);
  if (!context) {
    throw new Error(
      'useKeypressContext must be used within a KeypressProvider',
    );
  }
  return context;
}

export function KeypressProvider({
  children,
  kittyProtocolEnabled,
  config,
  debugKeystrokeLogging,
}: {
  children: React.ReactNode;
  kittyProtocolEnabled: boolean;
  config?: Config;
  debugKeystrokeLogging?: boolean;
}) {
  const { stdin, setRawMode } = useStdin();
  const subscribers = useRef<Set<KeypressHandler>>(new Set()).current;
  const isDraggingRef = useRef(false);
  const dragBufferRef = useRef('');
  const draggingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize paste debug logging
  initPasteDebugLog();

  const subscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.add(handler);
    },
    [subscribers],
  );

  const unsubscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.delete(handler);
    },
    [subscribers],
  );

  useEffect(() => {
    const clearDraggingTimer = () => {
      if (draggingTimerRef.current) {
        clearTimeout(draggingTimerRef.current);
        draggingTimerRef.current = null;
      }
    };

    const wasRaw = stdin.isRaw;
    if (wasRaw === false) {
      setRawMode(true);
    }

    // Windows-specific: Ensure stdin is properly configured
    if (isWindows && stdin.isTTY) {
      // Disable echo on Windows to prevent paste data from appearing in terminal
      logPasteDebug(`Windows TTY detected, ensuring raw mode is set`);
      try {
        stdin.setRawMode?.(true);
        // On Windows, we need to ensure echo is disabled
        if (process.stdout.isTTY) {
          // Disable echo and line editing
          process.stdout.write('\x1b[?25l'); // Hide cursor
          process.stdout.write('\x1b[?7l'); // Disable line wrap
          process.stdout.write('\x1b[?25h'); // Show cursor
        }
      } catch (e) {
        logPasteDebug(`Failed to set raw mode on Windows: ${e}`);
      }
    }

    const keypressStream = new PassThrough();
    let usePassthrough = false;
    const nodeMajorVersion = parseInt(process.versions.node.split('.')[0], 10);
    if (
      nodeMajorVersion < 20 ||
      process.env['PASTE_WORKAROUND'] === '1' ||
      process.env['PASTE_WORKAROUND'] === 'true'
    ) {
      usePassthrough = true;
    }

    let isPaste = false;
    let pasteBuffer = Buffer.alloc(0);
    let kittySequenceBuffer = '';
    let backslashTimeout: NodeJS.Timeout | null = null;
    let waitingForEnterAfterBackslash = false;

    // Buffer for handling partial paste markers (Windows fix)
    let partialDataBuffer = Buffer.alloc(0);
    let lastDataTimestamp = Date.now();

    // Windows paste detection without bracketed paste markers
    let windowsPasteBuffer = '';
    let windowsPasteTimer: NodeJS.Timeout | null = null;
    let lastWindowsInputTime = Date.now();
    const WINDOWS_PASTE_TIMEOUT = 50; // ms to wait for more input

    // Parse a single complete kitty sequence from the start (prefix) of the
    // buffer and return both the Key and the number of characters consumed.
    // This lets us "peel off" one complete event when multiple sequences arrive
    // in a single chunk, preventing buffer overflow and fragmentation.
    // Parse a single complete kitty/parameterized/legacy sequence from the start
    // of the buffer and return both the parsed Key and the number of characters
    // consumed. This enables peel-and-continue parsing for batched input.
    const parseKittyPrefix = (
      buffer: string,
    ): { key: Key; length: number } | null => {
      // In older terminals ESC [ Z was used as Cursor Backward Tabulation (CBT)
      // In newer terminals the same functionality of key combination for moving
      // backward through focusable elements is Shift+Tab, hence we will
      // map ESC [ Z to Shift+Tab
      // 0) Reverse Tab (legacy): ESC [ Z
      //    Treat as Shift+Tab for UI purposes.
      //    Regex parts:
      //    ^     - start of buffer
      //    ESC [ - CSI introducer
      //    Z     - legacy reverse tab
      const revTabLegacy = new RegExp(`^${ESC}\\[Z`);
      let m = buffer.match(revTabLegacy);
      if (m) {
        return {
          key: {
            name: 'tab',
            ctrl: false,
            meta: false,
            shift: true,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true,
          },
          length: m[0].length,
        };
      }

      // 1) Reverse Tab (parameterized): ESC [ 1 ; <mods> Z
      //    Parameterized reverse Tab: ESC [ 1 ; <mods> Z
      const revTabParam = new RegExp(`^${ESC}\\[1;(\\d+)Z`);
      m = buffer.match(revTabParam);
      if (m) {
        let mods = parseInt(m[1], 10);
        if (mods >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          mods -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const bits = mods - KITTY_MODIFIER_BASE;
        const alt = (bits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT;
        const ctrl = (bits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        return {
          key: {
            name: 'tab',
            ctrl,
            meta: alt,
            // Reverse tab implies Shift behavior; force shift regardless of mods
            shift: true,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true,
          },
          length: m[0].length,
        };
      }

      // 2) Parameterized functional: ESC [ 1 ; <mods> (A|B|C|D|H|F|P|Q|R|S)
      // 2) Parameterized functional: ESC [ 1 ; <mods> (A|B|C|D|H|F|P|Q|R|S)
      //    Arrows, Home/End, F1–F4 with modifiers encoded in <mods>.
      const arrowPrefix = new RegExp(`^${ESC}\\[1;(\\d+)([ABCDHFPQSR])`);
      m = buffer.match(arrowPrefix);
      if (m) {
        let mods = parseInt(m[1], 10);
        if (mods >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          mods -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const bits = mods - KITTY_MODIFIER_BASE;
        const shift = (bits & MODIFIER_SHIFT_BIT) === MODIFIER_SHIFT_BIT;
        const alt = (bits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT;
        const ctrl = (bits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        const sym = m[2];
        const symbolToName: { [k: string]: string } = {
          A: 'up',
          B: 'down',
          C: 'right',
          D: 'left',
          H: 'home',
          F: 'end',
          P: 'f1',
          Q: 'f2',
          R: 'f3',
          S: 'f4',
        };
        const name = symbolToName[sym] || '';
        if (!name) return null;
        return {
          key: {
            name,
            ctrl,
            meta: alt,
            shift,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true,
          },
          length: m[0].length,
        };
      }

      // 3) CSI-u form: ESC [ <code> ; <mods> (u|~)
      // 3) CSI-u and tilde-coded functional keys: ESC [ <code> ; <mods> (u|~)
      //    'u' terminator: Kitty CSI-u; '~' terminator: tilde-coded function keys.
      const csiUPrefix = new RegExp(`^${ESC}\\[(\\d+)(;(\\d+))?([u~])`);
      m = buffer.match(csiUPrefix);
      if (m) {
        const keyCode = parseInt(m[1], 10);
        let modifiers = m[3] ? parseInt(m[3], 10) : KITTY_MODIFIER_BASE;
        if (modifiers >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          modifiers -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const modifierBits = modifiers - KITTY_MODIFIER_BASE;
        const shift =
          (modifierBits & MODIFIER_SHIFT_BIT) === MODIFIER_SHIFT_BIT;
        const alt = (modifierBits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT;
        const ctrl = (modifierBits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        const terminator = m[4];

        // Tilde-coded functional keys (Delete, Insert, PageUp/Down, Home/End)
        if (terminator === '~') {
          let name: string | null = null;
          switch (keyCode) {
            case 1:
              name = 'home';
              break;
            case 2:
              name = 'insert';
              break;
            case 3:
              name = 'delete';
              break;
            case 4:
              name = 'end';
              break;
            case 5:
              name = 'pageup';
              break;
            case 6:
              name = 'pagedown';
              break;
            default:
              break;
          }
          if (name) {
            return {
              key: {
                name,
                ctrl,
                meta: alt,
                shift,
                paste: false,
                sequence: buffer.slice(0, m[0].length),
                kittyProtocol: true,
              },
              length: m[0].length,
            };
          }
        }

        const kittyKeyCodeToName: { [key: number]: string } = {
          [CHAR_CODE_ESC]: 'escape',
          [KITTY_KEYCODE_TAB]: 'tab',
          [KITTY_KEYCODE_BACKSPACE]: 'backspace',
          [KITTY_KEYCODE_ENTER]: 'return',
          [KITTY_KEYCODE_NUMPAD_ENTER]: 'return',
        };

        const name = kittyKeyCodeToName[keyCode];
        if (name) {
          return {
            key: {
              name,
              ctrl,
              meta: alt,
              shift,
              paste: false,
              sequence: buffer.slice(0, m[0].length),
              kittyProtocol: true,
            },
            length: m[0].length,
          };
        }

        // Ctrl+letters and Alt+letters
        if (
          (ctrl || alt) &&
          keyCode >= 'a'.charCodeAt(0) &&
          keyCode <= 'z'.charCodeAt(0)
        ) {
          const letter = String.fromCharCode(keyCode);
          return {
            key: {
              name: letter,
              ctrl,
              meta: alt,
              shift,
              paste: false,
              sequence: buffer.slice(0, m[0].length),
              kittyProtocol: true,
            },
            length: m[0].length,
          };
        }
      }

      // 4) Legacy function keys (no parameters): ESC [ (A|B|C|D|H|F)
      //    Arrows + Home/End without modifiers.
      const legacyFuncKey = new RegExp(`^${ESC}\\[([ABCDHF])`);
      m = buffer.match(legacyFuncKey);
      if (m) {
        const sym = m[1];
        const nameMap: { [key: string]: string } = {
          A: 'up',
          B: 'down',
          C: 'right',
          D: 'left',
          H: 'home',
          F: 'end',
        };
        const name = nameMap[sym]!;
        return {
          key: {
            name,
            ctrl: false,
            meta: false,
            shift: false,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true,
          },
          length: m[0].length,
        };
      }

      return null;
    };

    const broadcast = (key: Key) => {
      for (const handler of subscribers) {
        handler(key);
      }
    };

    const handleKeypress = (_: unknown, key: Key) => {
      if (key.sequence === FOCUS_IN || key.sequence === FOCUS_OUT) {
        return;
      }
      if (key.name === 'paste-start') {
        logPasteDebug('handleKeypress: paste-start event received');
        isPaste = true;
        return;
      }
      if (key.name === 'paste-end') {
        logPasteDebug('handleKeypress: paste-end event received');
        isPaste = false;
        const pasteContent = pasteBuffer.toString();
        logPasteDebug(
          `Broadcasting paste content, length: ${pasteContent.length}`,
          pasteContent,
        );
        broadcast({
          name: '',
          ctrl: false,
          meta: false,
          shift: false,
          paste: true,
          sequence: pasteContent,
        });
        pasteBuffer = Buffer.alloc(0);
        return;
      }

      if (isPaste) {
        logPasteDebug('handleKeypress: accumulating paste data', key.sequence);
        pasteBuffer = Buffer.concat([pasteBuffer, Buffer.from(key.sequence)]);
        return;
      }

      if (
        key.sequence === SINGLE_QUOTE ||
        key.sequence === DOUBLE_QUOTE ||
        isDraggingRef.current
      ) {
        isDraggingRef.current = true;
        dragBufferRef.current += key.sequence;

        clearDraggingTimer();
        draggingTimerRef.current = setTimeout(() => {
          isDraggingRef.current = false;
          const seq = dragBufferRef.current;
          dragBufferRef.current = '';
          if (seq) {
            broadcast({ ...key, name: '', paste: true, sequence: seq });
          }
        }, DRAG_COMPLETION_TIMEOUT_MS);

        return;
      }

      const mappedLetter = ALT_KEY_CHARACTER_MAP[key.sequence];
      if (mappedLetter && !key.meta) {
        broadcast({
          name: mappedLetter,
          ctrl: false,
          meta: true,
          shift: false,
          paste: isPaste,
          sequence: key.sequence,
        });
        return;
      }

      if (key.name === 'return' && waitingForEnterAfterBackslash) {
        if (backslashTimeout) {
          clearTimeout(backslashTimeout);
          backslashTimeout = null;
        }
        waitingForEnterAfterBackslash = false;
        broadcast({
          ...key,
          shift: true,
          sequence: '\r', // Corrected escaping for newline
        });
        return;
      }

      if (key.sequence === '\\' && !key.name) {
        // Corrected escaping for backslash
        waitingForEnterAfterBackslash = true;
        backslashTimeout = setTimeout(() => {
          waitingForEnterAfterBackslash = false;
          backslashTimeout = null;
          broadcast(key);
        }, BACKSLASH_ENTER_DETECTION_WINDOW_MS);
        return;
      }

      if (waitingForEnterAfterBackslash && key.name !== 'return') {
        if (backslashTimeout) {
          clearTimeout(backslashTimeout);
          backslashTimeout = null;
        }
        waitingForEnterAfterBackslash = false;
        broadcast({
          name: '',
          sequence: '\\',
          ctrl: false,
          meta: false,
          shift: false,
          paste: false,
        });
      }

      if (['up', 'down', 'left', 'right'].includes(key.name)) {
        broadcast(key);
        return;
      }

      if (
        (key.ctrl && key.name === 'c') ||
        key.sequence === `${ESC}${KITTY_CTRL_C}`
      ) {
        if (kittySequenceBuffer && debugKeystrokeLogging) {
          console.log(
            '[DEBUG] Kitty buffer cleared on Ctrl+C:',
            kittySequenceBuffer,
          );
        }
        kittySequenceBuffer = '';
        if (key.sequence === `${ESC}${KITTY_CTRL_C}`) {
          broadcast({
            name: 'c',
            ctrl: true,
            meta: false,
            shift: false,
            paste: false,
            sequence: key.sequence,
            kittyProtocol: true,
          });
        } else {
          broadcast(key);
        }
        return;
      }

      if (kittyProtocolEnabled) {
        if (
          kittySequenceBuffer ||
          (key.sequence.startsWith(`${ESC}[`) &&
            !key.sequence.startsWith(PASTE_MODE_PREFIX) &&
            !key.sequence.startsWith(PASTE_MODE_SUFFIX) &&
            !key.sequence.startsWith(FOCUS_IN) &&
            !key.sequence.startsWith(FOCUS_OUT))
        ) {
          kittySequenceBuffer += key.sequence;

          if (debugKeystrokeLogging) {
            console.log(
              '[DEBUG] Kitty buffer accumulating:',
              kittySequenceBuffer,
            );
          }

          // Try to peel off as many complete sequences as are available at the
          // start of the buffer. This handles batched inputs cleanly. If the
          // prefix is incomplete or invalid, skip to the next CSI introducer
          // (ESC[) so that a following valid sequence can still be parsed.
          let parsedAny = false;
          while (kittySequenceBuffer) {
            const parsed = parseKittyPrefix(kittySequenceBuffer);
            if (!parsed) {
              // Look for the next potential CSI start beyond index 0
              const nextStart = kittySequenceBuffer.indexOf(`${ESC}[`, 1);
              if (nextStart > 0) {
                if (debugKeystrokeLogging) {
                  console.log(
                    '[DEBUG] Skipping incomplete/invalid CSI prefix:',
                    kittySequenceBuffer.slice(0, nextStart),
                  );
                }
                kittySequenceBuffer = kittySequenceBuffer.slice(nextStart);
                continue;
              }
              break;
            }
            if (debugKeystrokeLogging) {
              const parsedSequence = kittySequenceBuffer.slice(
                0,
                parsed.length,
              );
              if (kittySequenceBuffer.length > parsed.length) {
                console.log(
                  '[DEBUG] Kitty sequence parsed successfully (prefix):',
                  parsedSequence,
                );
              } else {
                console.log(
                  '[DEBUG] Kitty sequence parsed successfully:',
                  parsedSequence,
                );
              }
            }
            // Consume the parsed prefix and broadcast it.
            kittySequenceBuffer = kittySequenceBuffer.slice(parsed.length);
            broadcast(parsed.key);
            parsedAny = true;
          }
          if (parsedAny) return;

          if (config?.getDebugMode() || debugKeystrokeLogging) {
            const codes = Array.from(kittySequenceBuffer).map((ch) =>
              ch.charCodeAt(0),
            );
            console.warn('Kitty sequence buffer has char codes:', codes);
          }

          if (kittySequenceBuffer.length > MAX_KITTY_SEQUENCE_LENGTH) {
            if (debugKeystrokeLogging) {
              console.log(
                '[DEBUG] Kitty buffer overflow, clearing:',
                kittySequenceBuffer,
              );
            }
            if (config) {
              const event = new KittySequenceOverflowEvent(
                kittySequenceBuffer.length,
                kittySequenceBuffer,
              );
              logKittySequenceOverflow(config, event);
            }
            kittySequenceBuffer = '';
          } else {
            return;
          }
        }
      }

      if (key.name === 'return' && key.sequence === `${ESC}\r`) {
        key.meta = true;
      }
      broadcast({ ...key, paste: isPaste });
    };

    const handleRawKeypress = (data: Buffer) => {
      const currentTime = Date.now();
      const timeSinceLastData = currentTime - lastDataTimestamp;
      lastDataTimestamp = currentTime;

      logPasteDebug(
        `handleRawKeypress called, timeSinceLastData: ${timeSinceLastData}ms`,
        data,
      );

      // Windows paste detection without bracketed paste markers
      if (isWindows && !isPaste && usePassthrough) {
        const dataStr = data.toString();
        const timeSinceLastWindowsInput = currentTime - lastWindowsInputTime;

        // Check if this is a special key sequence (arrow keys, function keys, etc.)
        // These typically start with ESC and are short, or are control characters
        const isSpecialKey =
          (dataStr.startsWith(ESC) && dataStr.length <= 10) || // Increased to 10 for longer sequences
          dataStr === '\x03' || // Ctrl+C
          dataStr === '\x1a' || // Ctrl+Z
          dataStr === '\x04' || // Ctrl+D
          dataStr === '\t' || // Tab
          (dataStr === '\r' && dataStr.length === 1) || // Single Enter
          (dataStr === '\n' && dataStr.length === 1) || // Single Newline
          // Arrow keys in various formats
          dataStr === `${ESC}[A` || // Up
          dataStr === `${ESC}[B` || // Down
          dataStr === `${ESC}[C` || // Right
          dataStr === `${ESC}[D` || // Left
          dataStr === `${ESC}[H` || // Home
          dataStr === `${ESC}[F` || // End
          // Arrow keys with modifiers (e.g., ESC[1;5A for Ctrl+Up)
          // eslint-disable-next-line no-control-regex
          /^\x1b\[1;\d+[ABCDHF]/.test(dataStr) ||
          // Function keys
          // eslint-disable-next-line no-control-regex
          /^\x1b\[\d+~/.test(dataStr) ||
          // Other navigation keys
          dataStr === `${ESC}[2~` || // Insert
          dataStr === `${ESC}[3~` || // Delete
          dataStr === `${ESC}[5~` || // PageUp
          dataStr === `${ESC}[6~`; // PageDown

        // Skip paste detection for special keys
        if (isSpecialKey) {
          logPasteDebug(
            `Skipping paste detection for special key sequence`,
            data,
          );

          // If we have a paste buffer, flush it immediately before processing the special key
          if (windowsPasteTimer) {
            clearTimeout(windowsPasteTimer);
            if (windowsPasteBuffer.length > 0) {
              logPasteDebug(
                `Special key detected, flushing Windows paste buffer`,
              );
              broadcast({
                name: '',
                ctrl: false,
                meta: false,
                shift: false,
                paste: true,
                sequence: windowsPasteBuffer,
              });
            }
            windowsPasteBuffer = '';
            windowsPasteTimer = null;
          }

          // Also flush any partial buffer before processing special key
          if (partialDataBuffer.length > 0) {
            logPasteDebug(
              'Flushing partial buffer before special key',
              partialDataBuffer,
            );
            keypressStream.write(partialDataBuffer);
            partialDataBuffer = Buffer.alloc(0);
          }

          // Write special key directly to keypressStream and return immediately
          logPasteDebug('Writing special key directly to keypressStream', data);
          keypressStream.write(data);
          return; // Bypass all further processing including partial buffer logic
        } else {
          // Check if this looks like paste (rapid multi-character input)
          // Lower threshold for initial detection to catch paste start
          const looksLikePaste =
            dataStr.length > 3 ||
            (windowsPasteBuffer && timeSinceLastWindowsInput < 200) ||
            (dataStr.includes('\r') && dataStr.length > 10);

          if (looksLikePaste) {
            logPasteDebug(
              `Windows paste detection: buffering rapid input (${dataStr.length} chars, ${timeSinceLastWindowsInput}ms since last)`,
            );

            // Clear any existing timer
            if (windowsPasteTimer) {
              clearTimeout(windowsPasteTimer);
            }

            // Add to buffer
            windowsPasteBuffer += dataStr;
            lastWindowsInputTime = currentTime;

            // Set timer to flush buffer as paste
            windowsPasteTimer = setTimeout(() => {
              if (windowsPasteBuffer.length > 0) {
                logPasteDebug(
                  `Windows paste detected! Flushing buffer as paste (${windowsPasteBuffer.length} chars)`,
                );

                // Directly broadcast the entire paste content
                logPasteDebug(`Directly broadcasting Windows paste content`);
                broadcast({
                  name: '',
                  ctrl: false,
                  meta: false,
                  shift: false,
                  paste: true,
                  sequence: windowsPasteBuffer,
                });

                windowsPasteBuffer = '';
                windowsPasteTimer = null;
              }
            }, WINDOWS_PASTE_TIMEOUT);

            // Don't process this data normally - it's being buffered
            return;
          } else if (windowsPasteTimer) {
            // If we have a paste timer running but this doesn't look like paste,
            // it might be the user typing after a paste - flush the buffer
            logPasteDebug(
              'Single char input during paste detection, flushing buffer early',
            );
            clearTimeout(windowsPasteTimer);

            if (windowsPasteBuffer.length > 0) {
              // Directly broadcast the buffered paste content
              logPasteDebug(`Early flush: broadcasting Windows paste content`);
              broadcast({
                name: '',
                ctrl: false,
                meta: false,
                shift: false,
                paste: true,
                sequence: windowsPasteBuffer,
              });
            }

            windowsPasteBuffer = '';
            windowsPasteTimer = null;
            lastWindowsInputTime = currentTime;

            // Continue processing this single character normally
          }
        }
      }

      // On Windows, combine with any partial data from previous chunk
      // This handles cases where paste markers are split across chunks
      let fullData = data;
      if (partialDataBuffer.length > 0) {
        logPasteDebug('Combining with partial buffer', partialDataBuffer);
        fullData = Buffer.concat([partialDataBuffer, data]);
        partialDataBuffer = Buffer.alloc(0);
      }

      const pasteModePrefixBuffer = Buffer.from(PASTE_MODE_PREFIX);
      const pasteModeSuffixBuffer = Buffer.from(PASTE_MODE_SUFFIX);

      let pos = 0;
      while (pos < fullData.length) {
        const prefixPos = fullData.indexOf(pasteModePrefixBuffer, pos);
        const suffixPos = fullData.indexOf(pasteModeSuffixBuffer, pos);

        logPasteDebug(
          `Searching from pos ${pos}: prefixPos=${prefixPos}, suffixPos=${suffixPos}`,
        );

        const isPrefixNext =
          prefixPos !== -1 && (suffixPos === -1 || prefixPos < suffixPos);
        const isSuffixNext =
          suffixPos !== -1 && (prefixPos === -1 || suffixPos < prefixPos);

        let nextMarkerPos = -1;
        let markerLength = 0;

        if (isPrefixNext) {
          nextMarkerPos = prefixPos;
          markerLength = pasteModePrefixBuffer.length;
        } else if (isSuffixNext) {
          nextMarkerPos = suffixPos;
          markerLength = pasteModeSuffixBuffer.length;
        }

        if (nextMarkerPos === -1) {
          // No markers found in remaining data
          const remainingData = fullData.slice(pos);

          // On Windows, check if we might have a partial marker at the end
          if (isWindows) {
            // Windows often sends data in smaller chunks, be more aggressive about buffering
            const remainingStr = remainingData.toString();

            // First check if this is a complete special key sequence - don't buffer it
            const isCompleteSpecialKey =
              remainingStr === `${ESC}[A` || // Up
              remainingStr === `${ESC}[B` || // Down
              remainingStr === `${ESC}[C` || // Right
              remainingStr === `${ESC}[D` || // Left
              remainingStr === `${ESC}[H` || // Home
              remainingStr === `${ESC}[F` || // End
              // eslint-disable-next-line no-control-regex
              /^\x1b\[1;\d+[ABCDHF]$/.test(remainingStr) || // Arrow keys with modifiers
              // eslint-disable-next-line no-control-regex
              /^\x1b\[\d+~$/.test(remainingStr); // Function keys

            if (isCompleteSpecialKey) {
              logPasteDebug(
                'Complete special key detected, not buffering',
                remainingData,
              );
              // Don't buffer, let it pass through
            } else if (
              remainingData.length < 10 &&
              (remainingStr.includes(ESC) ||
                remainingStr.endsWith(ESC) ||
                remainingStr.endsWith(`${ESC}[`) ||
                remainingStr.endsWith(`${ESC}[2`) ||
                remainingStr.endsWith(`${ESC}[20`) ||
                remainingStr.endsWith(`${ESC}[200`))
            ) {
              logPasteDebug(
                'Saving potential partial marker for next chunk',
                remainingData,
              );
              partialDataBuffer = remainingData;
              return;
            }

            // Also check if we're in the middle of receiving paste data and hit a chunk boundary
            if (isPaste && timeSinceLastData < 50) {
              // If we're currently in paste mode and data is coming quickly,
              // wait a bit for more data to avoid truncation
              logPasteDebug(
                'In paste mode, buffering data to avoid truncation',
                remainingData,
              );
              partialDataBuffer = remainingData;
              return;
            }
          }

          logPasteDebug(
            'Writing remaining data to keypressStream',
            remainingData,
          );
          keypressStream.write(remainingData);
          return;
        }

        // Write data before the marker
        const nextData = fullData.slice(pos, nextMarkerPos);
        if (nextData.length > 0) {
          logPasteDebug(
            `Writing data before marker (${isPrefixNext ? 'prefix' : 'suffix'})`,
            nextData,
          );
          keypressStream.write(nextData);
        }

        const createPasteKeyEvent = (
          name: 'paste-start' | 'paste-end',
        ): Key => ({
          name,
          ctrl: false,
          meta: false,
          shift: false,
          paste: false,
          sequence: '',
        });

        if (isPrefixNext) {
          logPasteDebug(
            'Found paste-start marker, triggering paste-start event',
          );
          handleKeypress(undefined, createPasteKeyEvent('paste-start'));
        } else if (isSuffixNext) {
          logPasteDebug('Found paste-end marker, triggering paste-end event');
          handleKeypress(undefined, createPasteKeyEvent('paste-end'));
        }

        pos = nextMarkerPos + markerLength;
      }
    };

    let rl: readline.Interface;
    if (usePassthrough) {
      logPasteDebug(
        `Using passthrough mode (Node ${process.versions.node}, PASTE_WORKAROUND=${process.env['PASTE_WORKAROUND']})`,
      );
      rl = readline.createInterface({
        input: keypressStream,
        escapeCodeTimeout: 0,
      });
      readline.emitKeypressEvents(keypressStream, rl);
      keypressStream.on('keypress', handleKeypress);
      stdin.on('data', handleRawKeypress);
    } else {
      logPasteDebug('Using direct stdin mode');
      rl = readline.createInterface({ input: stdin, escapeCodeTimeout: 0 });
      readline.emitKeypressEvents(stdin, rl);
      stdin.on('keypress', handleKeypress);
    }

    return () => {
      if (usePassthrough) {
        keypressStream.removeListener('keypress', handleKeypress);
        stdin.removeListener('data', handleRawKeypress);
      } else {
        stdin.removeListener('keypress', handleKeypress);
      }

      rl.close();

      // Restore the terminal to its original state.
      if (wasRaw === false) {
        setRawMode(false);
      }

      if (backslashTimeout) {
        clearTimeout(backslashTimeout);
        backslashTimeout = null;
      }

      // Flush any pending paste data to avoid data loss on exit.
      if (isPaste) {
        logPasteDebug('Cleanup: flushing pending paste data');
        broadcast({
          name: '',
          ctrl: false,
          meta: false,
          shift: false,
          paste: true,
          sequence: pasteBuffer.toString(),
        });
        pasteBuffer = Buffer.alloc(0);
      }

      // Clean up Windows paste timer
      if (windowsPasteTimer) {
        clearTimeout(windowsPasteTimer);
        windowsPasteTimer = null;
        if (windowsPasteBuffer) {
          // Flush any pending Windows paste buffer
          logPasteDebug('Cleanup: flushing Windows paste buffer');
          broadcast({
            name: '',
            ctrl: false,
            meta: false,
            shift: false,
            paste: true,
            sequence: windowsPasteBuffer,
          });
          windowsPasteBuffer = '';
        }
      }

      // Clean up debug log
      if (pasteDebugStream) {
        pasteDebugStream.write(
          `\n=== Session ended at ${new Date().toISOString()} ===\n`,
        );
        pasteDebugStream.end();
        pasteDebugStream = null;
      }

      if (draggingTimerRef.current) {
        clearTimeout(draggingTimerRef.current);
        draggingTimerRef.current = null;
      }
      if (isDraggingRef.current && dragBufferRef.current) {
        broadcast({
          name: '',
          ctrl: false,
          meta: false,
          shift: false,
          paste: true,
          sequence: dragBufferRef.current,
        });
        isDraggingRef.current = false;
        dragBufferRef.current = '';
      }
    };
  }, [
    stdin,
    setRawMode,
    kittyProtocolEnabled,
    config,
    subscribers,
    debugKeystrokeLogging,
  ]);

  return (
    <KeypressContext.Provider value={{ subscribe, unsubscribe }}>
      {children}
    </KeypressContext.Provider>
  );
}
