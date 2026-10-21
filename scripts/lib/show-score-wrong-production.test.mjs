// BRO-5866: removing what a wrong-production Show Score page put on a show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { removeWrongProductionShowScore, findWrongProductionMappings, planWrongProductionPurge, applyWrongProductionPurge } = require('./show-score-wrong-production.js');
const { isProductionMismatch, recordProductionMismatch } = require('./show-score-url-map.js');

const WRONG = 'https://www.show-score.com/off-broadway-shows/safe-house';
const show = { id: 'safe-house-off-broadway-2026', previewsStartDate: '2026-09-04', openingDate: '2026-09-18', venue: 'Theatre Row', status: 'open', category: 'off-broadway' };
const showsById = { [show.id]: show };
const stAnnsCritics = ['February 21st, 2025', 'February 24th, 2025', 'February 25th, 2025'].map((date) => ({ date }));

function fixture() {
  return {
    urlData: { shows: { [show.id]: WRONG } },
    showScoreData: { _meta: {}, shows: { [show.id]: { criticReviews: stAnnsCritics } } },
    audienceBuzz: { shows: { [show.id]: { combinedScore: 63.68, designation: 'Disliking', sources: { showScore: { score: 63, reviewCount: 17 }, mezzanine: { score: 66, reviewCount: 5 } } } } },
  };
}

test('sweep finds the Safe House mapping from show-score.json critic dates', () => {
  const f = fixture();
  const hits = findWrongProductionMappings({ urlMap: f.urlData.shows, showScoreData: f.showScoreData, showsById });
  assert.deepEqual(hits.map((h) => h.showId), [show.id]);
});

test('sweep trusts the extractor\'s recorded rejection for the same URL', () => {
  const hits = findWrongProductionMappings({
    urlMap: { [show.id]: `${WRONG}/` },
    showScoreData: { _meta: { wrongProduction: { [show.id]: { url: WRONG, reason: 'r' } } }, shows: {} },
    showsById,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].evidence, 'extractor rejection');
});

test('remove drops mapping, critics and audience score, tombstones and recomputes', () => {
  const f = fixture();
  const r = removeWrongProductionShowScore({ showId: show.id, url: WRONG, ...f, show });
  assert.deepEqual([r.mappingRemoved, r.criticsRemoved, r.audienceRemoved], [true, true, true]);
  assert.equal(f.urlData.shows[show.id], undefined);
  assert.equal(isProductionMismatch(f.urlData, show.id, WRONG), true);
  assert.equal(f.showScoreData.shows[show.id], undefined);
  const rec = f.audienceBuzz.shows[show.id];
  assert.equal(rec.sources.showScore, undefined);
  assert.match(rec.sourcesRemoved.showScore, /BRO-5866/);
  assert.notEqual(rec.combinedScore, 63.68);
});

test('a show remapped to the right page since keeps its data', () => {
  const f = fixture();
  f.urlData.shows[show.id] = 'https://www.show-score.com/off-broadway-shows/safe-house-theatre-row';
  const r = removeWrongProductionShowScore({ showId: show.id, url: WRONG, ...f, show });
  assert.deepEqual([r.mappingRemoved, r.criticsRemoved, r.audienceRemoved], [false, false, false]);
  assert.ok(f.audienceBuzz.shows[show.id].sources.showScore);
});

test('recordProductionMismatch dedupes by normalized URL and keeps several pages', () => {
  const u = {};
  recordProductionMismatch(u, 'x', WRONG);
  recordProductionMismatch(u, 'x', `${WRONG}/`);
  assert.equal(u._productionMismatch.x, WRONG);
  recordProductionMismatch(u, 'x', `${WRONG}-2`);
  assert.deepEqual(u._productionMismatch.x, [WRONG, `${WRONG}-2`]);
  assert.equal(isProductionMismatch(u, 'x', `${WRONG}-2`), true);
  assert.equal(isProductionMismatch(u, 'y', WRONG), false);
});

