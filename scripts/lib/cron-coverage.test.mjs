import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt,
  parseExemptEntries, findUnjustifiedExempt, findFalseDigestClaims, findDigestDrift,
  worstGapHours, extractCrons, classifyAlertPaths, livenessVerdict, consecutiveFailureVerdict,
} = require('./cron-coverage.js');
const { DIGEST_CRONS, DIGEST_ONLY } = require('./health-digest-crons.js');
const fs = require('node:fs');
const path = require('node:path');

test('isScheduledWorkflow: true only when a cron schedule is present', () => {
  assert.equal(isScheduledWorkflow('on:\n  schedule:\n    - cron: "*/10 * * * *"\n'), true);
  assert.equal(isScheduledWorkflow("on:\n  schedule:\n    - cron: '0 9 * * 1'\n"), true);
  // UNQUOTED cron must still be detected (else it evades the coverage gate).
  assert.equal(isScheduledWorkflow('on:\n  schedule:\n    - cron: 30 5 1,15 * *\n'), true);
  // workflow_dispatch only — not scheduled
  assert.equal(isScheduledWorkflow('on:\n  workflow_dispatch:\n'), false);
  // a `schedule:` key with no cron string (defensive)
  assert.equal(isScheduledWorkflow('on:\n  schedule:\n'), false);
  // schedule: key present but the only cron line is COMMENTED OUT → not actually scheduled
  assert.equal(isScheduledWorkflow("on:\n  schedule:\n    # - cron: '0 9 * * *'\n  workflow_dispatch:\n"), false);
  // the word cron in a comment but no schedule trigger
  assert.equal(isScheduledWorkflow('# cron health note\non:\n  push:\n'), false);
  assert.equal(isScheduledWorkflow(''), false);
  assert.equal(isScheduledWorkflow(null), false);
});

test('parseExemptList: filenames only, ignores comments/blanks, trims', () => {
  const txt = `# header comment\n\nfoo.yml\n  bar.yml  \n# baz.yml (disabled comment)\nqux.yml\n`;
  const set = parseExemptList(txt);
  assert.deepEqual([...set].sort(), ['bar.yml', 'foo.yml', 'qux.yml']);
  assert.ok(!set.has('baz.yml')); // commented out
  assert.equal(parseExemptList('').size, 0);
  assert.equal(parseExemptList(null).size, 0);
});

test('findUncoveredScheduled: scheduled minus covered minus exempt, sorted', () => {
  const scheduled = ['c.yml', 'a.yml', 'b.yml', 'd.yml'];
  const covered = new Set(['a.yml']);
  const exempt = new Set(['b.yml']);
  assert.deepEqual(findUncoveredScheduled(scheduled, covered, exempt), ['c.yml', 'd.yml']);
});

test('findUncoveredScheduled: all covered/exempt → empty (the seeded steady state)', () => {
  const scheduled = ['a.yml', 'b.yml'];
  assert.deepEqual(findUncoveredScheduled(scheduled, new Set(['a.yml']), new Set(['b.yml'])), []);
});

test('findUncoveredScheduled: a brand-new scheduled workflow in neither list is flagged', () => {
  // Simulates someone adding new-cron.yml without classifying it.
  const scheduled = ['existing.yml', 'new-cron.yml'];
  const covered = new Set(['existing.yml']);
  const exempt = new Set(); // not added anywhere
  assert.deepEqual(findUncoveredScheduled(scheduled, covered, exempt), ['new-cron.yml']);
});

test('findStaleExempt: flags exempt entries that no longer exist or are double-listed', () => {
  const exempt = new Set(['gone.yml', 'live.yml', 'promoted.yml']);
  const scheduledSet = new Set(['live.yml', 'promoted.yml']); // gone.yml de-scheduled/deleted
  const covered = new Set(['promoted.yml']);                   // promoted.yml now also in CRITICAL_CRONS
  const stale = findStaleExempt(exempt, scheduledSet, covered);
  assert.deepEqual(stale.notScheduled, ['gone.yml']);
  assert.deepEqual(stale.alsoCovered, ['promoted.yml']);
});

// ── BRO-2818: justification + honesty of the exempt list ─────────────────────

test('parseExemptEntries: comment block above and inline comments become the reason; a blank line discards it', () => {
  const txt = [
    '# header', '', 'bare.yml',
    '# why a', '# continued', 'a.yml',
    'b.yml  # inline why',
    '# orphaned comment', '', 'c.yml',
    '# [digest] covered', 'd.yml',
  ].join('\n');
  const m = parseExemptEntries(txt);
  assert.equal(m.get('bare.yml').reason, '');
  assert.equal(m.get('a.yml').reason, 'why a continued');
  assert.equal(m.get('b.yml').reason, 'inline why');
  assert.equal(m.get('c.yml').reason, '', 'a comment separated by a blank line does not attach');
  assert.equal(m.get('d.yml').claimsDigest, true);
  assert.equal(m.get('a.yml').claimsDigest, false);
  // a comment is consumed by ONE entry: the next bare filename is unjustified again
  const two = parseExemptEntries('# reason\nx.yml\ny.yml\n');
  assert.deepEqual(findUnjustifiedExempt(two), ['y.yml']);
});

