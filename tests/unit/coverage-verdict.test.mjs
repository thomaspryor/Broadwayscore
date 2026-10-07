// Coverage Verdict S2 (task #906) — censusVerdict() per-candidate states +
// the audit-show-review-gap.js adapter that feeds them from the pipeline the
// system already has (no new census machinery). Fixtures are modeled on real
// show-review-gap.json rows (see data/audit/show-review-gap.json entries for
// the-car-man-west-end-2026 and the Brainiac Live gap, task #839/#758).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { censusVerdict, candidateStatesFor } = require('../../scripts/lib/review-census.js');
const { censusVerdictFor, gapStateFor } = require('../../scripts/lib/gap-audit-merge.js');
const { classifyCell } = require('../../scripts/lib/t1-ledger.js');

const NOW = '2026-08-03T12:00:00.000Z';

test('censusVerdict candidate states: live entries are state=live, missing entries classify via t1-ledger', () => {
  const census = {
    hadAnySource: true,
    count: 2,
    entries: [
      { outletId: 'guardian', url: 'https://theguardian.com/x' },
      { outletId: 'timeout', url: 'https://timeout.com/x' },
    ],
  };
  const v = censusVerdict(census, new Set(['guardian']), { now: NOW, clockAnchor: '2026-07-01T00:00:00.000Z' });
  assert.equal(v.verdict, 'incomplete');
  assert.equal(v.candidates.length, 2);
  const guardian = v.candidates.find((c) => c.outletId === 'guardian');
  const timeout = v.candidates.find((c) => c.outletId === 'timeout');
  assert.equal(guardian.state, 'live');
  assert.equal(timeout.state, 'GAP'); // clock is >24h old and unsuppressed
  assert.equal(timeout.reason, 'sla-breach');
});

test('empty census: candidateStatesFor / censusVerdict both no-op (no-census-yet, no candidates)', () => {
  const empty = { hadAnySource: false, count: 0, entries: [] };
  assert.deepEqual(candidateStatesFor(empty, new Set()), []);
  const v = censusVerdict(empty, new Set());
  assert.equal(v.verdict, 'no-census-yet');
  assert.deepEqual(v.candidates, []);
});

test('firstSeenAt is preserved across runs via prevCandidates (mirrors t1-ledger mergeLedger)', () => {
  const census = { hadAnySource: true, count: 1, entries: [{ outletId: 'wsj', url: 'https://wsj.com/x' }] };
  const first = candidateStatesFor(census, new Set(), { now: '2026-08-01T00:00:00.000Z' });
  assert.equal(first[0].firstSeenAt, '2026-08-01T00:00:00.000Z');
  const second = candidateStatesFor(census, new Set(), { now: NOW, prevCandidates: first });
  assert.equal(second[0].firstSeenAt, '2026-08-01T00:00:00.000Z', 'birth timestamp does not reset on a later run');
});

// ---- audit-show-review-gap.js result fixtures (the producer's own shape) ----

function gapResult(showId, over = {}) {
  return {
    showId,
    title: showId,
    openingDate: '2026-07-28',
    aggregatorArticles: ['https://www.broadwayworld.com/article/Review-Roundup-X'],
    aggregatorListedUrls: [],
    missing: [],
    flaggedMisses: [],
    citedNoUrl: [],
    ...over,
  };
}

test('Car Man-shaped: WE show with one stale-grace missing outlet + covered ones stays incomplete/GAP', () => {
  const r = gapResult('the-car-man-west-end-2026', {
    aggregatorListedUrls: [
      'https://www.standard.co.uk/culture/theatre/x.html',
      'https://www.thestage.co.uk/reviews/x',
    ],
    missing: [{ url: 'https://www.thestage.co.uk/reviews/x', host: 'thestage.co.uk', knownOutletId: 'thestage' }],
    flaggedMisses: [{ url: 'https://www.standard.co.uk/culture/theatre/x.html', host: 'standard.co.uk', knownOutletId: 'standard', recoverable: false }],
  });
  const cv = censusVerdictFor(r, { now: NOW }); // openingDate 2026-07-28, now 2026-08-03 => well past 24h grace
  assert.equal(cv.verdict, 'incomplete');
  assert.equal(cv.candidateCount, 2);
  assert.equal(cv.liveCount, 0);
  const thestage = cv.candidates.find((c) => c.outletId === 'thestage');
  const standard = cv.candidates.find((c) => c.outletId === 'standard');
  assert.equal(thestage.state, 'GAP');
  assert.equal(standard.state, 'GAP');
  assert.equal(gapStateFor(r), 'incomplete');
});

test('Brainiac-shaped: recently-opened show with a missing outlet is IN_FLIGHT, not GAP (24h grace)', () => {
  const r = gapResult('brainiac-live-off-west-end-2026', {
    openingDate: '2026-08-03', // "today" relative to NOW
    aggregatorListedUrls: ['https://theatreweekly.com/x'],
    missing: [{ url: 'https://theatreweekly.com/x', host: 'theatreweekly.com', knownOutletId: 'theatre-weekly' }],
  });
  const cv = censusVerdictFor(r, { now: '2026-08-03T14:00:00.000Z' }); // 2h after opening
  assert.equal(cv.verdict, 'incomplete'); // still incomplete — grace affects the CANDIDATE state, not the verdict
  const cand = cv.candidates.find((c) => c.outletId === 'theatre-weekly');
  assert.equal(cand.state, 'IN_FLIGHT');
  assert.equal(cand.reason, 'within-grace');
});

