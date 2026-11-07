// Regression test for card #61 ("Rage clicks on /west-end page, 4 occurrences").
//
// Investigation: the PostHog evidence behind this card is from ~2026-06-29 and
// carries no is_owner/bot-geo filtering (see the card's own Outcome note on
// its P1->P2 reprioritization, 2026-08-15). The card's own suggested approach
// pointed at the homepage CRITICS pattern — and that is exactly the bug that
// was independently found and fixed for /west-end on 2026-08-15 (task #592,
// commits f6f51807cfe + ef91f395e6d3): the SORT row's CRITICS/NEWEST/AUDIENCE/
// A-Z buttons were static labels — clicking an already-active one re-applied
// the same sort with no visible change, which reads as broken and is a
// textbook rage-click trigger. tests/unit/critics-label-interactivity.test.mjs
// already locks the shared toggle-direction logic (src/lib/sort-toggle.js)
// and the ScoreToggle audience-mode sibling bug across all four listing pages.
//
// This file adds the piece that one doesn't cover: that WestEndPageClient's
// actual SORT ToggleBar JSX (the element a user on /west-end clicks) wires
// getNextSort/getSortArrow correctly, not just that the underlying functions
// are correct in isolation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getNextSort, getSortArrow } = require('../../src/lib/sort-toggle');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_PATH = join(ROOT, 'src/components/WestEndPageClient.tsx');

function sortToggleBarBlock() {
  const src = readFileSync(SRC_PATH, 'utf8');
  const start = src.indexOf('label="SORT:"');
  assert.ok(start !== -1, 'SORT ToggleBar not found in WestEndPageClient.tsx');
  const end = src.indexOf('ariaLabel="Sort shows"', start);
  assert.ok(end !== -1, 'end of SORT ToggleBar not found in WestEndPageClient.tsx');
  return src.slice(start, end);
}

describe('/west-end SORT ToggleBar responds visibly to every click', () => {
  const block = sortToggleBarBlock();

  test('onChange advances sort via getNextSort, not a static value', () => {
    assert.match(
      block,
      /onChange=\{\(s\) => updateParams\(\{ sort: getNextSort\(s, sort\) \}\)\}/,
      'clicking a SORT option must call getNextSort so an already-active option reverses direction instead of no-op-ing',
    );
  });

  for (const [label, baseValue] of [
    ['NEWEST', 'recent'],
    ['CRITICS', 'score_desc'],
    ['AUDIENCE', 'audience_buzz'],
    ['A-Z', 'alpha'],
  ]) {
    test(`${label} label renders a direction arrow via getSortArrow('${baseValue}', sort)`, () => {
      const needle = `label: \`${label} \${getSortArrow('${baseValue}', sort)}\``;
      assert.ok(
        block.includes(needle),
        `${label} button must render "${needle}" so an active click is visibly acknowledged (getSortArrow('${baseValue}', sort))`,
      );
    });
  }
});

describe('SORT click simulation on /west-end (no click is ever a visible no-op)', () => {
  test('clicking CRITICS repeatedly toggles direction and the arrow flips every time', () => {
    let sort = 'recent';
    sort = getNextSort('score_desc', sort);
    assert.equal(sort, 'score_desc');
    assert.equal(getSortArrow('score_desc', sort), '↓');

    sort = getNextSort('score_desc', sort);
    assert.equal(sort, 'score_asc');
    assert.equal(getSortArrow('score_desc', sort), '↑');

    sort = getNextSort('score_desc', sort);
    assert.equal(sort, 'score_desc');
    assert.equal(getSortArrow('score_desc', sort), '↓');
  });

  test('switching between SORT options never lands on an unlabeled/ambiguous state', () => {
    for (const base of ['recent', 'score_desc', 'audience_buzz', 'alpha']) {
      const next = getNextSort(base, 'recent_asc');
      assert.equal(next, base, `switching to ${base} from an unrelated toggled sort must land on its base direction`);
      assert.notEqual(getSortArrow(base, next), '', `${base} must show a direction arrow once it is the active sort`);
    }
  });
});
