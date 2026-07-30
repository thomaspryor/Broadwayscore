import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySubject,
  dayKeyET,
  buildDailyReport,
  decideDayViolation,
  decideDayMissing,
} from './scheduled-email-count-rules.js';

test('classifySubject matches each known scheduled sender', () => {
  assert.equal(classifySubject('Morning digest — Tue, Jul 28').key, 'morning-digest');
  assert.equal(classifySubject('Morning digest — Tue, Jul 28 · ⚠️ site health: 2 errors, 1 warning').key, 'morning-digest');
  assert.equal(classifySubject('Overnight: 3 items awaiting your tap').key, 'autonomous-email');
  assert.equal(classifySubject('Daily Digest: 12 changes on 2026-07-26').key, 'daily-digest');
  assert.equal(classifySubject('⚠️ Daily Digest: 25 changes (1 warning) on 2026-07-24').key, 'daily-digest');
  assert.equal(classifySubject('1 needs help · Jul 26').key, 'opening-digest');
  assert.equal(classifySubject('2 need help · 1 broadcast-ready · Jul 26').key, 'opening-digest');
  assert.equal(classifySubject('1 broadcast-ready · Jul 24').key, 'opening-digest');
  assert.equal(classifySubject('1 upcoming this week · Jul 25').key, 'opening-digest');
  assert.equal(classifySubject('Quiet week · Jul 27').key, 'opening-digest');
  // Real subjects from the owner's inbox that the pre-restore pattern missed
  // (buildDigestLead's "opening today"/"tomorrow" clauses).
  assert.equal(classifySubject('1 opening today · Jul 22').key, 'opening-digest');
  assert.equal(classifySubject('2 tomorrow · Jul 21').key, 'opening-digest');
  // An unrelated owner email mentioning "needs help" must NOT classify as
  // the opening digest (it would mask a dead digest in decideDayMissing).
  assert.equal(classifySubject('[ACTION] Show X needs help with images'), null);
  assert.equal(classifySubject('r/Broadway — 2 threads for you').key, 'reddit-engagement-digest');
  assert.equal(classifySubject('[Action Required] Fantasy weekly draft ready — 2026-07-29').key, 'fantasy-weekly');
  assert.equal(classifySubject('BSC Daily: All clear (27/27 passed)').key, 'health-check-digest');
  assert.equal(classifySubject('BSC URGENT (day 8): 2 unresolved errors').key, 'health-check-digest');
});

test('classifySubject returns null for one-off action/critical alerts', () => {
  assert.equal(classifySubject('[CRITICAL] Opening Night SLA P0 — 4 review(s) stuck'), null);
  assert.equal(classifySubject('[ACTION] Tokenless claude launchd job'), null);
  assert.equal(classifySubject('TestFlight build 54 APPROVED — share link is live'), null);
});

test('dayKeyET buckets by America/New_York calendar date, not UTC', () => {
  // 2026-07-26 01:30 UTC is still 2026-07-25 evening in ET.
  assert.equal(dayKeyET('2026-07-26 01:30:00.000000+00'), '2026-07-25');
  // 2026-07-26 19:11 UTC is 2026-07-26 afternoon in ET.
  assert.equal(dayKeyET('2026-07-26 19:11:18.494614+00'), '2026-07-26');
});

test('buildDailyReport ignores emails not addressed to ownerEmail', () => {
  const emails = [
    { to: ['thomas.pryor@gmail.com'], subject: 'Overnight: 1 item', created_at: '2026-07-26 07:36:00.000000+00' },
    { to: ['someone-else@example.com'], subject: 'Overnight: 1 item', created_at: '2026-07-26 07:37:00.000000+00' },
    { to: 'thomas.pryor@gmail.com', subject: 'r/Broadway — 2 threads for you', created_at: '2026-07-26 13:39:00.000000+00' },
  ];
  const days = buildDailyReport(emails, 'thomas.pryor@gmail.com');
  assert.equal(days.size, 1);
  const bucket = days.get('2026-07-26');
  assert.equal(bucket.senders.size, 2);
  assert.deepEqual(bucket.other, []);
});

test('buildDailyReport buckets unclassified owner emails as "other", not a sender', () => {
  const emails = [
    { to: ['thomas.pryor@gmail.com'], subject: '[CRITICAL] main test.yml STILL red', created_at: '2026-07-24 04:31:00.000000+00' },
  ];
  const days = buildDailyReport(emails, 'thomas.pryor@gmail.com');
  const bucket = days.get('2026-07-24');
  assert.equal(bucket.senders.size, 0);
  assert.equal(bucket.other.length, 1);
});

