// BRO-6687: pure helpers of slow-market-grade.js (STALE display, frequent-outlet gaps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { displayGrade, frequentMissing, gradeShow } = require('./slow-market-grade.js');

const NOW = Date.parse('2026-10-31T12:00:00Z');

test('displayGrade: fresh PASS stays PASS', () => {
  const d = displayGrade({ grade: 'PASS', auditedAt: '2026-10-31T00:00:00Z' }, NOW);
  assert.equal(d.grade, 'PASS');
  assert.equal(d.stale, false);
  assert.equal(d.ageHours, 12);
});

test('displayGrade: PASS older than 24h shows STALE', () => {
  const d = displayGrade({ grade: 'PASS', auditedAt: '2026-10-30T06:00:00Z' }, NOW);
  assert.equal(d.grade, 'STALE');
  assert.equal(d.stale, true);
});

test('displayGrade: old FAIL stays FAIL (marked stale), missing timestamp is stale', () => {
  assert.equal(displayGrade({ grade: 'FAIL', auditedAt: '2026-10-20T00:00:00Z' }, NOW).grade, 'FAIL');
  const d = displayGrade({ grade: 'PASS', auditedAt: null }, NOW);
  assert.equal(d.grade, 'STALE');
  assert.equal(d.ageHours, null);
});

test('displayGrade: NO-AUDIT never becomes STALE; maxAgeHours respected', () => {
  assert.equal(displayGrade({ grade: 'NO-AUDIT', auditedAt: null }, NOW).grade, 'NO-AUDIT');
  assert.equal(displayGrade({ grade: 'PASS', auditedAt: '2026-10-29T12:00:00Z' }, NOW, 72).grade, 'PASS');
});

test('frequentMissing: live outlet, audit-row outlet id and domain match all count as present', () => {
  const frequent = [
    { outletId: 'guardian', rate: 0.9 },
    { outletId: 'the-stage', rate: 0.8 },
    { outletId: 'whatsonstage', rate: 0.7 },
    { outletId: 'time-out-london', rate: 0.65 },
  ];
  const row = {
    missing: [{ url: 'https://www.thestage.co.uk/reviews/x' }],
    flaggedMisses: [{ url: 'https://example.org/a', knownOutletId: 'whatsonstage' }],
  };
  const out = frequentMissing(frequent, ['guardian'], row, { 'the-stage': 'thestage.co.uk', 'time-out-london': 'timeout.com' });
  assert.deepEqual(out.map((f) => f.outletId), ['time-out-london']);
});

test('frequentMissing: null row and bad URLs do not throw', () => {
  const frequent = [{ outletId: 'guardian', rate: 0.9 }];
  assert.deepEqual(frequentMissing(frequent, [], null).map((f) => f.outletId), ['guardian']);
  assert.deepEqual(frequentMissing(frequent, [], { missing: [{ url: 'not a url' }] }).map((f) => f.outletId), ['guardian']);
});

test('gradeShow: no row is NO-AUDIT', () => {
  assert.equal(gradeShow(null, 3).grade, 'NO-AUDIT');
});

// BRO-6751: OVERDUE reads the scheduler's own promise (real freshnessMsFor), never the grade.
import { createRequire as _cr6751 } from 'node:module';
const _req6751 = _cr6751(import.meta.url);
const F6751 = _req6751('./lib/gap-audit-freshness.js');
const { isOverdue, OVERDUE_GRACE_HOURS } = _req6751('./slow-market-grade.js');
const N6751 = Date.parse('2026-11-01T12:00:00Z');
const daysAgo = (d) => new Date(N6751 - d * 864e5).toISOString();

test('isOverdue: closed clean last-year show is not overdue at 5 days (30-day promise), is at 31 days', () => {
  const show = { id: 'x', category: 'broadway', status: 'closed', openingDate: '2026-03-01', closingDate: '2026-06-01' };
  assert.equal(isOverdue(show, { at: daysAgo(5), gaps: 0, uncollected: 0 }, N6751, F6751), false);
  assert.equal(isOverdue(show, { at: daysAgo(31), gaps: 0, uncollected: 0 }, N6751, F6751), true);
});

test('isOverdue: in-window slow-market show is overdue past its 20h daily promise + grace', () => {
  const show = { id: 'y', category: 'off-broadway', status: 'open', openingDate: new Date(N6751 - 12 * 864e5).toISOString().slice(0, 10) };
  const limitH = 20 + OVERDUE_GRACE_HOURS;
  assert.equal(isOverdue(show, { at: new Date(N6751 - (limitH - 1) * 36e5).toISOString(), gaps: 0, uncollected: 0 }, N6751, F6751), false);
  assert.equal(isOverdue(show, { at: new Date(N6751 - (limitH + 1) * 36e5).toISOString(), gaps: 0, uncollected: 0 }, N6751, F6751), true);
});

test('isOverdue: no checkpoint entry is overdue; unknown show is null', () => {
  assert.equal(isOverdue({ id: 'z', category: 'broadway', status: 'open', openingDate: '2026-01-01' }, undefined, N6751, F6751), true);
  assert.equal(isOverdue(undefined, { at: daysAgo(1) }, N6751, F6751), null);
});

test('isOverdue: never-audited show outside the grind window was promised nothing (null)', () => {
  assert.equal(isOverdue({ id: 'old', category: 'broadway', status: 'closed', openingDate: '2019-01-01' }, undefined, N6751, F6751), null);
  assert.equal(isOverdue({ id: 'nodate', category: 'broadway', status: 'closed' }, undefined, N6751, F6751), null);
});
