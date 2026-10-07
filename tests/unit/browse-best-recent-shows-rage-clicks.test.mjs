// Regression test for card #75 ("Rage clicks on /browse/best-recent-shows page").
//
// Investigation: /browse/best-recent-shows renders through the generic
// BrowsePage -> BrowseListClient (src/app/browse/[slug]/page.tsx), which is
// shared by every /browse/[slug] page. For best-recent-shows specifically,
// getAvailableSorts() only offers two buttons: Critics ("score") and A-Z
// ("alpha") — config.sort is 'score' (not 'opening-date'/'performances'), so
// no Newest/Oldest/Closing/Longest options appear.
//
// Before this fix, BrowseListClient wired the SORT ToggleBar's onChange
// straight to setSort: clicking an already-active option (e.g. Critics, the
// page's default sort) re-applied the identical value and re-rendered the
// identical list — no visible change, no arrow, nothing to indicate the
// click did anything. That is the exact no-op-click pattern already fixed on
// /west-end, /off-broadway, /opera, /off-west-end (task #592, via
// src/lib/sort-toggle.js's getNextSort/getSortArrow) — but this shared
// component, used by best-recent-shows and ~30 other /browse/[slug] pages,
// was never migrated to it. A user repeatedly clicking an unresponsive
// "Critics" button is a textbook rage-click trigger.
//
// Fix: BrowseListClient now uses src/lib/sort-toggle.js's createSortToggle()
// factory (own base/toggled pairs — 'score'/'score_asc', 'alpha'/'alpha_desc'
// — separate from the hardcoded TOGGLE_PAIRS other pages use, since sharing a
// toggled-state string like 'score_asc' across two different base values
// would corrupt normalizeSort for both). A second click on Critics or A-Z now
// reverses direction and shows an arrow, matching the already-fixed pages.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createSortToggle } = require('../../src/lib/sort-toggle');
const { compareScore } = require('../../src/lib/browse-sort');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_PATH = join(ROOT, 'src/components/BrowseListClient.tsx');

function sortToggleBarBlock() {
  const src = readFileSync(SRC_PATH, 'utf8');
  const start = src.indexOf('label="Sort:"');
  assert.ok(start !== -1, 'Sort ToggleBar not found in BrowseListClient.tsx');
  const end = src.indexOf('ariaLabel="Sort shows"', start);
  assert.ok(end !== -1, 'end of Sort ToggleBar not found in BrowseListClient.tsx');
  return src.slice(start, end);
}

describe('createSortToggle (generic factory used by BrowseListClient)', () => {
  const { getNextSort, getSortArrow, normalizeSort, isToggleable } = createSortToggle({
    score: 'score_asc',
    alpha: 'alpha_desc',
  });

  test('clicking Critics while inactive selects score (descending)', () => {
    assert.equal(getNextSort('score', 'alpha'), 'score');
  });

  test('clicking Critics while already active reverses to score_asc', () => {
    assert.equal(getNextSort('score', 'score'), 'score_asc');
  });

  test('clicking Critics again from score_asc flips back to score', () => {
    assert.equal(getNextSort('score', 'score_asc'), 'score');
  });

  test('clicking A-Z while already active reverses to alpha_desc (Z-A)', () => {
    assert.equal(getNextSort('alpha', 'alpha'), 'alpha_desc');
  });

  test('non-toggleable sort values (newest/oldest/closing/performances/custom) pass through unchanged', () => {
    for (const v of ['newest', 'oldest', 'closing', 'performances', 'custom']) {
      assert.equal(getNextSort(v, 'score'), v);
      assert.equal(isToggleable(v), false);
    }
  });

  test('getSortArrow shows direction only for the active toggleable button', () => {
    assert.equal(getSortArrow('score', 'score'), '↓');
    assert.equal(getSortArrow('score', 'score_asc'), '↑');
    assert.equal(getSortArrow('score', 'alpha'), '');
    assert.equal(getSortArrow('newest', 'newest'), '', 'non-toggleable base values never show an arrow');
  });

  test('normalizeSort maps a toggled value back to the button it belongs to', () => {
    assert.equal(normalizeSort('score_asc'), 'score');
    assert.equal(normalizeSort('alpha_desc'), 'alpha');
    assert.equal(normalizeSort('newest'), 'newest');
  });

  test('two different factory instances never leak toggled-state strings into each other', () => {
    // Regression guard for the exact bug this factory design avoids: if
    // 'score_asc' were shared in one flat TOGGLE_PAIRS map across two
    // different base values, normalizeSort would resolve to the wrong base.
    const otherToggle = createSortToggle({ recent: 'score_asc' });
    assert.equal(normalizeSort('score_asc'), 'score');
    assert.equal(otherToggle.normalizeSort('score_asc'), 'recent');
  });
});

