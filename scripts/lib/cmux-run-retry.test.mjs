// scripts/lib/cmux-run-retry.test.mjs — BRO-2959.
//
// Covers the auth-denied retry ladder in cmux-workspaces.run(), which is the
// riskiest logic in that module: it can re-send a command, and run() carries
// MUTATING commands (closing a workspace, respawn-pane, workspace-action),
// not just listings. Drives the real run() through its injectable exec seam
// (CLAUDE.md rule 15 — no reimplementation of the ladder here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { run } = require('./cmux-workspaces.js');

const AUTH = 'Error: ERROR: Access denied - only processes started inside cmux can connect';
const BAD_PW = 'Error: ERROR: Invalid password';
const DOWN = 'Error: Failed to connect to socket at /x/cmux.sock (Connection refused)';
const SLOW = 'Error: Command timed out';

function authErr(msg = AUTH) { const e = new Error('Command failed'); e.stderr = msg; return e; }

/** Records every attempt so a test can assert the ladder's exact shape. */
function recorder(outcomes) {
  const calls = [];
  const execFn = (bin, args, opts) => {
    calls.push({ args, env: opts.env });
    const outcome = outcomes[calls.length - 1];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { calls, execFn };
}

const quiet = () => {};

test('a first-attempt success never retries', () => {
  const { calls, execFn } = recorder(['ok']);
  assert.equal(run(['list-workspaces'], { execFn, logFn: quiet }), 'ok');
  assert.equal(calls.length, 1);
});

test('a NON-auth failure is re-thrown immediately and never retried', () => {
  // This is what keeps a mutating command safe: a timeout may mean the command
  // DID land and only the reply was lost, so re-sending could double-apply it.
  for (const msg of [DOWN, SLOW]) {
    const { calls, execFn } = recorder([authErr(msg)]);
    assert.throws(() => run(['close-workspace'], { execFn, logFn: quiet }));
    assert.equal(calls.length, 1, `${msg} must not retry`);
  }
});

test('auth-denied retries with a FORCED refresh, not a byte-identical env', () => {
  const { calls, execFn } = recorder([authErr(), 'ok']);
  const prev = process.env.CMUX_SOCKET_PASSWORD;
  process.env.CMUX_SOCKET_PASSWORD = 'stale-operator-value';
  try {
    assert.equal(run(['list-workspaces'], { execFn, logFn: quiet }), 'ok');
  } finally {
    if (prev === undefined) delete process.env.CMUX_SOCKET_PASSWORD;
    else process.env.CMUX_SOCKET_PASSWORD = prev;
  }
  assert.equal(calls.length, 2);
  // The whole point of the refresh: attempt 2 must not repeat attempt 1's
  // credential, or the retry cannot recover a rotated password.
  assert.notEqual(
    calls[0].env.CMUX_SOCKET_PASSWORD,
    calls[1].env.CMUX_SOCKET_PASSWORD,
    'attempt 2 must not reuse the credential that was just rejected',
  );
});

test('the final attempt drops the credential entirely', () => {
  const { calls, execFn } = recorder([authErr(), authErr(BAD_PW), 'ok']);
  assert.equal(run(['list-workspaces'], { execFn, logFn: quiet }), 'ok');
  assert.equal(calls.length, 3);
  assert.ok(!('CMUX_SOCKET_PASSWORD' in calls[2].env),
    'attempt 3 must send no credential so ancestry can admit an in-cmux caller');
});

test('the ladder is bounded at three attempts — it cannot loop', () => {
  const { calls, execFn } = recorder([authErr(), authErr(), authErr()]);
  assert.throws(() => run(['list-workspaces'], { execFn, logFn: quiet }));
  assert.equal(calls.length, 3);
});

test('a succeeding third attempt is announced, never silent', () => {
  // Otherwise a permanently wrong password costs three spawns per call
  // forever while still looking healthy.
  const logged = [];
  const { execFn } = recorder([authErr(), authErr(), 'ok']);
  run(['list-workspaces'], { execFn, logFn: (m) => logged.push(m) });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /password/i);
});

test('a succeeding SECOND attempt is announced too', () => {
  // Regression guard: once a rejected credential is dropped under force, the
  // common "no password on disk" case recovers on attempt 2 and never reaches
  // attempt 3. Warning only from attempt 3 made a permanently wrong
  // LaunchAgent password invisible.
  const logged = [];
  const { calls, execFn } = recorder([authErr(), 'ok']);
  run(['list-workspaces'], { execFn, logFn: (m) => logged.push(m) });
  assert.equal(calls.length, 2, 'must have recovered on attempt 2');
  assert.equal(logged.length, 1, 'recovering on attempt 2 must not be silent');
  assert.match(logged[0], /password/i);
});

test('a first-attempt success stays quiet', () => {
  // The warning must fire only after an actual rejection — otherwise every
  // healthy call in a 5-minute tick logs.
  const logged = [];
  const { execFn } = recorder(['ok']);
  run(['list-workspaces'], { execFn, logFn: (m) => logged.push(m) });
  assert.equal(logged.length, 0);
});

test('the ORIGINAL auth rejection survives when the last attempt fails differently', () => {
  // If the ladder threw attempt 3's 'unavailable' error, summarizeCmuxFailures
  // would classify it 'unknown' and nothing would page — the exact
  // under-alerting BRO-2959 exists to end.
  const { execFn } = recorder([authErr(), authErr(), authErr(DOWN)]);
  assert.throws(
    () => run(['list-workspaces'], { execFn, logFn: quiet }),
    (e) => /Access denied/.test(`${e.message}${e.stderr || ''}`),
    'the auth diagnosis must not be replaced by the last attempt\'s error',
  );
});

test('a mutating command is never replayed after a non-auth failure', () => {
  const { calls, execFn } = recorder([authErr(SLOW)]);
  assert.throws(() => run(['send', '--workspace', 'workspace:1', '--text', 'hi'],
    { execFn, logFn: quiet }));
  assert.equal(calls.length, 1, 'a timed-out send must not be re-sent');
});
