// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * BRO-6886: a press-night review with no stars must get a scoring run the
 * moment it is pushed, not when the pushing workflow finishes.
 *
 * Replays Clifford Odets' Waiting for Lefty (2026-11-02): at 04:12Z the
 * outlet-serp push carried nysr--roma-torre.json (3/5 stars, scored without
 * the LLM) and nytg--gillian-russo.json (no stars, needs the LLM). Only the
 * NYTG review must trigger a dispatch.
 *
 * Run: node --test tests/unit/press-night-scoring-dispatch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../../scripts/lib/press-night-scoring-dispatch.js');
const { isScoreableSurvivor, hasValidScore, isDispatchActionable } = require('../../scripts/verify-all-scored.js');
const predicates = { isScoreableSurvivor, hasValidScore, isDispatchActionable };

const NOW = new Date('2026-11-03T04:12:58Z');
const SHOW = {
  id: 'clifford-odets-waiting-for-lefty-off-broadway-2026',
  title: 'Clifford Odets’ Waiting for Lefty',
  category: 'off-broadway',
  status: 'previews',
  openingDate: '2026-11-02',
};
const OLD_SHOW = { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', status: 'open', openingDate: '2015-08-06' };

const body = (n) => ('The production stages Odets with fervor and the ensemble commits fully to the strike meeting. ').repeat(n);
const NYTG = {
  showId: SHOW.id, outletId: 'nytg', outlet: 'New York Theatre Guide', criticName: 'Gillian Russo',
  url: 'https://www.newyorktheatreguide.com/reviews/waiting-for-lefty-off-broadway-review',
  showTitle: SHOW.title, contentTier: 'complete', publishDate: '2026-11-02',
  fullText: `Waiting for Lefty review. ${body(60)}`,
};
const NYSR = {
  showId: SHOW.id, outletId: 'nysr', outlet: 'New York Stage Review', criticName: 'Roma Torre',
  url: 'https://nystagereview.com/2026/11/02/waiting-for-lefty-the-play-has-aged-the-injustice-has-not/',
  showTitle: SHOW.title, contentTier: 'complete', publishDate: '2026-11-02',
  fullText: `Waiting for Lefty ★★★☆☆ ${body(40)}`,
  originalScore: '3/5 stars', originalScoreNormalized: 60,
};

function run(files, store, shows = [SHOW, OLD_SHOW]) {
  return lib.selectShowsNeedingScoring({
    changed: lib.parseChangedFiles(files),
    shows,
    now: NOW,
    evidence: null,
    reviewTextsDir: '/nonexistent/review-texts',
    readReview: (showId, file) => store[`${showId}/${file}`] || null,
    predicates,
  });
}

test('incident replay: unstarred NYTG review dispatches, starred NYSR does not', () => {
  const store = {
    [`${SHOW.id}/nytg--gillian-russo.json`]: NYTG,
    [`${SHOW.id}/nysr--roma-torre.json`]: NYSR,
  };
  const out = run([`${SHOW.id}/nysr--roma-torre.json`, `${SHOW.id}/nytg--gillian-russo.json`], store);
  assert.deepEqual(out, [{ showId: SHOW.id, files: ['nytg--gillian-russo.json'] }]);
});

test('already LLM-scored review does not dispatch', () => {
  const scored = { ...NYTG, llmScore: { score: 66 } };
  const out = run([`${SHOW.id}/nytg--gillian-russo.json`], { [`${SHOW.id}/nytg--gillian-russo.json`]: scored });
  assert.deepEqual(out, []);
});

test('show far from its opening night does not dispatch (routine work waits for batch)', () => {
  const old = { ...NYTG, showId: OLD_SHOW.id, showTitle: 'Hamilton', fullText: `Hamilton review. ${body(60)}` };
  const out = run([`${OLD_SHOW.id}/nytg--gillian-russo.json`], { [`${OLD_SHOW.id}/nytg--gillian-russo.json`]: old });
  assert.deepEqual(out, []);
});

test('excluded review (wrongProduction) does not dispatch', () => {
  const bad = { ...NYTG, wrongProduction: true };
  const out = run([`${SHOW.id}/nytg--gillian-russo.json`], { [`${SHOW.id}/nytg--gillian-russo.json`]: bad });
  assert.deepEqual(out, []);
});

test('only files this push carried are considered', () => {
  const store = { [`${SHOW.id}/nytg--gillian-russo.json`]: NYTG };
  assert.deepEqual(run([`${SHOW.id}/nysr--roma-torre.json`], store), []);
});

test('parseChangedFiles keeps show/file.json only, deduped', () => {
  assert.deepEqual(
    lib.parseChangedFiles(['a/b.json', 'a/b.json', 'a/failed-fetches.json', 'a/_blocklist.json', 'a/_ingest-rejections.json', 'README.md', 'x.json', 'a/b/c.json', '', ' c/d.json ']),
    [{ showId: 'a', file: 'b.json' }, { showId: 'c', file: 'd.json' }],
  );
});

test('showIdsFromRunTitle: exact ids, multi-show, no title suffix', () => {
  assert.deepEqual(lib.showIdsFromRunTitle('LLM Ensemble Score Reviews — foo-2,bar'), ['foo-2', 'bar']);
  assert.deepEqual(lib.showIdsFromRunTitle('LLM Ensemble Score Reviews'), []);
  assert.deepEqual(lib.showIdsFromRunTitle(undefined), []);
});

test('hourly cap: 4 recent runs naming a show stop re-dispatch; old, substring and queued-other runs do not count', () => {
  const now = new Date('2026-11-03T05:00:00Z');
  const selected = [{ showId: 'foo', files: ['x.json'] }, { showId: 'bar', files: ['y.json'] }];
  const at = (min) => new Date(now.getTime() - min * 60000).toISOString();
  const runs = [
    ...[5, 15, 25, 35].map((m) => ({ created_at: at(m), display_title: 'LLM Ensemble Score Reviews — bar' })),
    { created_at: at(5), display_title: 'LLM Ensemble Score Reviews — foo-2' }, // substring only
    { created_at: at(5), display_title: 'LLM Ensemble Score Reviews — foo' },
    { created_at: at(10), display_title: 'LLM Ensemble Score Reviews — foo' },
    { created_at: at(15), display_title: 'LLM Ensemble Score Reviews — foo,baz' },
    { created_at: at(90), display_title: 'LLM Ensemble Score Reviews — foo' }, // outside the hour
    { created_at: at(3), display_title: 'LLM Ensemble Score Reviews' }, // unscoped batch run
  ];
  const { dispatch, capped } = lib.capRecentDispatches(selected, runs, { now });
  assert.deepEqual(dispatch.map((s) => s.showId), ['foo']);
  assert.deepEqual(capped.map((s) => s.showId), ['bar']);
  assert.equal(lib.MAX_RUNS_PER_HOUR, 4);
  assert.deepEqual(lib.capRecentDispatches(selected, [], { now }).dispatch.length, 2, 'no run list = no cap (fail open)');
});
