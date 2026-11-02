// BRO-6852: filing refuses an owner-worded park that names nothing only the owner can supply and
// carries no DECISION NEEDED question. Runs the real createLimboReason (CLAUDE.md 15).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLimboReason, ownerWordedParkHit } = require('../lib/owner-judgment-limbo-guard.js');

// Real park reasons from the BRO-5372 triage: owner wording on plain worker work.
const WORDED_AS_HOLDS = [
  'per-outlet naming judgment; data plan batch',
  'needs human triage of the duplicates, a session of its own',
  'owner call on which failures matter enough to act on same day',
  'needs owner judgment on the wording',
];
// Real holds: the owner supplies money, a login, a taste call, a bulk change or the Mac.
const REAL_HOLDS = [
  'needs owner decision: Mail+ subscription (99p/mo) for cookie-auth scraping of star ratings',
  'Requires interactive Google OAuth consent (owner login) to mint a new refresh token',
  "Owner product call: the site deliberately shows no % for closed shows",
  'bulk board mutation (108 issues) needs explicit owner sign-off before running',
  "needs the owner's Mac: cookie extraction runs in the local browser, not in CI",
  'owner go-ahead before we send the email broadcast',
  'waits on the Resend API key from the owner',
];

test('owner-worded parks with no question are refused at filing', () => {
  for (const reason of WORDED_AS_HOLDS) {
    const why = createLimboReason({ body: 'Some work.', parkReason: reason });
    assert.ok(why, `should refuse: ${reason}`);
    assert.match(why, /--dispatch/);
  }
});

test('a written question, or a real owner-only need or block, still files', () => {
  assert.equal(createLimboReason({ body: 'DECISION NEEDED: Which wording?\nWhy this is your call: taste.', parkReason: WORDED_AS_HOLDS[3] }), null);
  for (const reason of REAL_HOLDS) assert.equal(ownerWordedParkHit(reason), null, reason);
  assert.equal(createLimboReason({ body: 'x', parkReason: 'needs a rescore after the flags clear (BRO-1 lands first)' }), null);
  assert.equal(createLimboReason({ body: 'x', parkReason: '' }), null);
});