test('decideDayViolation: expected senders are fine, any unexpected sender is a violation', () => {
  // The expected daily set (morning-digest + opening-digest, restored
  // 2026-07-30) firing together is the healthy state, not a violation.
  const expectedPair = {
    senders: new Map([
      ['morning-digest', { label: 'Morning digest', subjects: ['Morning digest — Thu, Jul 30'] }],
      ['opening-digest', { label: 'Opening digest', subjects: ['1 broadcast-ready · Jul 30'] }],
    ]),
    other: [],
  };
  assert.equal(decideDayViolation(expectedPair).violation, false);
  assert.equal(decideDayViolation(expectedPair).senderCount, 2);

  // A non-expected scheduled sender firing — even alone — is a resurrection.
  const oneUnexpected = { senders: new Map([['autonomous-email', { label: 'x', subjects: ['a'] }]]), other: [] };
  assert.equal(decideDayViolation(oneUnexpected).violation, true);
  assert.deepEqual(decideDayViolation(oneUnexpected).unexpectedKeys, ['autonomous-email']);

  const twoUnexpected = {
    senders: new Map([
      ['autonomous-email', { label: 'x', subjects: ['a'] }],
      ['reddit-engagement-digest', { label: 'y', subjects: ['b'] }],
    ]),
    other: [],
  };
  const decision = decideDayViolation(twoUnexpected);
  assert.equal(decision.violation, true);
  assert.equal(decision.senderCount, 2);

  const zeroSenders = { senders: new Map(), other: [] };
  assert.equal(decideDayViolation(zeroSenders).violation, false);
});

test('decideDayViolation forgiveness is date-bounded: after the cutover window both count', () => {
  const both = {
    senders: new Map([
      ['autonomous-email', { label: 'Overnight morning email', subjects: ['Overnight: 0 items'] }],
      ['morning-digest', { label: 'Morning digest', subjects: ['Morning digest — Mon, Aug 10'] }],
    ]),
    other: [],
  };
  // Inside the window: forgiven. After it: a resurrected retired sender is a violation.
  assert.equal(decideDayViolation(both, '2026-07-28').violation, false);
  assert.equal(decideDayViolation(both, '2026-08-10').violation, true);
});

test('decideDayMissing is keyed to the PRIMARY morning-digest sender specifically', () => {
  // A resurrected retired sender firing alone must NOT satisfy the floor.
  const onlyRetired = { senders: new Map([['autonomous-email', { label: 'x', subjects: ['Overnight: 1 item'] }]]), other: [] };
  assert.equal(decideDayMissing(onlyRetired).missing, true);
  assert.equal(decideDayMissing(onlyRetired).senderCount, 1);
});

test('decideDayViolation forgives the loop→digest transition day but not a resurrection', () => {
  // Cutover day: last "Overnight:" send + first "Morning digest" send on the
  // same ET date — retired sender is forgiven because its replacement fired.
  const transitionDay = {
    senders: new Map([
      ['autonomous-email', { label: 'Overnight morning email', subjects: ['Overnight: 0 items'] }],
      ['morning-digest', { label: 'Morning digest', subjects: ['Morning digest — Mon, Jul 27'] }],
    ]),
    other: [],
  };
  const transition = decideDayViolation(transitionDay, '2026-07-27');
  assert.equal(transition.violation, false);
  assert.equal(transition.senderCount, 1);
  // Omitted dayKey fails closed: no forgiveness (codex P2 hardening).
  assert.equal(decideDayViolation(transitionDay).violation, true);

  // A retired sender firing WITHOUT its replacement is the old path
  // resurrecting — it still counts, so 2 distinct = violation.
  const resurrection = {
    senders: new Map([
      ['autonomous-email', { label: 'Overnight morning email', subjects: ['Overnight: 1 item'] }],
      ['reddit-engagement-digest', { label: 'Reddit', subjects: ['r/Broadway — 2 threads for you'] }],
    ]),
    other: [],
  };
  assert.equal(decideDayViolation(resurrection).violation, true);
});

test('decideDayMissing: zero scheduled senders (or no bucket at all) is a miss', () => {
  assert.equal(decideDayMissing(undefined).missing, true);
  assert.equal(decideDayMissing({ senders: new Map(), other: [{ subject: '[CRITICAL] x' }] }).missing, true);
  const ok = { senders: new Map([['morning-digest', { label: 'Morning digest', subjects: ['Morning digest — Tue, Jul 28'] }]]), other: [] };
  assert.equal(decideDayMissing(ok).missing, false);
});

