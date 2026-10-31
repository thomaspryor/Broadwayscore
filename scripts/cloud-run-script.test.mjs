// BRO-5008: cloud-run-script.js pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs, pollDeadline, extractOutput, validateScriptPath, BEGIN, END } = require('./cloud-run-script.js');

test('parseArgs keeps flags before the script and passes the rest through', () => {
  const o = parseArgs(['--review-texts', '--timeout=5', 'scripts/a.js', '--days=91', '--review-texts']);
  assert.equal(o.reviewTexts, true);
  assert.equal(o.timeoutMin, 5);
  assert.equal(o.script, 'scripts/a.js');
  assert.deepEqual(o.args, ['--days=91', '--review-texts']);
});

test('validateScriptPath accepts scripts/ js and ts, refuses everything else', () => {
  assert.equal(validateScriptPath('scripts/analyze-traffic-sources.js'), null);
  assert.equal(validateScriptPath('scripts/llm-scoring/index.ts'), null);
  for (const bad of ['scripts/../.env', '/etc/passwd', 'src/x.js', 'scripts/x.sh', 'scripts/a.js; rm -rf /', 'scripts/a b.js']) {
    assert.ok(validateScriptPath(bad), bad);
  }
});

test('extractOutput reads the delimited block and exit code from a timestamped job log', () => {
  const log = [
    '2026-10-10T21:00:00.0000000Z ##[group]Run node',
    `2026-10-10T21:00:01.1234567Z ${BEGIN}`,
    '2026-10-10T21:00:01.2Z line one',
    '2026-10-10T21:00:01.3Z   indented two',
    `2026-10-10T21:00:02.0Z ${END}`,
    '2026-10-10T21:00:02.1Z === RUN-SCRIPT EXIT 4 ===',
  ].join('\n');
  const r = extractOutput(log);
  assert.equal(r.found, true);
  assert.equal(r.output, 'line one\n  indented two');
  assert.equal(r.exitCode, 4);
});

test('extractOutput reports not-found when the script never started', () => {
  const r = extractOutput('2026-10-10T21:00:00Z checkout failed');
  assert.equal(r.found, false);
  assert.equal(r.exitCode, null);
});

test('--review-texts-depth asks for review-texts history and implies --review-texts (BRO-5373)', () => {
  const o = parseArgs(['--review-texts-depth=4000', 'scripts/a.js', '--days=60']);
  assert.equal(o.reviewTexts, true);
  assert.equal(o.reviewTextsDepth, 4000);
  assert.equal(o.script, 'scripts/a.js');
  assert.deepEqual(o.args, ['--days=60']);
  assert.equal(parseArgs(['scripts/a.js']).reviewTextsDepth, 1, 'default stays a one-commit snapshot');
});

test('pollDeadline: queue time does not count against --timeout (BRO-6485)', () => {
  const min = 60 * 1000;
  const base = { dispatchedAt: 0, timeoutMin: 55, queueWaitMin: 240 };
  assert.equal(pollDeadline({ ...base, startedAt: null }), 240 * min);
  // Started after 68 min queued: the 80-min job window runs from the start.
  assert.equal(pollDeadline({ ...base, startedAt: 68 * min }), (68 + 80) * min);
  assert.equal(parseArgs(['--queue-wait=30', 'scripts/a.js']).queueWaitMin, 30);
  assert.equal(parseArgs(['scripts/a.js']).queueWaitMin, 240);
});