test('clean: every candidate covered, zero gaps -> complete, liveCount == candidateCount', () => {
  const r = gapResult('clean-show', {
    aggregatorListedUrls: ['https://theguardian.com/x', 'https://timeout.com/y'],
  });
  const cv = censusVerdictFor(r, { now: NOW });
  assert.equal(cv.verdict, 'complete');
  assert.equal(cv.liveCount, 2);
  assert.equal(cv.candidateCount, 2);
  assert.ok(cv.candidates.every((c) => c.state === 'live'));
  assert.equal(gapStateFor(r), 'complete');
});

test('empty-census: no aggregator article, no listed URLs -> no-census-yet, zero candidates', () => {
  const r = gapResult('unheard-of-show', { aggregatorArticles: [], aggregatorListedUrls: [] });
  const cv = censusVerdictFor(r, { now: NOW });
  assert.equal(cv.verdict, 'no-census-yet');
  assert.equal(cv.candidateCount, 0);
  assert.equal(cv.liveCount, 0);
  assert.deepEqual(cv.candidates, []);
  assert.equal(gapStateFor(r), 'no-census-yet');
});

test('no-date: missing openingDate never produces a GAP — clock is unmeasurable, fails open to IN_FLIGHT', () => {
  const r = gapResult('no-date-show', {
    openingDate: null,
    aggregatorListedUrls: ['https://theguardian.com/x'],
    missing: [{ url: 'https://theguardian.com/x', host: 'theguardian.com', knownOutletId: 'guardian' }],
  });
  const cv = censusVerdictFor(r, { now: NOW });
  assert.equal(cv.verdict, 'incomplete');
  const cand = cv.candidates.find((c) => c.outletId === 'guardian');
  assert.equal(cand.state, 'IN_FLIGHT');
  // sanity: classifyCell itself documents this — no measurable clock => IN_FLIGHT, never GAP
  assert.equal(classifyCell({ clockAgeHours: null }), 'IN_FLIGHT');
});

test('same-host collision: an unregistered outlet with one covered URL and one missing URL must not mask the gap (ship-check finding)', () => {
  const r = gapResult('collision-show', {
    aggregatorListedUrls: [
      'https://smallblog.com/review-of-the-show',   // covered — not in missing/flagged
      'https://smallblog.com/a-second-review',       // missing — same host, no knownOutletId
    ],
    missing: [{ url: 'https://smallblog.com/a-second-review', host: 'smallblog.com', knownOutletId: null }],
  });
  const cv = censusVerdictFor(r, { now: NOW });
  // Both URLs derive to the bare hostname when unregistered — the missing one
  // must still surface as a real gap, not get swallowed by the covered entry
  // sharing the same fallback identity.
  assert.equal(cv.verdict, 'incomplete');
  assert.equal(cv.liveCount, 1);
  assert.equal(cv.candidateCount, 2);
  const states = cv.candidates.map((c) => c.state).sort();
  assert.deepEqual(states, ['GAP', 'live']);
});

test('CI-unfetchable outlets (WSJ/New Yorker) block "complete" but read SUPPRESSED, not GAP', () => {
  const r = gapResult('paper-show', {
    aggregatorListedUrls: ['https://www.wsj.com/x'],
    missing: [{ url: 'https://www.wsj.com/x', host: 'wsj.com', knownOutletId: 'wsj' }],
  });
  const cv = censusVerdictFor(r, { now: NOW });
  assert.equal(cv.verdict, 'incomplete');
  const wsj = cv.candidates.find((c) => c.outletId === 'wsj');
  assert.equal(wsj.state, 'SUPPRESSED');
  assert.equal(wsj.reason, 'ci-unfetchable');
});

// #906 ship-check finding: candidates are URL-level, so firstSeenAt continuity
// must key on the URL. Keying on outletId alone let a brand-new sibling URL
// inherit its older sibling's birth date and read as stale from day one.
test('firstSeenAt: a new sibling URL is born now, it does not inherit its sibling age', () => {
  const census = {
    hadAnySource: true,
    count: 2,
    entries: [
      { outletId: 'timeout', outlet: 'Time Out', url: 'https://timeout.com/old', critic: 'Unknown', stars: null },
      { outletId: 'timeout', outlet: 'Time Out', url: 'https://timeout.com/new', critic: 'Unknown', stars: null },
    ],
  };
  const prevCandidates = [{ url: 'https://timeout.com/old', outletId: 'timeout', state: 'live', firstSeenAt: '2026-07-01T00:00:00.000Z' }];
  const out = candidateStatesFor(census, new Set(['timeout']), { now: '2026-08-03T00:00:00.000Z', prevCandidates });
  const byUrl = Object.fromEntries(out.map((c) => [c.url, c.firstSeenAt]));
  assert.equal(byUrl['https://timeout.com/old'], '2026-07-01T00:00:00.000Z');
  assert.equal(byUrl['https://timeout.com/new'], '2026-08-03T00:00:00.000Z');
});

test('firstSeenAt: a URL-less candidate (citedNoUrl) still matches on outletId', () => {
  const census = {
    hadAnySource: true,
    count: 1,
    entries: [{ outletId: 'the-stage', outlet: 'The Stage', url: '', critic: 'Unknown', stars: null }],
  };
  const prevCandidates = [{ url: '', outletId: 'the-stage', state: 'IN_FLIGHT', firstSeenAt: '2026-07-01T00:00:00.000Z' }];
  const out = candidateStatesFor(census, new Set(), { now: '2026-08-03T00:00:00.000Z', prevCandidates });
  assert.equal(out[0].firstSeenAt, '2026-07-01T00:00:00.000Z');
});
