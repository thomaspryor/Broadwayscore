// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — reads the workflow YAML only.
/**
 * BRO-2479: audit-critic-coverage.yml must not swallow a lost push. A
 * `push-with-retry.sh ... || echo` made the run exit green while two weekly
 * outlet-heartbeat snapshots were thrown away.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const yml = fs.readFileSync(path.join(here, '../../.github/workflows/audit-critic-coverage.yml'), 'utf8');

test('push-with-retry.sh is called and its failure is not swallowed', () => {
  const lines = yml.split('\n').filter((l) => l.includes('push-with-retry.sh') && !l.trim().startsWith('#'));
  assert.ok(lines.length >= 1, 'workflow should push via push-with-retry.sh');
  for (const l of lines) {
    assert.doesNotMatch(l, /\|\|/, `push failure swallowed: ${l.trim()}`);
  }
});

test('the commit-and-push step is not continue-on-error', () => {
  const step = yml.slice(yml.indexOf('- name: Commit and push audit reports'), yml.indexOf('- name: Notify on failure'));
  assert.ok(step.includes('push-with-retry.sh'));
  assert.doesNotMatch(step, /continue-on-error:\s*true|set \+e/);
});

test('failure notification step still runs on failure', () => {
  assert.match(yml, /Notify on failure[\s\S]*if: failure\(\)/);
});
