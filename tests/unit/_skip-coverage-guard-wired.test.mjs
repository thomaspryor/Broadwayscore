/**
 * Wiring test for card #1408 — scripts/audit-uncollected-live-reviews.js
 * shipped 2026-08-13 as the date-independent backstop for the null-
 * openingDate blackout that hid The Winter's Tale and An American Daughter,
 * but nothing in .github/workflows/ ever called it. A guard that exists but
 * never fires is the exact failure mode the incident was about.
 *
 * `_skip-` prefix: deliberately NOT registered in test.yml's explicit
 * `tests/unit` node --test invocation list (that batch is never globbed —
 * see .github/workflows/test.yml's own comments to that effect), so this
 * never gates main CI. The nightly acceptance-recheck
 * (scripts/autonomous-acceptance-recheck.js) picks it up by literal path
 * instead, which is what actually re-verifies a Done card's own acceptance
 * command.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = resolve(ROOT, '.github', 'workflows');

function listWorkflowFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .filter((f) => statSync(join(dir, f)).isFile());
}

test('audit-uncollected-live-reviews.js is called by at least one workflow', () => {
  const files = listWorkflowFiles(WORKFLOWS_DIR);
  const callers = files.filter((f) =>
    readFileSync(join(WORKFLOWS_DIR, f), 'utf8').includes('audit-uncollected-live-reviews'));
  assert.ok(callers.length > 0,
    'No .github/workflows/*.yml references audit-uncollected-live-reviews.js — the guard exists but nothing schedules it (card #1408).');
});
