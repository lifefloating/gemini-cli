/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { parse, stringify } from 'comment-json';

interface EnvVarMapping {
  path: string[];
  originalValue: string;
  resolvedValue: unknown;
}

/**
 * Updates a JSON file while preserving comments, formatting, and environment variable references.
 */
export function updateSettingsFilePreservingFormat(
  filePath: string,
  updates: Record<string, unknown>,
  envVarMappings: EnvVarMapping[] = [],
): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(updates, null, 2), 'utf-8');
    return;
  }

  const originalContent = fs.readFileSync(filePath, 'utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(originalContent) as Record<string, unknown>;
  } catch (error) {
    console.error('Error parsing settings file:', error);
    console.error(
      'Settings file may be corrupted. Please check the JSON syntax.',
    );
    return;
  }

  const updatedStructure = applyUpdates(parsed, updates);
  const restoredStructure = restoreEnvVarReferences(
    updatedStructure,
    envVarMappings,
  );
  const updatedContent = stringify(restoredStructure, null, 2);

  fs.writeFileSync(filePath, updatedContent, 'utf-8');
}

function applyUpdates(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const result = current;

  for (const key of Object.getOwnPropertyNames(updates)) {
    const value = updates[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = applyUpdates(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

function restoreEnvVarReferences(
  obj: Record<string, unknown>,
  envVarMappings: EnvVarMapping[],
): Record<string, unknown> {
  if (envVarMappings.length === 0) {
    return obj;
  }

  const envVarMap = new Map<string, string>();
  for (const mapping of envVarMappings) {
    const pathStr = mapping.path.join('.');
    envVarMap.set(pathStr, mapping.originalValue);
  }

  restoreEnvVarsRecursive(obj, [], envVarMap);
  return obj;
}

function restoreEnvVarsRecursive(
  obj: unknown,
  currentPath: string[],
  envVarMap: Map<string, string>,
): void {
  if (typeof obj !== 'object' || obj === null) {
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const value = obj[i];
      const fullPath = [...currentPath, i.toString()];
      const pathStr = fullPath.join('.');

      const envVarReference = envVarMap.get(pathStr);
      if (envVarReference && typeof value === 'string') {
        obj[i] = envVarReference;
      } else if (typeof value === 'object' && value !== null) {
        restoreEnvVarsRecursive(value, fullPath, envVarMap);
      }
    }
    return;
  }

  for (const key of Object.getOwnPropertyNames(
    obj as Record<string, unknown>,
  )) {
    const value = (obj as Record<string, unknown>)[key];
    const fullPath = [...currentPath, key];
    const pathStr = fullPath.join('.');

    const envVarReference = envVarMap.get(pathStr);
    if (envVarReference && typeof value === 'string') {
      (obj as Record<string, unknown>)[key] = envVarReference;
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      restoreEnvVarsRecursive(value, fullPath, envVarMap);
    } else if (Array.isArray(value)) {
      restoreEnvVarsRecursive(value, fullPath, envVarMap);
    }
  }
}

/**
 * Track environment variable mappings during settings load.
 */
export function trackEnvVarMappings(
  obj: unknown,
  originalObj: unknown,
  path: string[] = [],
): EnvVarMapping[] {
  const mappings: EnvVarMapping[] = [];

  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof originalObj !== 'object' ||
    originalObj === null
  ) {
    return mappings;
  }

  if (Array.isArray(obj) && Array.isArray(originalObj)) {
    for (let i = 0; i < Math.max(obj.length, originalObj.length); i++) {
      const value = obj[i];
      const originalValue = originalObj[i];
      const currentPath = [...path, i.toString()];

      if (typeof originalValue === 'string' && typeof value === 'string') {
        const envVarPattern = /^\$(?:(\w+)|{([^}]+)})$/;
        const match = originalValue.match(envVarPattern);

        if (match && value !== originalValue) {
          mappings.push({
            path: currentPath,
            originalValue,
            resolvedValue: value,
          });
        }
      } else if (typeof value === 'object' && value !== null) {
        const nestedMappings = trackEnvVarMappings(
          value,
          originalValue,
          currentPath,
        );
        mappings.push(...nestedMappings);
      }
    }
    return mappings;
  }

  for (const key of Object.getOwnPropertyNames(
    obj as Record<string, unknown>,
  )) {
    const value = (obj as Record<string, unknown>)[key];
    const originalValue = (originalObj as Record<string, unknown>)[key];
    const currentPath = [...path, key];

    if (typeof originalValue === 'string' && typeof value === 'string') {
      const envVarPattern = /^\$(?:(\w+)|{([^}]+)})$/;
      const match = originalValue.match(envVarPattern);

      if (match && value !== originalValue) {
        mappings.push({
          path: currentPath,
          originalValue,
          resolvedValue: value,
        });
      }
    } else if (typeof value === 'object' && value !== null) {
      const nestedMappings = trackEnvVarMappings(
        value,
        originalValue,
        currentPath,
      );
      mappings.push(...nestedMappings);
    }
  }

  return mappings;
}