test('purge plan picks up recorded mismatches once the public mapping is gone (CI apply path)', () => {
  const f = fixture();
  // The PR already removed the mapping and show-score.json entry; only private buzz is left.
  f.urlData = { shows: {}, _productionMismatch: { [show.id]: WRONG } };
  f.showScoreData = { _meta: {}, shows: {} };
  const plan = planWrongProductionPurge({ ...f, showsById });
  assert.deepEqual(plan.map((p) => p.showId), [show.id]);
  const done = applyWrongProductionPurge(plan, { ...f, showsById });
  assert.equal(done[0].audienceRemoved, true);
  // Second run: nothing left to do.
  assert.equal(planWrongProductionPurge({ ...f, showsById }).length, 0);
});

test('a mismatch record lapses after the recheck window (remounts reuse the page)', () => {
  const u = {};
  const day = 24 * 60 * 60 * 1000;
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  recordProductionMismatch(u, 'x', WRONG, t0);
  assert.equal(u._productionMismatchAt.x, '2026-10-01');
  assert.equal(isProductionMismatch(u, 'x', WRONG, t0 + 29 * day), true);
  assert.equal(isProductionMismatch(u, 'x', WRONG, t0 + 31 * day), false);
  // Found wrong again: the record is refreshed, not duplicated.
  recordProductionMismatch(u, 'x', `${WRONG}/`, t0 + 31 * day);
  assert.equal(u._productionMismatch.x, WRONG);
  assert.equal(isProductionMismatch(u, 'x', WRONG, t0 + 32 * day), true);
});

test('a recorded page mapped again and now in-window is not purged', () => {
  const f = fixture();
  f.urlData = { shows: { [show.id]: WRONG }, _productionMismatch: { [show.id]: WRONG } };
  f.showScoreData = { _meta: {}, shows: { [show.id]: { criticReviews: ['Sep 20, 2026', 'Sep 21, 2026', 'Sep 22, 2026'].map((date) => ({ date })) } } };
  assert.equal(planWrongProductionPurge({ ...f, showsById }).length, 0);
});

test('sweep also judges show-score.json entries that have no mapping', () => {
  const hits = findWrongProductionMappings({
    urlMap: {},
    showScoreData: { _meta: {}, shows: { [show.id]: { showScoreUrl: WRONG, criticReviews: stAnnsCritics } } },
    showsById,
  });
  assert.deepEqual(hits.map((h) => [h.showId, h.evidence]), [[show.id, 'unmapped show-score.json entry']]);
});

test('an unmapped entry that kept no URL is found and removed', () => {
  const f = fixture();
  f.urlData = { shows: {} };
  f.showScoreData = { _meta: {}, shows: { [show.id]: { showScoreUrl: null, criticReviews: stAnnsCritics } } };
  const plan = planWrongProductionPurge({ ...f, showsById });
  assert.deepEqual(plan.map((p) => [p.showId, p.url]), [[show.id, null]]);
  const [done] = applyWrongProductionPurge(plan, { ...f, showsById });
  assert.deepEqual([done.criticsRemoved, done.audienceRemoved], [true, true]);
  assert.equal(f.urlData._productionMismatch, undefined);
});

test('a lapsed record is reported as awaiting re-check; a fresh one is not', async () => {
  const { isLapsedProductionMismatch } = require('./show-score-url-map.js');
  const day = 24 * 60 * 60 * 1000;
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const u = {};
  recordProductionMismatch(u, 'x', WRONG, t0);
  assert.equal(isLapsedProductionMismatch(u, 'x', `${WRONG}/`, t0 + 5 * day), false);
  assert.equal(isLapsedProductionMismatch(u, 'x', `${WRONG}/`, t0 + 31 * day), true);
  // An unreadable day lapses instead of blocking for good.
  u._productionMismatchAt.x = 'garbage';
  assert.equal(isProductionMismatch(u, 'x', WRONG, t0), false);
});
