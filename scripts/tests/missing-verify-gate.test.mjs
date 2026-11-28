// BRO-5626 step 6: the front door warns on a session card with no safe VERIFY.
// Runs the real exported function (CLAUDE.md 15).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { missingVerifyReason, MISSING_VERIFY_MESSAGE } = require('../lib/linear-issue-create.js');

const VERIFY = 'Fix it.\n\nVERIFY: `node --test scripts/lib/linear-drain-parked.test.mjs`';
const VAGUE = 'Bookmark icon floats off the corner. Make it line up.';

test('a session card with a safe VERIFY passes, a vague one gets the message', () => {
  assert.strictEqual(missingVerifyReason({ source: 'session', mode: 'dispatch', body: VERIFY }), null);
  const r = missingVerifyReason({ source: 'session', mode: 'dispatch', body: VAGUE });
  assert.ok(r && r.startsWith(MISSING_VERIFY_MESSAGE), r);
});

test('an unsafe command does not count as a VERIFY', () => {
  assert.ok(missingVerifyReason({ source: 'session', mode: 'dispatch', body: 'VERIFY: `rm -rf data/`' }));
});

test('exemptions: workflow filers, real-block parks, owner-judgment marker, --no-verify', () => {
  for (const source of ['digest-autofix', 'alert-router', 'workflow:Test']) {
    assert.strictEqual(missingVerifyReason({ source, mode: 'dispatch', body: VAGUE }), null, source);
  }
  assert.strictEqual(missingVerifyReason({ source: 'session', mode: 'park', parkReason: 'waiting on the owner to pick a design', body: VAGUE }), null);
  assert.strictEqual(missingVerifyReason({ source: 'session', mode: 'park', parkReason: 'needs a PostHog key for the traffic check', body: VAGUE }), null);
  assert.strictEqual(missingVerifyReason({ source: 'session', mode: 'dispatch', body: VAGUE, noVerify: 'owner-run console setting' }), null);
});

test('a takeable park reason does not exempt a vague card', () => {
  assert.ok(missingVerifyReason({ source: 'session', mode: 'park', parkReason: 'needs its own session', body: VAGUE }));
});
