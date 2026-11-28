// BRO-7994: pins scripts/lib/outside-setting.js on the incident's own words and evidence.
// Measured before wiring (2026-11-21): admitsUnverifiable over 600 real Linear comments (2026-11-20 10:15Z to
// 2026-11-21 15:19Z) matched 1 comment, BRO-6917's "Not checkable from a cloud session", and none of the 15 other
// "could not verify" phrasings (those were about review texts, data, CI, not an outside setting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const o = require('./outside-setting.js');

test('incident admission is caught', () => {
  assert.ok(o.admitsUnverifiable('Gotchas: the Google OAuth web client must list both origins. Not checkable from a cloud session.'));
  assert.ok(o.admitsUnverifiable("I can't verify the authorized origins on the Google client from here."));
  // The incident session's own chat words (2026-11-21).
  assert.ok(o.admitsUnverifiable("You need to: in Google Cloud Console, add both addresses. I can't reach that console from here."));
  assert.ok(o.admitsUnverifiable('Only the owner can add the redirect URI in the Google Cloud console.'));
});

test('non-admissions and quoted admissions pass', () => {
  assert.equal(o.admitsUnverifiable('I could not verify the review text because the private repo is not attached.'), null);
  assert.equal(o.admitsUnverifiable('The old session wrote "Not checkable from a cloud session" and closed.'), null);
  assert.equal(o.admitsUnverifiable('There is no outside setting here that cannot be checked.'), null);
  assert.equal(o.admitsUnverifiable('```\nNot checkable from a cloud session\n```'), null);
});

test('LIVE-CHECK: absence of failure is refused, nonzero success accepted', () => {
  assert.deepEqual(o.liveCheckClaims('LIVE-CHECK: 0 One Tap events 3 minutes after go-live, no errors'), []);
  assert.deepEqual(o.liveCheckClaims('LIVE-CHECK: no refusals seen, inconclusive'), []);
  const ok = o.liveCheckClaims('LIVE-CHECK: 6 One Tap sign-ins completed in PostHog since 14:00 (0 refused)');
  assert.equal(ok.length, 1);
  assert.ok(ok[0].counts.includes(6));
  assert.deepEqual(o.liveCheckClaims('LIVE-CHECK: 1 page ok'), []);
});

test('live reads: connector and committed scripts count, echo does not', () => {
  assert.ok(o.isLiveRead('mcp__0646a38c__exec', { command: 'query' }));
  assert.ok(o.isLiveRead('Bash', { command: 'node scripts/lib/account-metrics.js --days 1' }));
  assert.ok(!o.isLiveRead('Bash', { command: 'curl -s https://broadwayscorecard.com/ | head' }));
  assert.ok(!o.isLiveRead('Bash', { command: 'node scripts/check-prod-deploy.js HEAD' }));
  assert.ok(!o.isLiveRead('Bash', { command: 'echo "6 sign-ins via account-metrics.js"' }));
  assert.ok(!o.isLiveRead('Bash', { command: 'grep -n x scripts/lib/outside-setting.js' }));
});

test('acceptance: existence-only commands are not real (the incident used test -f)', () => {
  assert.equal(o.acceptanceIsReal('test -f src/lib/google-one-tap.ts'), false);
  assert.equal(o.acceptanceIsReal('ls src/lib'), false);
  assert.equal(o.acceptanceIsReal(''), false);
  assert.equal(o.acceptanceIsReal('node scripts/lib/account-metrics.js --check-one-tap'), true);
});

test('recheck acceptance: 30-day date and test -f are both refused (the incident shape)', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const incident = 'RECHECK-AFTER: 2026-12-21\nVERIFY: `test -f src/lib/google-one-tap.ts`';
  assert.equal(o.recheckAcceptanceOk(incident, now).ok, false);
  assert.match(o.recheckAcceptanceOk('RECHECK-AFTER: 2026-11-23\nVERIFY: `test -f src/lib/google-one-tap.ts`', now).reason, /only checks that a file exists/);
  assert.match(o.recheckAcceptanceOk('RECHECK-AFTER: 2026-12-21\nVERIFY: `node scripts/check-alert-condition-absent.js --key-b64 b25lLXRhcC1yZWZ1c2Fs`', now).reason, /more than 7 days/);
  assert.equal(o.recheckAcceptanceOk('RECHECK-AFTER: 2026-11-23\nVERIFY: `node scripts/check-alert-condition-absent.js --key-b64 b25lLXRhcC1yZWZ1c2Fs`', now).ok, true);
  assert.equal(o.recheckAcceptanceOk('nothing here', now).ok, false);
  // Hand-stamped without the colon (review N1): read the same as the shared parser.
  assert.equal(o.recheckAcceptanceOk('RECHECK-AFTER 2026-11-23\nVERIFY: `node scripts/check-alert-condition-absent.js --key-b64 b25lLXRhcC1yZWZ1c2Fs`', now).ok, true);
});

test('declaration and bypass lines', () => {
  assert.match(o.declaration('x\nOUTSIDE-SETTING: Google web client must list both site origins\n'), /Google web client/);
  assert.equal(o.declaration('OUTSIDE-SETTING: short'), null);
  assert.match(o.bypass('NO-OUTSIDE-SETTING: feature is behind a flag that is off for everyone'), /behind a flag/);
});

// Ship-check (Claude reviewer): ordinary engineering sentences must not read as outside-setting admissions.
test('engineering words are not admissions (origin/main, console output, client, dashboard component)', () => {
  for (const s of [
    'I could not check origin/main because the fetch failed.',
    "I can't see the console output from that run.",
    "I can't tell the client which date it is.",
    'I cannot access the dashboard component tests.',
  ]) assert.equal(o.admitsUnverifiable(s), null, s);
  assert.ok(o.admitsUnverifiable("No problem: I can't verify the DNS records from here."));
});

test('live reads must run the script; acceptance judges every segment; a past recheck is stale', () => {
  assert.equal(o.isLiveRead('Bash', { command: 'cat scripts/lib/account-metrics.js' }), false);
  assert.equal(o.isLiveRead('Bash', { command: 'grep -n foo scripts/posthog-x.mjs' }), false);
  assert.equal(o.isLiveRead('Bash', { command: 'node --check scripts/lib/account-metrics.js' }), false);
  assert.equal(o.isLiveRead('Bash', { command: 'node scripts/lib/account-metrics.js --one-tap' }), true);
  assert.equal(o.isLiveRead('Bash', { command: 'cd /x && node scripts/lib/account-metrics.js' }), true);
  for (const c of ['cd x && test -f a', 'grep -q x src/a.ts', 'wc -l a', 'node -e 1']) assert.equal(o.acceptanceIsReal(c), false, c);
  assert.equal(o.acceptanceIsReal('cd x && node scripts/lib/account-metrics.js --min=2'), true);
  const r = o.recheckAcceptanceOk('RECHECK-AFTER: 2025-01-01\nVERIFY: `node scripts/lib/account-metrics.js --min=2`', new Date('2026-11-21T12:00:00Z'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /already past/);
});