test('findFalseDigestClaims: only [digest] claims absent from the digest list', () => {
  const m = parseExemptEntries('# [digest] yes\nreal.yml\n# [digest] lies\nfake.yml\n# low-stakes\nplain.yml\n');
  assert.deepEqual(findFalseDigestClaims(m, ['real.yml']), ['fake.yml']);
});

test('findDigestDrift: missing, mismatched and stale digest-only entries are reported', () => {
  const digest = [
    { workflow: 'a.yml', maxHours: 36 }, { workflow: 'b.yml', maxHours: 36 },
    { workflow: 'c.yml', maxHours: 24 }, { workflow: 'd.yml', maxHours: 10 },
  ];
  const paging = new Map([['a.yml', 36], ['b.yml', 48], ['d.yml', 10]]);
  const r = findDigestDrift(digest, paging, { 'c.yml': 'digest-only', 'gone.yml': 'stale' });
  assert.deepEqual(r.missingFromPaging, []);
  assert.deepEqual(r.hoursMismatch, ['b.yml (digest 36h vs paging 48h)']);
  assert.deepEqual(r.staleDigestOnly, ['gone.yml']);
  const r2 = findDigestDrift(digest, paging, {});
  assert.deepEqual(r2.missingFromPaging, ['c.yml']);
});

test('real files: digest list agrees with check-cron-health.yml, and the watchdog is watched by the digest', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const ch = fs.readFileSync(path.join(root, '.github', 'workflows', 'check-cron-health.yml'), 'utf8');
  const paging = new Map([...ch.matchAll(/"([a-z0-9-]+\.yml)\|(\d+)\|([^"|]+)/g)].map(m => [m[1], parseInt(m[2], 10)]));
  const r = findDigestDrift(DIGEST_CRONS, paging, DIGEST_ONLY);
  assert.deepEqual(r, { missingFromPaging: [], hoursMismatch: [], staleDigestOnly: [] });
  assert.ok(DIGEST_CRONS.some(d => d.workflow === 'check-cron-health.yml'),
    'check-cron-health.yml must be watched by something other than itself');
  const exempt = parseExemptEntries(fs.readFileSync(path.join(root, '.cron-health-exempt.txt'), 'utf8'));
  assert.deepEqual(findFalseDigestClaims(exempt, DIGEST_CRONS.map(d => d.workflow)), []);
});

test('the watchdog digest row is liveness-only (it exits 1 by design when it pages)', () => {
  const w = DIGEST_CRONS.find(d => d.workflow === 'check-cron-health.yml');
  assert.equal(w.livenessOnly, true);
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'health-check.js'), 'utf8');
  assert.match(src, /livenessOnly && run\.conclusion/, 'health-check.js must honour livenessOnly');
});

// ── BRO-3492: shared cadence helpers + default liveness sweep ──

test('extractCrons: quoted, unquoted, trailing comments; comment lines ignored', () => {
  const y = "on:\n  schedule:\n    - cron: '30 9 * * 1' # Mondays\n    - cron: 30 5 1,15 * *\n    # - cron: '1 1 * * *'\n    - cron: \"0 */6 * * *\"\n";
  assert.deepEqual(extractCrons(y), ['30 9 * * 1', '30 5 1,15 * *', '0 */6 * * *']);
  assert.deepEqual(extractCrons(''), []);
});

test('worstGapHours: weekly 168, daily 24, seasonal null', () => {
  assert.equal(worstGapHours(['30 9 * * 1']), 168);
  assert.equal(worstGapHours(['0 4 * * *']), 24);
  assert.equal(worstGapHours(['0 9 * 4-6 *']), null);
});

test('classifyAlertPaths: paged > digest > opted-out > default liveness', () => {
  const exempt = parseExemptEntries('a.yml  # weekly report\n# internal only [no-liveness: manual-only experiment]\nb.yml\nc.yml # x\n');
  const r = classifyAlertPaths(['a.yml', 'b.yml', 'c.yml', 'd.yml', 'p.yml'], new Set(['p.yml']), ['d.yml'], exempt);
  assert.deepEqual([...r], [['a.yml', 'liveness'], ['b.yml', 'none'], ['c.yml', 'liveness'], ['d.yml', 'digest'], ['p.yml', 'paged']]);
  // A new scheduled workflow with no exempt entry still lands on liveness (covered by default).
  assert.equal(classifyAlertPaths(['new.yml'], new Set(), [], new Map()).get('new.yml'), 'liveness');
});

