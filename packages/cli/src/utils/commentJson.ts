/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { parse, stringify } from 'comment-json';

/**
 * Updates a JSON file while preserving comments and formatting.
 */
export function updateSettingsFilePreservingFormat(
  filePath: string,
  updates: Record<string, unknown>,
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
  const updatedContent = stringify(updatedStructure, null, 2);

  fs.writeFileSync(filePath, updatedContent, 'utf-8');
}

function applyUpdates(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const result = current;

  function applyKeyDiff(
    base: Record<string, unknown>,
    desired: Record<string, unknown>,
  ): void {
    for (const existingKey of Object.getOwnPropertyNames(base)) {
      if (!Object.prototype.hasOwnProperty.call(desired, existingKey)) {
        delete base[existingKey];
      }
    }

    for (const nextKey of Object.getOwnPropertyNames(desired)) {
      const nextVal = desired[nextKey];
      const baseVal = base[nextKey];

      const isObj =
        typeof nextVal === 'object' &&
        nextVal !== null &&
        !Array.isArray(nextVal);
      const isBaseObj =
        typeof baseVal === 'object' &&
        baseVal !== null &&
        !Array.isArray(baseVal);
      const isArr = Array.isArray(nextVal);
      const isBaseArr = Array.isArray(baseVal);

      if (isObj && isBaseObj) {
        applyKeyDiff(
          baseVal as Record<string, unknown>,
          nextVal as Record<string, unknown>,
        );
      } else if (isArr && isBaseArr) {
        // In-place mutate arrays to preserve array-level comments on CommentArray
        const baseArr = baseVal as unknown[];
        const desiredArr = nextVal as unknown[];
        baseArr.length = 0;
        for (const el of desiredArr) {
          baseArr.push(el);
        }
      } else {
        base[nextKey] = nextVal;
      }
    }
  }

  for (const key of Object.getOwnPropertyNames(updates)) {
    const value = updates[key];
    if (key === 'mcpServers') {
      const isValObj =
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const isResultObj =
        typeof result[key] === 'object' &&
        result[key] !== null &&
        !Array.isArray(result[key]);
      if (isValObj && isResultObj) {
        applyKeyDiff(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
      continue;
    }
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
