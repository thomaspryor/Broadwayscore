// scripts/lib/cmux-socket-auth.test.mjs — BRO-2959.
// Requires the REAL module (CLAUDE.md rule 15): if the credential or the
// error taxonomy changes, these fail — that is the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const auth = require('./cmux-socket-auth.js');

// The shape of the real ~/.config/cmux/cmux.json: JSONC, and — the trap that
// makes a naive `//` comment-stripper corrupt the file — a "//" inside the
// very first string value.
const REAL_SHAPED_JSONC = `{
  "$schema": "https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json",
  "schemaVersion": 1,

  "automation": {
    "socketControlMode": "password",
    "socketPassword": "s3cr3t-abc123"
  },

  // This file uses JSON with comments (JSONC).
  // Uncomment and edit any setting to make it file-managed.
  //   "automation" : {
  //     "socketPassword" : "NOT-THIS-ONE-ITS-COMMENTED",
  //   },
}`;

test('extractSocketPassword reads the password out of real-shaped JSONC', () => {
  assert.equal(auth.extractSocketPassword(REAL_SHAPED_JSONC), 's3cr3t-abc123');
});

test('extractSocketPassword survives the "//" inside the $schema URL', () => {
  // A regex that strips from "//" to end-of-line eats the $schema line and
  // corrupts the document. Assert the URL itself is never mistaken for the
  // password and that extraction still succeeds.
  const pw = auth.extractSocketPassword(REAL_SHAPED_JSONC);
  assert.ok(!String(pw).includes('http'), 'must not return part of the schema URL');
  assert.equal(pw, 's3cr3t-abc123');
});

test('extractSocketPassword parses plain JSON too', () => {
  const plain = JSON.stringify({ automation: { socketPassword: 'plain-pw' } });
  assert.equal(auth.extractSocketPassword(plain), 'plain-pw');
});

test('extractSocketPassword unescapes an escaped password', () => {
  const text = '{ "automation": { "socketPassword": "a\\"b\\\\c" } }';
  assert.equal(auth.extractSocketPassword(text), 'a"b\\c');
});

test('extractSocketPassword returns null (never "") when absent or unusable', () => {
  for (const input of ['', null, undefined, '{}', '{ "automation": {} }',
                       '{ "automation": { "socketPassword": "" } }', 'not json at all']) {
    assert.equal(auth.extractSocketPassword(input), null, `input: ${JSON.stringify(input)}`);
  }
});

test('classifyCmuxError separates a permanent auth fault from a transient outage', () => {
  const cases = [
    ['Error: ERROR: Access denied - only processes started inside cmux can connect', 'auth-denied'],
    ['Error: ERROR: Invalid password', 'auth-denied'],
    ['Error: Failed to connect to socket at /Users/x/cmux.sock (Connection refused)', 'unavailable'],
    ['Error: Socket not found at /Users/x/cmux.sock', 'unavailable'],
    ['Error: Socket closed before reply', 'unavailable'],
    ['Error: Command timed out', 'timeout'],
    ['spawn ENOENT', 'not-found'],
    ['something else entirely', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(auth.classifyCmuxError(input), expected, `input: ${input}`);
  }
});

test('extractSocketPassword ignores a COMMENTED-OUT socketPassword', () => {
  // cmux ships a commented template carrying its own socketPassword line.
  // Picking that up would inject a credential the operator never enabled.
  const commentedOnly = `{
  "$schema": "https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json",
  "schemaVersion": 1,
  //   "automation" : {
  //     "socketPassword" : "TEMPLATE-VALUE-NOT-ACTIVE",
  //   },
}`;
  assert.equal(auth.extractSocketPassword(commentedOnly), null);
});

test('extractSocketPassword picks the ACTIVE password even when a commented one precedes it', () => {
  const commentedFirst = `{
  "$schema": "https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json",
  //     "socketPassword" : "COMMENTED-DECOY",
  "automation": {
    "socketPassword": "the-real-one"
  },
}`;
  assert.equal(auth.extractSocketPassword(commentedFirst), 'the-real-one');
});

test('classifyCmuxError ignores stdout — command OUTPUT must never read as a rejection', () => {
  // A workspace title or `top` table containing "Access denied" would
  // otherwise be misread as an auth failure and trigger a mutating retry of a
  // command that already applied.
  const err = new Error('Command failed: cmux send');
  err.stdout = 'workspace:7  Investigating the Access denied incident\n';
  err.stderr = '';
  assert.notEqual(auth.classifyCmuxError(err), 'auth-denied');
});

test('classifyCmuxError reads stderr off a real execFileSync-shaped error', () => {
  const err = new Error('Command failed: /Applications/cmux.app/.../cmux list-workspaces');
  err.stderr = 'Error: ERROR: Access denied - only processes started inside cmux can connect\n';
  assert.equal(auth.classifyCmuxError(err), 'auth-denied');
});

test('buildCmuxEnv never overwrites a password the caller already set', () => {
  const out = auth.buildCmuxEnv({ PATH: '/bin', CMUX_SOCKET_PASSWORD: 'operator-set' }, 'from-disk');
  assert.equal(out.CMUX_SOCKET_PASSWORD, 'operator-set');
});

test('buildCmuxEnv OMITS the variable when no password is known', () => {
  // Setting it to '' would be rejected where absence succeeds (an in-cmux
  // caller is admitted by ancestry) — that would turn a no-op into an outage.
  for (const pw of [null, '', undefined]) {
    const out = auth.buildCmuxEnv({ PATH: '/bin' }, pw);
    assert.ok(!('CMUX_SOCKET_PASSWORD' in out), `pw ${JSON.stringify(pw)} must not set the var`);
  }
});

test('buildCmuxEnv injects a known password and does not mutate the input', () => {
  const base = { PATH: '/bin' };
  const out = auth.buildCmuxEnv(base, 'pw123');
  assert.equal(out.CMUX_SOCKET_PASSWORD, 'pw123');
  assert.equal(out.PATH, '/bin');
  assert.ok(!('CMUX_SOCKET_PASSWORD' in base), 'must not mutate the caller env');
});

test('withoutCmuxPassword strips the variable for the fallback retry', () => {
  const out = auth.withoutCmuxPassword({ PATH: '/bin', CMUX_SOCKET_PASSWORD: 'stale' });
  assert.ok(!('CMUX_SOCKET_PASSWORD' in out));
  assert.equal(out.PATH, '/bin');
});

test('readSocketPasswordFromDisk memoizes, and refresh picks up a rotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmux-auth-'));
  const cfg = path.join(dir, 'cmux.json');
  fs.writeFileSync(cfg, REAL_SHAPED_JSONC);
  auth._resetPasswordCache();

  assert.equal(auth.readSocketPasswordFromDisk({ configPath: cfg }), 's3cr3t-abc123');

  fs.writeFileSync(cfg, REAL_SHAPED_JSONC.replace('s3cr3t-abc123', 'rotated-xyz'));
  // Cached: run() is called per-workspace in loops, so it must NOT re-read.
  assert.equal(auth.readSocketPasswordFromDisk({ configPath: cfg }), 's3cr3t-abc123');
  // The auth-denied retry path forces a re-read.
  assert.equal(auth.readSocketPasswordFromDisk({ configPath: cfg, refresh: true }), 'rotated-xyz');

  auth._resetPasswordCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readSocketPasswordFromDisk returns null for a missing config', () => {
  auth._resetPasswordCache();
  const missing = path.join(os.tmpdir(), 'definitely-not-here-cmux.json');
  assert.equal(auth.readSocketPasswordFromDisk({ configPath: missing }), null);
  auth._resetPasswordCache();
});

