// BRO-5008: cloud-run-script.js pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs, extractOutput, validateScriptPath, BEGIN, END } = require('./cloud-run-script.js');

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