describe('/browse/[slug] SORT ToggleBar responds visibly to every click (best-recent-shows and siblings)', () => {
  const block = sortToggleBarBlock();

  test('onChange advances sort via sortToggle.getNextSort, not a bare setSort no-op', () => {
    assert.match(
      block,
      /onChange=\{\(s\) => setSort\(sortToggle\.getNextSort\(s, sort\) as SortState\)\}/,
      'clicking a SORT option must call sortToggle.getNextSort so an already-active option (e.g. Critics on best-recent-shows) reverses direction instead of no-op-ing',
    );
  });

  test('the active button is computed via sortToggle.normalizeSort, not the raw (possibly toggled) sort state', () => {
    assert.match(
      block,
      /value=\{sortToggle\.normalizeSort\(sort\) as SortOption\}/,
      'ToggleBar value must normalize score_asc/alpha_desc back to score/alpha so the right button still shows as active',
    );
  });

  test('toggleable labels render a direction arrow via sortToggle.getSortArrow', () => {
    assert.match(
      block,
      /sortToggle\.getSortArrow\(s, sort\)/,
      'Critics/A-Z buttons must render an arrow so a reversing click is visibly acknowledged',
    );
  });
});

describe('SORT click simulation on /browse/best-recent-shows (Critics/A-Z only, no click is ever a visible no-op)', () => {
  const { getNextSort, getSortArrow } = createSortToggle({ score: 'score_asc', alpha: 'alpha_desc' });

  test('repeatedly clicking Critics (the page default) toggles direction and the arrow flips every time', () => {
    let sort = 'score'; // best-recent-shows defaultSort
    sort = getNextSort('score', sort);
    assert.equal(sort, 'score_asc');
    assert.equal(getSortArrow('score', sort), '↑');

    sort = getNextSort('score', sort);
    assert.equal(sort, 'score');
    assert.equal(getSortArrow('score', sort), '↓');
  });

  test('switching from a toggled Critics state to A-Z lands on its base (ascending) direction', () => {
    const next = getNextSort('alpha', 'score_asc');
    assert.equal(next, 'alpha');
    assert.equal(getSortArrow('alpha', next), '↓');
  });
});

// Regression for a real bug caught by adversarial review AFTER the toggle
// above shipped: BrowseListClient represents "TBD / not enough reviews" as a
// null score that must sort last in EVERY direction. A naive `a - b` flip for
// the new ascending (score_asc) branch instead put those shows FIRST once
// Critics became reversible — invisible until you actually reverse the sort.
describe('compareScore (TBD/null scores always sort last, in both directions)', () => {
  test('descending: a real score beats a null (TBD) score', () => {
    assert.ok(compareScore(80, null, false) < 0, 'real score sorts before TBD');
    assert.ok(compareScore(null, 80, false) > 0, 'TBD sorts after a real score');
  });

  test('ascending: TBD must still sort LAST, not first', () => {
    // This is the exact regression: naive `a - b` on a null sentinel would
    // put the TBD show first when ascending, not last.
    assert.ok(compareScore(80, null, true) < 0, 'real score still sorts before TBD when ascending');
    assert.ok(compareScore(null, 80, true) > 0, 'TBD still sorts after a real score when ascending — never promoted to first');
  });

  test('two TBD shows are equal in either direction', () => {
    assert.equal(compareScore(null, null, false), 0);
    assert.equal(compareScore(null, null, true), 0);
  });

  test('two real scores reverse correctly between directions', () => {
    assert.ok(compareScore(90, 70, false) < 0, 'descending: higher score first');
    assert.ok(compareScore(90, 70, true) > 0, 'ascending: lower score first');
  });
});

// Regression for a second issue caught by the same adversarial review: with
// rank badges (#1, #2, ...) visible on ranked browse pages, reversing Critics
// to score_asc would label the LOWEST-scored (or TBD) show "#1" — misleading
// on a page whose whole premise is "ranked by critic score" (best-recent-shows'
// own intro/config promises this). Ranks must be suppressed in that one state.
describe('rank numbers are suppressed in score_asc so "#1" never means "worst" (task #75 follow-up)', () => {
  function browseListClientSrc() {
    return readFileSync(SRC_PATH, 'utf8');
  }

  test('showRankNumbers excludes score_asc, not just showRanks alone', () => {
    const src = browseListClientSrc();
    assert.match(
      src,
      /const showRankNumbers = showRanks && sort !== 'score_asc';/,
      'rank badges must be hidden whenever the reversed Critics sort is active — otherwise the lowest-scored show renders as "#1"',
    );
  });

  test('the rank prop passed to ShowListCard reads from showRankNumbers, not showRanks directly', () => {
    const src = browseListClientSrc();
    assert.match(
      src,
      /rank=\{showRankNumbers \? index \+ 1 : undefined\}/,
      'ShowListCard must receive the score_asc-aware flag, not the raw showRanks prop, or the misleading "#1 = worst" bug reappears',
    );
  });
});
