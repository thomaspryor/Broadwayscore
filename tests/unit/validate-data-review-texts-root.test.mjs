/**
 * validate-data.js must read review-texts through REVIEW_TEXTS_ROOT (which
 * honours REVIEW_TEXTS_DIR), never a hardcoded DATA_DIR join. A mixed setup
 * would validate the clone in some checks and the main checkout's stale copy
 * in others; ack-landed.js --data-repo review-texts depends on this (BRO-5219).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/validate-data.js'), 'utf8');

test('the only DATA_DIR review-texts join is the REVIEW_TEXTS_ROOT default', () => {
  const hits = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && /path\.join\(DATA_DIR,\s*['"]review-texts['"]/.test(l));
  assert.equal(hits.length, 1, `hardcoded review-texts paths:\n${hits.join('\n')}`);
  assert.match(hits[0], /const REVIEW_TEXTS_ROOT = process\.env\.REVIEW_TEXTS_DIR \|\|/);
});
