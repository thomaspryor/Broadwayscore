/**
 * tour-backfill (BRO-4211): which archived tour reviews move from a Broadway
 * show to its tour entry, and how each file is rewritten.
 *
 * Run: node --test tests/unit/tour-backfill.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyTourBackfill, prepareTourMove, planTourSweep, decideTourSweep } = require('../../scripts/lib/tour-backfill.js');

const tourFlag = { wrongProduction: true, wrongProductionReason: 'BWW regional/tour review (denver)', url: 'https://www.denverpost.com/x' };

test('a tour-flagged review moves', () => {
  assert.deepEqual(classifyTourBackfill(tourFlag), { action: 'move', reason: 'tour-review' });
});

test('files that are not tour-flagged, already routed, or unusable stay put', () => {
  assert.equal(classifyTourBackfill({ wrongProduction: false }).reason, 'not-flagged');
  assert.equal(classifyTourBackfill({ wrongProduction: true, wrongProductionReason: 'URL year mismatch' }).reason, 'flag-not-tour');
  assert.equal(classifyTourBackfill({ ...tourFlag, routedFromShowId: 'x' }).reason, 'already-routed');
  assert.equal(classifyTourBackfill({ ...tourFlag, isNonReview: true }).reason, 'non-review');
  assert.equal(classifyTourBackfill({ ...tourFlag, duplicateOf: 'a.json' }).reason, 'duplicate');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongShow: true }).reason, 'wrong-show');
});

test('pre-Broadway tryouts and UK productions are not the North American tour', () => {
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongProductionReason: 'Tour review | pre-Broadway tryout at Emerson Colonial' }).reason, 'tryout');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongFullText: 'The pre-Broadway tryout in Boston is a delight.' }).reason, 'tryout');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongProductionReason: 'UK tour stop review' }).reason, 'uk-production');
});

// Four A Beautiful Noise tour-stop reviews (Houston, Minneapolis, Cleveland, Revue)
// carried only this generic label; it must not read as tryout evidence.
test('the generic "Tour/regional/pre-Broadway production" label is neither tryout nor tour evidence (BRO-4262)', () => {
  const generic = { ...tourFlag, showId: 'shucked-2023', wrongProductionReason: 'Tour/regional/pre-Broadway production, not Broadway. Flagged by contamination safety net' };
  // On its own it could be a regional stock or sit-down production: stays put.
  assert.equal(classifyTourBackfill(generic).reason, 'no-tour-evidence');
  // With a tour-stop URL or tour language in the text it moves, and is not read as a tryout.
  assert.equal(classifyTourBackfill({ ...generic, url: 'https://www.broadwayworld.com/denver/article/Review-SHUCKED-at-Buell' }).action, 'move');
  assert.equal(classifyTourBackfill({ ...generic, fullText: 'The national tour of Shucked arrived at the Fox.' }).action, 'move');
});

test('dated reviews before the Broadway opening or the tour launch stay put', () => {
  const ctx = { broadwayOpeningDate: '2022-12-04', tourLaunchDate: '2024-08-01' };
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2022-07-01' }, ctx).reason, 'before-broadway-opening');
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2023-05-01' }, ctx).reason, 'before-tour-launch');
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2024-07-28' }, ctx).action, 'move'); // within a week of launch
  assert.equal(classifyTourBackfill({ ...tourFlag }, ctx).action, 'move'); // undated: no date rule applies
  // Real case: a 2019 Broadway review in beetlejuice-2025 whose note says "not the 2025 tour stop".
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: 'April 29th, 2019' }, ctx).reason, 'before-broadway-opening');
});

test('prepareTourMove restores the text, sets aside Broadway-relative verdicts, stamps provenance', () => {
  const src = {
    showId: 'beetlejuice-2022', ...tourFlag, wrongFullText: 'Review text', fullText: null, contentTier: 'invalid',
    textQuality: 'truncated', contentVerification: { isValid: false }, verifiedBy: 'llm:gemini', possibleTourReview: true,
  };
  const out = prepareTourMove(src, { fromShowId: 'beetlejuice-2022', tourId: 'beetlejuice-tour-2023', at: '2026-09-28T00:00:00Z' });
  assert.equal(out.showId, 'beetlejuice-tour-2023');
  assert.equal(out.fullText, 'Review text');
  assert.equal(out.wrongFullText, undefined);
  assert.equal(out.contentTier, 'truncated');
  for (const k of ['wrongProduction', 'wrongProductionReason', 'contentVerification', 'verifiedBy', 'possibleTourReview']) {
    assert.ok(!(k in out), `${k} should be removed`);
  }
  assert.equal(out.routedPriorVerdicts.wrongProduction, true);
  assert.deepEqual(out.routedPriorVerdicts.contentVerification, { isValid: false });
  assert.equal(out.routedFromShowId, 'beetlejuice-2022');
  assert.equal(src.wrongProduction, true, 'input must not be mutated');
});

test('a wrong_production rejection is set aside on the move; other rejections stand', () => {
  const base = { showId: 'shucked-2023', ...tourFlag, wrongFullText: 't' };
  const moved = prepareTourMove({ ...base, rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', rejectionReasoning: 'touring, not Broadway' },
    { fromShowId: 'shucked-2023', tourId: 'shucked-tour-2024' });
  assert.ok(!('rejectionReason' in moved));
  assert.equal(moved.routedPriorVerdicts.rejectionReason, 'wrong_production');
  const kept = prepareTourMove({ ...base, rejectionReason: 'not_a_review' }, { fromShowId: 'shucked-2023', tourId: 'shucked-tour-2024' });
  assert.equal(kept.rejectionReason, 'not_a_review');
});

test('a closed tour: dated reviews long after closing stay put; undated ones move only if seen before closing', () => {
  const ctx = { tourLaunchDate: '2022-12-01', tourClosingDate: '2025-09-14' };
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2025-10-20' }, ctx).action, 'move'); // within 60 days
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2027-02-01' }, ctx).reason, 'after-tour-close');
  assert.equal(classifyTourBackfill({ ...tourFlag, firstSeenAt: '2024-03-01T00:00:00Z' }, ctx).action, 'move');
  assert.equal(classifyTourBackfill({ ...tourFlag, textFetchedAt: '2027-01-05T00:00:00Z' }, ctx).reason, 'undated-after-close');
  assert.equal(classifyTourBackfill({ ...tourFlag }, ctx).reason, 'undated-after-close'); // never seen: unknown
  // An open tour (no closing date) keeps taking undated reviews.
  assert.equal(classifyTourBackfill({ ...tourFlag }, { tourLaunchDate: '2022-12-01' }).action, 'move');
});

test('two tours of one title: an undated review is ambiguous', () => {
  assert.equal(classifyTourBackfill({ ...tourFlag }, { otherToursOfTitle: 1 }).reason, 'ambiguous-tour');
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2024-01-01' }, { otherToursOfTitle: 1 }).action, 'move');
});

test('planTourSweep: every Broadway production of the title, never other markets', () => {
  const shows = [
    { id: 'bj-2019', title: 'Beetlejuice', category: 'broadway', openingDate: '2019-04-25' },
    { id: 'bj-2022', title: 'Beetlejuice', category: 'broadway' },
    { id: 'bj-we-2026', title: 'Beetlejuice', category: 'west-end' },
    { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway' },
    { id: 'bj-tour-2022', title: 'Beetlejuice', category: 'tour', tourOf: 'bj-2019', status: 'closed', openingDate: '2022-12-01', closingDate: '2025-09-14' },
    { id: 'orphan-tour', title: 'X', category: 'tour', tourOf: 'missing' },
  ];
  const plans = planTourSweep(shows);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].fromIds, ['bj-2019', 'bj-2022']);
  assert.deepEqual(plans[0].ctx, { broadwayOpeningDate: '2019-04-25', tourLaunchDate: '2022-12-01', tourClosingDate: '2025-09-14', otherToursOfTitle: 0, nextTourLaunchDate: null, siblingTourUndated: false });
  // A second tour with no launch date yet: neither tour can take a review.
  const undated = planTourSweep([...shows, { id: 'bj-tour-2027', title: 'Beetlejuice', category: 'tour', tourOf: 'bj-2022', status: 'open' }]);
  assert.equal(undated.find(p => p.tourId === 'bj-tour-2027').ctx.otherToursOfTitle, 1);
  assert.equal(undated.find(p => p.tourId === 'bj-tour-2027').ctx.tourClosingDate, null);
  assert.ok(undated.every(p => p.ctx.siblingTourUndated));
});

test('two dated tours of one title: every dated review goes to exactly one', () => {
  const shows = [
    { id: 'sh-2023', title: 'Shucked', category: 'broadway', openingDate: '2023-04-04' },
    { id: 'sh-tour-2024', title: 'Shucked', category: 'tour', tourOf: 'sh-2023', status: 'closed', openingDate: '2024-10-20', closingDate: '2026-06-07' },
    { id: 'sh-tour-2027', title: 'Shucked', category: 'tour', tourOf: 'sh-2023', status: 'open', openingDate: '2026-07-15' },
  ];
  const [first, second] = ['sh-tour-2024', 'sh-tour-2027'].map(id => planTourSweep(shows).find(p => p.tourId === id));
  assert.equal(first.ctx.nextTourLaunchDate, '2026-07-15');
  // 2026-07-20 fits the first tour's close+60d AND the second's launch: only the second takes it.
  for (const date of ['2025-03-01', '2026-06-20', '2026-07-20', '2027-01-10']) {
    const takers = [first, second].filter(p => classifyTourBackfill({ ...tourFlag, publishDate: date }, p.ctx).action === 'move');
    assert.equal(takers.length, 1, `${date} -> ${takers.map(p => p.tourId)}`);
  }
});

test('decideTourSweep: one move per review URL across Broadway folders; filename collisions and URLs already on the tour stay put', () => {
  const r = (url, extra = {}) => ({ ...tourFlag, url, ...extra });
  const folders = {
    'bj-tour': [{ file: 'post--a.json', data: r('https://post.example/review-1') }],
    'bj-2019': [{ file: 'post--b.json', data: r('https://post.example/review-1/') }], // already on the tour
    'bj-2022': [
      { file: 'gazette--jane.json', data: r('https://gazette.example/r') },
      { file: 'post--a.json', data: r('https://other.example/x') }, // same filename as a tour file
      { file: 'clean.json', data: { url: 'https://c.example', wrongProduction: false } },
    ],
    'bj-2025': [{ file: 'gazette--unknown.json', data: r('https://gazette.example/r') }], // same URL, other byline
  };
  const plan = { tourId: 'bj-tour', fromIds: ['bj-2019', 'bj-2022', 'bj-2025'], ctx: {} };
  const rows = decideTourSweep(plan, id => folders[id] || []);
  assert.deepEqual(rows.map(x => `${x.fromId}/${x.file}:${x.key}`), [
    'bj-2019/post--b.json:duplicate-on-tour',
    'bj-2022/gazette--jane.json:tour-review',
    'bj-2022/post--a.json:target-collision',
    'bj-2025/gazette--unknown.json:duplicate-on-tour',
  ]);
});

test('scheduled sweep holds a flood instead of moving it (BRO-4262)', async () => {
  const { sweepHoldReason } = await import('../../scripts/lib/tour-backfill.js').then(m => m.default || m);
  const rows = n => Array.from({ length: n }, () => ({ fromId: 'wicked-2003' }));
  assert.equal(sweepHoldReason(rows(3), ['wicked-2003'], () => 400), null);
  assert.match(sweepHoldReason(rows(21), ['wicked-2003'], () => 400), /cap 20/);
  assert.match(sweepHoldReason(rows(5), ['wicked-2003'], () => 30), /> 10%/);
});
