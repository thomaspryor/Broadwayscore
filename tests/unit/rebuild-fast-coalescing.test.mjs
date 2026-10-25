/**
 * BRO-5913: a burst of scoring-triggered rebuild-fast dispatches must coalesce (cancel scope is pinned in opening-night-cancel-scope.test.mjs). (
 * other shows') runs, and a burst of scoring-triggered rebuild-fast dispatches
 * must coalesce instead of fanning out one rebuild per run.
 * Evaluates the REAL workflow YAML.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wf = (n) => fs.readFileSync(path.join(root, '.github/workflows', n), 'utf8');
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const ff = wf('rebuild-fast.yml');
const m = ff.match(/^concurrency:\n(?:\s+#.*\n)*\s+group: (.+)\n\s+cancel-in-progress: (\w+)/m);
assert.ok(m, 'rebuild-fast concurrency block not found');
const expr = m[1].match(/\$\{\{\s*(.+?)\s*\}\}/)[1];
const prefix = m[1].split('${{')[0];
const group = (inputs, runId) => {
  const fn = new Function('inputs', 'format', 'github', `return (${expr});`);
  const format = (f, v) => f.replace('{0}', v);
  return prefix + fn(inputs, format, { run_id: runId });
};
// run_id appears inside the expression via format('-force-{0}', github.run_id)
test('rebuild-fast: scoring dispatches and cron share one group; force_write stays per-run', () => {
  assert.equal(group({ reason: 'x' }, 1), group({ reason: 'y', force_write: 'false' }, 2));
  assert.equal(group({}, 1), 'rebuild-fast');
  assert.notEqual(group({ force_write: 'true' }, 1), group({ force_write: 'true' }, 2));
  assert.notEqual(group({ force_write: 'true' }, 1), 'rebuild-fast');
});

test('rebuild-fast: queue semantics documented and cancel-in-progress stays false', () => {
  assert.equal(m[2], 'false');
  assert.match(ff, /concurrency-queue-ok/);
});

import { createRequire } from 'module';
const { parse, simulateSharedGroup } = createRequire(import.meta.url)('../../scripts/lib/publish-coalescing-replay.js');

test('860-night replay: shared group runs fewer rebuilds and always runs the newest dispatch', () => {
  const text = fs.readFileSync(path.join(root, 'scripts/lib/fixtures/publish-coalescing/860-night-2026-10-22.txt'), 'utf8');
  const runs = parse(text, 'rebuild-fast');
  const after = simulateSharedGroup(runs);
  assert.ok(runs.length >= 10);
  assert.ok(after.length < runs.length / 2, `expected coalescing, got ${after.length}/${runs.length}`);
  assert.equal(after[after.length - 1].id, runs[runs.length - 1].id, 'newest dispatch must run last');
  // no two executions overlap
  for (let i = 1; i < after.length; i++) assert.ok(after[i].start >= after[i - 1].start + after[i - 1].dur);
});
