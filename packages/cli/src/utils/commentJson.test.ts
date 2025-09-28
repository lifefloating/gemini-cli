/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { updateSettingsFilePreservingFormat } from './commentJson.js';

describe('commentJson', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-format-test-'));
    testFilePath = path.join(tempDir, 'settings.json');
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('updateSettingsFilePreservingFormat', () => {
    it('should preserve comments when updating settings', () => {
      const originalContent = `{
        // Model configuration
        "model": "gemini-2.5-pro",
        "ui": {
          // Theme setting
          "theme": "dark"
        }
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-flash',
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');

      expect(updatedContent).toContain('// Model configuration');
      expect(updatedContent).toContain('// Theme setting');
      expect(updatedContent).toContain('"model": "gemini-2.5-flash"');
      expect(updatedContent).toContain('"theme": "dark"');
    });

    it('should handle nested object updates', () => {
      const originalContent = `{
        "ui": {
          "theme": "dark",
          "showLineNumbers": true
        }
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        ui: {
          theme: 'light',
          showLineNumbers: true,
        },
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(updatedContent).toContain('"theme": "light"');
      expect(updatedContent).toContain('"showLineNumbers": true');
    });

    it('should add new fields while preserving existing structure', () => {
      const originalContent = `{
        // Existing config
        "model": "gemini-2.5-pro"
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-pro',
        newField: 'newValue',
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(updatedContent).toContain('// Existing config');
      expect(updatedContent).toContain('"newField": "newValue"');
    });

    it('should create file if it does not exist', () => {
      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-pro',
      });

      expect(fs.existsSync(testFilePath)).toBe(true);
      const content = fs.readFileSync(testFilePath, 'utf-8');
      expect(content).toContain('"model": "gemini-2.5-pro"');
    });

    it('should handle complex real-world scenario', () => {
      const complexContent = `{
        // Settings
        "model": "gemini-2.5-pro",
        "mcpServers": {
          // Active server
          "context7": {
            "headers": {
              "API_KEY": "test-key" // API key
            }
          }
        }
      }`;

      fs.writeFileSync(testFilePath, complexContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-flash',
        mcpServers: {
          context7: {
            headers: {
              API_KEY: 'new-test-key',
            },
          },
        },
        newSection: {
          setting: 'value',
        },
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');

      // Verify comments preserved
      expect(updatedContent).toContain('// Settings');
      expect(updatedContent).toContain('// Active server');
      expect(updatedContent).toContain('// API key');

      // Verify updates applied
      expect(updatedContent).toContain('"model": "gemini-2.5-flash"');
      expect(updatedContent).toContain('"newSection"');
      expect(updatedContent).toContain('"API_KEY": "new-test-key"');
    });

    it('should handle corrupted JSON files gracefully', () => {
      const corruptedContent = `{
        "model": "gemini-2.5-pro",
        "ui": {
          "theme": "dark"
        // Missing closing brace
      `;

      fs.writeFileSync(testFilePath, corruptedContent, 'utf-8');

      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      expect(() => {
        updateSettingsFilePreservingFormat(testFilePath, {
          model: 'gemini-2.5-flash',
        });
      }).not.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        'Error parsing settings file:',
        expect.any(Error),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        'Settings file may be corrupted. Please check the JSON syntax.',
      );

      const unchangedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(unchangedContent).toBe(corruptedContent);

      consoleSpy.mockRestore();
    });

    it('should handle array updates while preserving comments', () => {
      const originalContent = `{
        // Server configurations
        "servers": [
          // First server
          "server1",
          "server2" // Second server
        ]
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        servers: ['server1', 'server3'],
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(updatedContent).toContain('// Server configurations');
      expect(updatedContent).toContain('"server1"');
      expect(updatedContent).toContain('"server3"');
      expect(updatedContent).not.toContain('"server2"');
    });

    it('should preserve existing fields not mentioned in updates', () => {
      const originalContent = `{
        // Configuration
        "model": "gemini-2.5-pro",
        "ui": {
          "theme": "dark",
          "existingSetting": "value"
        },
        "preservedField": "keep me"
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-flash',
        ui: {
          theme: 'light',
        },
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(updatedContent).toContain('// Configuration');
      expect(updatedContent).toContain('"model": "gemini-2.5-flash"');
      expect(updatedContent).toContain('"theme": "light"');
      expect(updatedContent).toContain('"existingSetting": "value"');
      expect(updatedContent).toContain('"preservedField": "keep me"');
    });

    it('should handle mcpServers field deletion properly', () => {
      const originalContent = `{
        "model": "gemini-2.5-pro",
        "mcpServers": {
          // Server to keep
          "context7": {
            "command": "node",
            "args": ["server.js"]
          },
          // Server to remove
          "oldServer": {
            "command": "old",
            "args": ["old.js"]
          }
        }
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-pro',
        mcpServers: {
          context7: {
            command: 'node',
            args: ['server.js'],
          },
        },
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(updatedContent).toContain('// Server to keep');
      expect(updatedContent).toContain('"context7"');
      expect(updatedContent).not.toContain('"oldServer"');
      expect(updatedContent).not.toContain('// Server to remove');
    });

    it('should handle type conversion from object to array', () => {
      const originalContent = `{
        "data": {
          "key": "value"
        }
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        data: ['item1', 'item2'],
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(updatedContent).toContain('"data": [');
      expect(updatedContent).toContain('"item1"');
      expect(updatedContent).toContain('"item2"');
    });
  });
});
