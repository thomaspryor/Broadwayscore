// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — reads the workflow YAML only.
/**
 * BRO-2480: the 'Detect and auto-fix critic typos' step of weekly-integrity.yml
 * hard-failed three Sundays (2026-08-23/30, 09-06..13) because push-with-retry.sh
 * gave up at its 240s default deadline. The step now funds a 900s deadline with
 * the Git Data API fallback after 3 attempts, inside a job ceiling that covers
 * every step's worst case. Pin that so it cannot silently regress.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const yml = fs.readFileSync(path.join(here, '../../.github/workflows/weekly-integrity.yml'), 'utf8');
const start = yml.indexOf('- name: Detect and auto-fix critic typos');
const rest = yml.slice(start + 10);
const next = rest.search(/\n {6}- name: /);
const step = yml.slice(start, start + 10 + (next === -1 ? rest.length : next));

test('typo step exists and runs detect-critic-typos.js', () => {
  assert.ok(start > 0);
  assert.match(step, /node scripts\/detect-critic-typos\.js/);
});

test('typo step funds a push deadline well above the 240s default', () => {
  const m = step.match(/PUSH_DEADLINE_SEC:\s*'?(\d+)'?/);
  assert.ok(m, 'PUSH_DEADLINE_SEC must be set on the step');
  assert.ok(Number(m[1]) >= 600, `deadline ${m[1]}s too small`);
});

test('typo step enables the API push fallback after a few local attempts', () => {
  const m = step.match(/PUSH_API_FALLBACK_AFTER_ATTEMPTS:\s*'?(\d+)'?/);
  assert.ok(m);
  assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 5);
});

test('job timeout leaves room for the pushes', () => {
  const m = yml.match(/timeout-minutes:\s*(\d+)\s*\n\s*\n?\s*steps:/);
  assert.ok(m, 'job-level timeout-minutes not found');
  assert.ok(Number(m[1]) >= 90);
});