test('summarizeCmuxFailures escalates on the FIRST auth denial, not after N', () => {
  const one = auth.summarizeCmuxFailures(['Error: ERROR: Access denied - only processes started inside cmux can connect']);
  assert.equal(one.escalate, true);
  assert.equal(one.authDenied, 1);
});

test('summarizeCmuxFailures escalates an UNCLASSIFIABLE cmux failure', () => {
  // The taxonomy recognises auth rejections by their English prose, so the day
  // cmux rewords them every rejection becomes 'unknown'. If that stayed quiet
  // the fleet would lose its self-heal silently — the exact 2026-09-07 outage.
  const reworded = auth.summarizeCmuxFailures(['Error: connection prohibited by policy']);
  assert.equal(auth.classifyCmuxError('Error: connection prohibited by policy'), 'unknown');
  assert.equal(reworded.escalate, true, 'an unrecognised cmux failure must fail loud');
  assert.equal(reworded.unknown, 1);
});

test('summarizeCmuxFailures stays quiet for transient failures', () => {
  const transient = auth.summarizeCmuxFailures([
    'Error: Failed to connect to socket (Connection refused)',
    'Error: Command timed out',
  ]);
  assert.equal(transient.escalate, false, 'a cmux that is merely down must not page');
  assert.equal(transient.counts.unavailable, 1);
  assert.equal(transient.counts.timeout, 1);
});

test('summarizeCmuxFailures handles an empty / non-array tick', () => {
  for (const input of [[], null, undefined]) {
    assert.equal(auth.summarizeCmuxFailures(input).escalate, false);
  }
});

test('buildCmuxEnv under force DROPS a rejected credential when disk has nothing better', () => {
  // Keeping it would repeat the credential cmux just rejected, making the
  // retry a no-op a second way — and it made the ladder test depend on
  // whether the machine running it happened to have a cmux config at all.
  const out = auth.buildCmuxEnv({ PATH: '/bin', CMUX_SOCKET_PASSWORD: 'rejected' }, null, { force: true });
  assert.ok(!('CMUX_SOCKET_PASSWORD' in out));
  assert.equal(out.PATH, '/bin');
});

test('buildCmuxEnv under force replaces a rejected credential with the disk one', () => {
  const out = auth.buildCmuxEnv({ CMUX_SOCKET_PASSWORD: 'rejected' }, 'fresh-from-disk', { force: true });
  assert.equal(out.CMUX_SOCKET_PASSWORD, 'fresh-from-disk');
});

test('an unreadable config is reported ONCE per path, not once per read', (t) => {
  // Every auth rejection re-reads with refresh:true, and a tick makes dozens
  // of cmux calls — unguarded, a persistently unreadable config would flood
  // every 5-minute launchd tick with identical lines.
  auth._resetPasswordCache();
  const logged = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmux-eacces-'));
  const cfg = path.join(dir, 'cmux.json');
  fs.writeFileSync(cfg, '{}');
  fs.chmodSync(cfg, 0o000);
  try {
    for (let i = 0; i < 5; i++) {
      auth.readSocketPasswordFromDisk({ configPath: cfg, refresh: true, logFn: (m) => logged.push(m) });
    }
    // Running as root can still read a 0o000 file (Docker, act), in which
    // case there is nothing to assert — skip rather than pass vacuously.
    if (logged.length === 0) {
      t.skip('running as root — the unreadable-config path never triggered');
      return;
    }
    assert.equal(logged.length, 1);
  } finally {
    fs.chmodSync(cfg, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
    auth._resetPasswordCache();
  }
});
