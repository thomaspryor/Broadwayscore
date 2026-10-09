import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt,
  parseExemptEntries, findUnjustifiedExempt, findFalseDigestClaims, findDigestDrift,
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