test('decideDayMissing: expectedSince gates the opening-digest floor; both-fired day is clean', () => {
  const morningOnly = { senders: new Map([['morning-digest', { label: 'Morning digest', subjects: ['Morning digest — Tue, Jul 28'] }]]), other: [] };
  // Day BEFORE the restore's first cron day: opening-digest absence is not a miss.
  assert.deepEqual(decideDayMissing(morningOnly, '2026-07-30').missingExpected, []);
  // Day ON/AFTER: it is.
  assert.deepEqual(decideDayMissing(morningOnly, '2026-07-31').missingExpected, ['opening-digest']);
  // No dayKey (fail-closed): still flagged.
  assert.deepEqual(decideDayMissing(morningOnly).missingExpected, ['opening-digest']);
  const both = {
    senders: new Map([
      ['morning-digest', { label: 'Morning digest', subjects: ['Morning digest — Fri, Jul 31'] }],
      ['opening-digest', { label: 'Opening digest', subjects: ['Quiet week · Jul 31'] }],
    ]),
    other: [],
  };
  assert.deepEqual(decideDayMissing(both, '2026-07-31').missingExpected, []);
});

test('fantasy-weekly is allowed: never a violation, never required daily', () => {
  const wednesday = {
    senders: new Map([
      ['morning-digest', { label: 'Morning digest', subjects: ['Morning digest — Wed, Aug 5'] }],
      ['opening-digest', { label: 'Opening digest', subjects: ['1 broadcast-ready · Aug 5'] }],
      ['fantasy-weekly', { label: 'Fantasy weekly', subjects: ['[Action Required] Fantasy weekly draft ready — 2026-08-05'] }],
    ]),
    other: [],
  };
  assert.equal(decideDayViolation(wednesday, '2026-08-05').violation, false);
  assert.deepEqual(decideDayMissing(wednesday, '2026-08-05').missingExpected, []);
});

// Subject↔classifier parity for the opening digest — the same contract the
// morning digest has in digest-snapshots.test.mjs. buildDigestLead's real
// clause variants must all classify, or a real send reads as "missing".
test('opening digest buildSubject output always classifies as opening-digest', async () => {
  const { buildDigestLead } = await import('../send-opening-digest.js');
  const mk = (sections) => `${buildDigestLead(sections)} · Jul 30`;
  const row = {};
  const variants = [
    { needsHelp: [row, row], broadcastReady: [], comingUp: [] },              // "2 need help" (plural!)
    { needsHelp: [row], broadcastReady: [], comingUp: [] },                   // "1 needs help"
    { needsHelp: [], broadcastReady: [row], comingUp: [] },                   // "1 broadcast-ready"
    { needsHelp: [], broadcastReady: [], comingUp: [{ daysFromToday: 0 }] },  // "1 opening today"
    { needsHelp: [], broadcastReady: [], comingUp: [{ daysFromToday: 1 }] },  // "1 tomorrow"
    { needsHelp: [], broadcastReady: [], comingUp: [{ daysFromToday: 3 }] },  // "1 upcoming this week"
    { needsHelp: [], broadcastReady: [], comingUp: [] },                      // "Quiet week"
  ];
  for (const sections of variants) {
    const subject = mk(sections);
    assert.equal(classifySubject(subject)?.key, 'opening-digest', `subject "${subject}" must classify`);
  }
});

test('real-world regression fixture: 2026-07-26 had 3+ distinct scheduled senders (pre-#497 fold)', () => {
  // Actual subjects observed live via Resend GET /emails on 2026-07-26 (card #510 investigation).
  const emails = [
    { to: ['thomas.pryor@gmail.com'], subject: 'Overnight: ⚠️ 10 items stalling the loop — needs your triage', created_at: '2026-07-26 07:36:54.556310+00' },
    { to: ['thomas.pryor@gmail.com'], subject: 'Daily Digest: 27 changes on 2026-07-26', created_at: '2026-07-26 12:23:27.877524+00' },
    { to: ['thomas.pryor@gmail.com'], subject: 'r/Broadway — 2 threads for you', created_at: '2026-07-26 13:39:25.938199+00' },
    { to: ['thomas.pryor@gmail.com'], subject: 'BSC URGENT (day 8): 2 unresolved errors', created_at: '2026-07-26 16:23:12.601517+00' },
  ];
  const days = buildDailyReport(emails, 'thomas.pryor@gmail.com');
  const decision = decideDayViolation(days.get('2026-07-26'));
  assert.equal(decision.violation, true);
  assert.equal(decision.senderCount, 4);
});
