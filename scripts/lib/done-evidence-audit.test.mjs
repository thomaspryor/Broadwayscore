import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { commitIsOnMain, pullIsOnMain } = require('./done-evidence-remote.js');
const childProcess = require('node:child_process');

test('the sweep uses the gate policy without probing an unrelated local checkout', (t) => {
  t.mock.method(childProcess, 'execFileSync', () => {
    throw new Error('a remote-only sweep must not run local git or unshallow');
  });
  // Both modules capture execFileSync when loaded. Reload after installing
  // the trap, then restore the original cache entries for the other tests.
  const paths = ['./done-evidence-verify.js', './done-evidence-remote.js'].map(p => require.resolve(p));
  const cached = paths.map(p => require.cache[p]);
  t.after(() => paths.forEach((p, i) => { require.cache[p] = cached[i]; }));
  paths.forEach(p => { delete require.cache[p]; });
  const verifier = require('./done-evidence-verify.js');
  const { makeIsCommitOnMain, makeRemoteLookup } = verifier;
  const factory = t.mock.method(verifier, 'makeIsCommitOnMain', (opts) => {
    assert.equal(opts.remoteOnly, true);
    return makeIsCommitOnMain(opts);
  });
  const sweep = require('./done-evidence-remote.js');
  for (const status of ['behind', 'identical', 'ahead', 'diverged', 'unexpected', '', null]) {
    const remote = makeRemoteLookup({
      originRepo: 'owner/repo',
      httpGetJson: () => status === null ? null : { status },
    });
    const onMain = makeIsCommitOnMain({ remoteOnly: true, remote })('abc1234');
    const expected = onMain === true ? 'holds' : onMain === false ? 'broken' : 'unknown';
    const calls = [];
    assert.equal(sweep.commitIsOnMain('abc1234', {
      repo: 'owner/repo',
      runGh: (args) => { calls.push(args); return status; },
    }), expected, String(status));
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /^repos\/owner\/repo\/compare\/main\.\.\.abc1234\?per_page=1$/);
  }
  assert.equal(factory.mock.calls.length, 7, 'every sweep lookup must delegate to the shared factory');
  assert.equal(childProcess.execFileSync.mock.calls.length, 0);
});

test('a merged PR delegates its merge SHA to the same conservative ancestry policy', () => {
  for (const status of ['ahead', 'diverged']) {
    const calls = [];
    assert.equal(pullIsOnMain('827', {
      runGh: (args) => {
        calls.push(args);
        return args[1].includes('/pulls/') ? 'true\tabc1234' : status;
      },
    }), 'unknown');
    assert.equal(calls.length, 2);
  }
});

test('missing evidence does not make a GitHub request', () => {
  const runGh = () => { throw new Error('no evidence to query'); };
  assert.equal(commitIsOnMain('', { runGh }), 'unknown');
  assert.equal(pullIsOnMain('', { runGh }), 'unknown');
});

test('a failing check whose output quotes an email never lands it in the committed report (BRO-6520)', () => {
  const { evaluateVerifyRun } = require('./done-evidence-audit.js');
  const { firstRealEmail } = require('./pii-scan.js');
  const r = evaluateVerifyRun({ status: 'fail', detail: 'hit → email-shaped string (x***x@xxxxxx.xx.xx)' }, 'node scripts/lint-committed-pii.js');
  assert.ok(r.detail.includes('email-shaped string'));
  assert.equal(firstRealEmail(r.detail), null);
  assert.ok(!/x\*\*\*x@/.test(r.detail));
});

test('an unverifiable run detail is redacted too (BRO-6520)', () => {
  const { evaluateVerifyRun } = require('./done-evidence-audit.js');
  const { firstRealEmail } = require('./pii-scan.js');
  const r = evaluateVerifyRun({ status: 'unverifiable', detail: 'check exited 3: contact alice@example.com' }, 'node scripts/x.js');
  assert.equal(firstRealEmail(r.detail || ''), null);
});
