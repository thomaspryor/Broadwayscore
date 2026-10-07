import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  contaminationAllowFields,
  contaminationKindForQueueReason,
  contaminationKindsNeeded,
} = require('./contamination-allow-signal.js');
const { explainExclusion } = require('./review-guards.js');

const PAD = ' The cast is terrific and the staging inventive throughout the evening.'.repeat(20);
// almost-famous-2022 nyt-theater shape: "on tour" is the band in the story.
const TOUR_INTRO = 'The “world’s greatest rock critic” offers some advice to William Miller, a friendless, precocious 15-year-old who has just lucked into an assignment from Rolling Stone magazine to accompany an up-and-coming rock band on tour. “Don’t make friends with rock stars,” Lester Bangs advises William.' + PAD;

function rec(fullText, over = {}) {
  return { showId: 'almost-famous-2022', outletId: 'nyt-theater', fullText, contentTier: 'complete', textFetchedAt: '2026-05-01T00:00:00Z', ...over };
}
const SHOW = { id: 'almost-famous-2022', title: 'Almost Famous', status: 'closed', type: 'musical', openingDate: '2022-11-03', venue: 'Bernard B. Jacobs Theatre' };

test('queue reason → kind', () => {
  assert.equal(contaminationKindForQueueReason('possible-tour-fulltext'), 'tour');
  assert.equal(contaminationKindForQueueReason('possible-film-tv-fulltext'), 'film');
  assert.equal(contaminationKindForQueueReason('low-confidence'), null);
});

test('allow fields match the flags the guards read', () => {
  assert.deepEqual(contaminationAllowFields('tour', 'r'), { allowTourSignal: true, allowTourSignalReason: 'r' });
  assert.deepEqual(contaminationAllowFields('film', 'r'), { allowFilmSignal: true, allowFilmSignalReason: 'r' });
  assert.deepEqual(contaminationAllowFields(null, 'r'), {});
});

test('tour false positive: excluded before, included once the allow flag is set', () => {
  const d = rec(TOUR_INTRO);
  const before = explainExclusion(d, SHOW);
  assert.equal(before, 'tourContaminationInText');
  const kinds = contaminationKindsNeeded(d, SHOW);
  assert.deepEqual(kinds, ['tour']);
  for (const k of kinds) Object.assign(d, contaminationAllowFields(k, 'adjudicated legit'));
  assert.equal(explainExclusion(d, SHOW), null);
  assert.deepEqual(contaminationKindsNeeded(d, SHOW), [], 'idempotent once set');
});

test('clean text needs no flag', () => {
  assert.deepEqual(contaminationKindsNeeded(rec('A lovely evening at the theatre.' + PAD), SHOW), []);
  assert.deepEqual(contaminationKindsNeeded({}, SHOW), []);
});

// ---- ship-check round 2 (P1-3) ----
const { applyContaminationAllow, pickContaminationAllowKind } = require('./contamination-allow-signal.js');

const FILM_TOUR_INTRO = 'The film adaptation, now streaming on Netflix, follows a precocious 15-year-old who has just lucked into an assignment from Rolling Stone magazine to accompany an up-and-coming rock band on tour.' + PAD;

test('only one allow flag: both detectors firing grants none', () => {
  const d = rec(FILM_TOUR_INTRO);
  const pick = pickContaminationAllowKind(d, SHOW);
  if (pick.ambiguous) {
    assert.equal(pick.kind, null);
  } else {
    // Fixture sanity: this intro must trip both detectors, or the test proves nothing.
    assert.fail(`fixture did not trip both detectors: ${JSON.stringify(pick)}`);
  }
  assert.deepEqual(pickContaminationAllowKind(rec(TOUR_INTRO), SHOW), { kind: 'tour', ambiguous: false });
});

test('overwriting allow* reasons records the previous values', () => {
  const d = { allowTourSignal: true, allowTourSignalReason: 'human: band tour in the plot' };
  applyContaminationAllow(d, 'tour', 'backfill: adjudicated', '2026-09-29T00:00:00Z');
  assert.equal(d.allowTourSignalReason, 'backfill: adjudicated');
  assert.deepEqual(d.allowSignalHistory, [{ replacedAt: '2026-09-29T00:00:00Z', allowTourSignalReason: 'human: band tour in the plot' }]);
  const fresh = {};
  applyContaminationAllow(fresh, 'film', 'r', 'x');
  assert.equal(fresh.allowSignalHistory, undefined, 'nothing overwritten → no history');
  assert.equal(applyContaminationAllow({}, null, 'r'), false);
});
