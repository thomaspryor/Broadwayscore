// BRO-5939: a failed check's REASON names the failing test, not a passing
// test's warning. Uses the real node --test output shape (child stderr is
// folded into `#` lines on stdout), never a synthetic stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { tapDetail, defaultDetail, runSafeChecks } = require('./autonomous-checks.js');

// An outer `node --test` sets NODE_TEST_CONTEXT, which makes a nested run
// report nothing; strip it so the inner run behaves as a top-level one.
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };

function runNodeTest(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-detail-'));
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), body);
  try {
    execFileSync('node', ['--test', '--test-reporter=tap', ...Object.keys(files)], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: cleanEnv() });
    throw new Error('expected failure');
  } catch (err) {
    if (!err.status) throw err;
    return { dir, err };
  }
}
const noisy = `import { test } from 'node:test';
test('passes but warns', () => { console.error('[review-write-guard] showId mismatch noise'); });
test('the real failure', () => { throw new Error('boom-assertion'); });
`;

test('detail: noisy passing test does not mask the failing test', () => {
  const { err } = runNodeTest({ 'a.test.mjs': noisy });
  assert.match(String(err.stdout).slice(0, 400), /review-write-guard/, 'precondition: the head of stdout is the noise');
  const d = tapDetail(err);
  assert.match(d, /^not ok: the real failure \| first failure: boom-assertion/);
  assert.doesNotMatch(d, /review-write-guard/);
  assert.match(defaultDetail(err), /review-write-guard/, 'defaultDetail is the head, which is why colocated-tests needs tapDetail');
});

test('detail: file-level crash carries its cause', () => {
  const { err } = runNodeTest({ 'b.test.mjs': 'const x = ;\n' });
  assert.match(tapDetail(err), /^not ok: .*b\.test\.mjs/);
  assert.match(tapDetail(err), /SyntaxError|Unexpected token/);
});

test('detail: assertion failures show their message, not a YAML block marker', () => {
  const { err } = runNodeTest({ 'd.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('eq fails', () => { assert.equal(1, 2); });
test('custom fails', () => { assert.ok(false, 'custom message here'); });
` });
  const d = tapDetail(err);
  // Every failing name, then the FIRST failure's assertion message (BRO-5937).
  assert.match(d, /^not ok: eq fails; custom fails \| first failure: Expected values to be strictly equal/);
  assert.doesNotMatch(d, /\| first failure: [|>]-?(\s|$)/);
});

test('detail: falls back to the output head when there is no TAP failure', () => {
  assert.equal(tapDetail({ stderr: 'spawn blew up', stdout: '' }), 'spawn blew up');
  assert.equal(tapDetail({ message: 'x'.repeat(500) }).length, 400);
});

test('detail: runSafeChecks colocated-tests names the failing test end to end', () => {
  const { dir } = runNodeTest({ 'c.test.mjs': noisy });
  const res = runSafeChecks({
    cwd: dir, repo: dir, changedFiles: ['c.test.mjs'], checkableDone: null,
    isSafeCheckCommand: () => false, tier: 3, buildCheck: false,
  });
  const r = res.find(x => x.name === 'colocated-tests');
  assert.ok(r && r.pass === false, JSON.stringify(res));
  assert.match(r.detail, /^not ok: the real failure/);
  assert.doesNotMatch(r.detail, /review-write-guard/);
});

test('detail: many long-named failures still name tests inside land.yml\'s 300-char REASON (BRO-5937)', () => {
  const long = n => `probe ${n} asserts the scheduled recheck saw ${'x'.repeat(70)}`;
  const body = `import { test } from 'node:test';
import assert from 'node:assert/strict';
${[1, 2, 3, 4, 5, 6].map(n => `test(${JSON.stringify(long(n))}, () => { assert.ok(false, 'first-assertion-${n}'); });`).join('\n')}
`;
  const { err } = runNodeTest({ 'e.test.mjs': body });
  const d = tapDetail(err);
  assert.ok(d.length <= 300, `detail is ${d.length} chars`);
  assert.match(d, /^not ok: probe 1 asserts/);
  assert.match(d, /\(\+\d+ more\)/);
  assert.match(d, /first failure: first-assertion-1/);
  // The same cut land.yml applies keeps the name and the message.
  assert.equal(d.replace(/\r?\n/g, ' ').slice(0, 300), d);
});

test('tapDetail names the NEW-since-main failures, not the pre-existing ones (BRO-5937)', () => {
  const stdout = [
    'not ok 1 - old failure that already fails on main',
    '  ---', '  error: old cause', '  ...',
    '✗ post-merge test floor: NEW since origin/main — this merge introduced or exposed these, BLOCKING:',
    '   1 failure(s):',
    '    - scripts/x.test.mjs::brand new failure',
  ].join('\n');
  const d = tapDetail({ stdout });
  assert.match(d, /brand new failure/);
  assert.doesNotMatch(d, /old failure/);
});