test('livenessVerdict: red runs count as started; cancelled/startup_failure do not', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const weekly = ['30 9 * * 1']; // limit 168+24 = 192h
  const at = h => new Date(now - h * 3_600_000).toISOString();
  assert.deepEqual(livenessVerdict({ crons: weekly, runs: [{ conclusion: 'failure', created_at: at(100) }], now }),
    { status: 'alive', limitHours: 192, ageHours: 100 });
  // Real case 2026-10-12: scrape-dtli-show-score timed out (cancelled) 3 weeks running.
  const v = livenessVerdict({ crons: weekly, now, runs: [
    { conclusion: 'cancelled', created_at: at(17) }, { conclusion: 'cancelled', created_at: at(185) },
    { conclusion: 'startup_failure', created_at: at(300) }, { conclusion: 'success', created_at: at(500) }] });
  assert.equal(v.status, 'stale');
  assert.equal(v.ageHours, 500);
  assert.equal(livenessVerdict({ crons: weekly, runs: [{ conclusion: 'cancelled', created_at: at(17) }], now }).status, 'stale');
  assert.equal(livenessVerdict({ crons: ['0 9 * 4-6 *'], runs: [], now }).status, 'unknown');
  // in-flight run (no conclusion yet) counts as started
  assert.equal(livenessVerdict({ crons: weekly, runs: [{ conclusion: null, created_at: at(1) }], now }).status, 'alive');
});

test('livenessVerdict: zero scheduled runs is unknown until the workflow outlives its limit (BRO-5675)', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const weekly = ['0 6 * * 0']; // limit 192h
  // Real case 2026-10-18: reverify-cv-promoted-weekly.yml flagged before its first scheduled fire.
  assert.equal(livenessVerdict({ crons: weekly, runs: [], now }).status, 'unknown');
  assert.equal(livenessVerdict({ crons: weekly, runs: [], now, createdAt: '2026-10-15T00:00:00Z' }).status, 'unknown');
  // Registered 30 days ago and never fired on schedule: a dead cron, still stale.
  assert.deepEqual(livenessVerdict({ crons: weekly, runs: [], now, createdAt: '2026-09-18T12:00:00Z' }),
    { status: 'stale', limitHours: 192, ageHours: null });
  assert.equal(livenessVerdict({ crons: weekly, runs: [], now, createdAt: 'not a date' }).status, 'unknown');
});

test('real repo: every exempt-path cron is on a watched path; opt-outs give a reason', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const exempt = parseExemptEntries(fs.readFileSync(path.join(root, '.cron-health-exempt.txt'), 'utf8'));
  for (const [f, v] of exempt) if (v.noLiveness) assert.match(v.reason, /\[no-liveness\s*:\s*\S/, f);
});

test('parseExemptList: inline reasons are not part of the filename (BRO-4941)', () => {
  assert.deepEqual([...parseExemptList('# head\na.yml  # weekly report\nb.yml\n')], ['a.yml', 'b.yml']);
});

test('livenessVerdict: a monthly cron is alive late in a 31-day month', () => {
  const v = livenessVerdict({ crons: ['0 12 1 * *'], runs: [{ conclusion: 'success', created_at: '2026-10-01T12:05:00Z' }], now: Date.parse('2026-11-01T11:00:00Z') });
  assert.equal(v.status, 'alive');
  const late = livenessVerdict({ crons: ['0 12 1 * *'], runs: [{ conclusion: 'success', created_at: '2026-09-01T12:05:00Z' }], now: Date.parse('2026-11-01T11:00:00Z') });
  assert.equal(late.status, 'stale');
});

test('consecutiveFailureVerdict: 3 finished scheduled failures in a row is dead (BRO-5962)', () => {
  const r = (conclusion, d) => ({ conclusion, created_at: `2026-10-${d}T06:00:00Z` });
  const red = consecutiveFailureVerdict([r('failure', '04'), r('failure', '11'), r('failure', '18')]);
  assert.deepEqual(red, { failing: true, streak: 3, lastFailureAt: '2026-10-18T06:00:00Z' });
  // A success in the newest 3 breaks it; order of input does not matter.
  assert.equal(consecutiveFailureVerdict([r('failure', '04'), r('success', '18'), r('failure', '11')]).failing, false);
  // Cancelled / in-flight runs are skipped, not counted and not a break.
  assert.equal(consecutiveFailureVerdict([r('failure', '04'), r('cancelled', '11'), r('failure', '12'), { created_at: '2026-10-19T06:00:00Z' }, r('failure', '18')]).failing, true);
  // Too little history is not a streak.
  assert.equal(consecutiveFailureVerdict([r('failure', '11'), r('failure', '18')]).failing, false);
  assert.equal(consecutiveFailureVerdict([]).failing, false);
});
