// Regression test for task #592: the CRITICS sort label on /off-broadway (and
// the same ToggleBar pattern on /west-end, /opera, /off-west-end) was a static
// button — clicking it while already active did nothing visible, which read
// as broken/rage-click bait. Locks in the shared toggle-direction logic those
// pages now use (src/lib/sort-toggle.js), the same mapping the homepage's
// already-working CRITICS ↑/↓ button relies on.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getNextSort, getSortArrow, normalizeSort, isToggleable } = require('../../src/lib/sort-toggle');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('getNextSort', () => {
  test('clicking CRITICS while inactive selects descending (score_desc)', () => {
    assert.equal(getNextSort('score_desc', 'recent'), 'score_desc');
  });

  test('clicking CRITICS while already active reverses to ascending', () => {
    assert.equal(getNextSort('score_desc', 'score_desc'), 'score_asc');
  });

  test('clicking CRITICS while ascending flips back to descending', () => {
    assert.equal(getNextSort('score_desc', 'score_asc'), 'score_desc');
  });

  test('clicking a different toggleable option resets to its base direction', () => {
    assert.equal(getNextSort('audience_buzz', 'audience_asc'), 'audience_buzz');
  });

  test('non-toggleable values pass through unchanged', () => {
    assert.equal(getNextSort('unknown_value', 'score_desc'), 'unknown_value');
  });
});

describe('getSortArrow', () => {
  test('shows ↓ when the base (descending) direction is active', () => {
    assert.equal(getSortArrow('score_desc', 'score_desc'), '↓');
  });

  test('shows ↑ when the toggled (ascending) direction is active', () => {
    assert.equal(getSortArrow('score_desc', 'score_asc'), '↑');
  });

  test('shows no arrow when this option is not the active sort', () => {
    assert.equal(getSortArrow('score_desc', 'recent'), '');
    assert.equal(getSortArrow('score_desc', 'audience_buzz'), '');
  });

  test('non-toggleable base values never show an arrow', () => {
    assert.equal(getSortArrow('unknown_base', 'unknown_base'), '');
  });
});

describe('normalizeSort', () => {
  test('maps a toggled value back to its base for active-button comparison', () => {
    assert.equal(normalizeSort('score_asc'), 'score_desc');
    assert.equal(normalizeSort('recent_asc'), 'recent');
    assert.equal(normalizeSort('alpha_desc'), 'alpha');
    assert.equal(normalizeSort('audience_asc'), 'audience_buzz');
  });

  test('base and unknown values pass through unchanged', () => {
    assert.equal(normalizeSort('score_desc'), 'score_desc');
    assert.equal(normalizeSort('unknown'), 'unknown');
  });
});

describe('isToggleable', () => {
  test('all four listing-page sort options are toggleable', () => {
    assert.ok(isToggleable('recent'));
    assert.ok(isToggleable('score_desc'));
    assert.ok(isToggleable('alpha'));
    assert.ok(isToggleable('audience_buzz'));
  });

  test('toggled/unknown values are not themselves toggleable', () => {
    assert.equal(isToggleable('score_asc'), false);
    assert.equal(isToggleable('unknown'), false);
  });
});

describe('round trip (simulates repeated clicks on one button)', () => {
  test('clicking CRITICS repeatedly cycles desc -> asc -> desc, never a no-op', () => {
    let sort = 'recent';
    sort = getNextSort('score_desc', sort);
    assert.equal(sort, 'score_desc');
    sort = getNextSort('score_desc', sort);
    assert.equal(sort, 'score_asc');
    sort = getNextSort('score_desc', sort);
    assert.equal(sort, 'score_desc');
  });
});

// Sibling of the CRITICS no-op bug, found during ship-check: switching Score
// Mode to audience on /off-broadway, /west-end, /off-west-end forced
// sort:'score_desc' — whose audience-mode branch already sorts by audience
// score — so the CRITICS button rendered as active (with a ↓ arrow after this
// fix) while the list was actually audience-sorted and AUDIENCE sat inert.
// Homepage already avoids this by landing on sort:'audience_buzz' instead
// (task #30). Guards the same fix on the three pages that shared the bug.
describe('ScoreToggle audience-mode sort lands on AUDIENCE, not CRITICS', () => {
  const PAGES = [
    'src/components/OffBroadwayPageClient.tsx',
    'src/components/WestEndPageClient.tsx',
    'src/components/OffWestEndPageClient.tsx',
  ];

  for (const relPath of PAGES) {
    test(`${relPath}: switching to audience scoreMode sets sort to audience_buzz`, () => {
      const src = readFileSync(join(ROOT, relPath), 'utf8');
      const scoreToggleStart = src.indexOf('<ScoreToggle');
      assert.ok(scoreToggleStart !== -1, `ScoreToggle usage not found in ${relPath}`);
      const scoreToggleEnd = src.indexOf('className="flex-shrink-0"', scoreToggleStart);
      assert.ok(scoreToggleEnd !== -1, `end of ScoreToggle usage not found in ${relPath}`);
      const block = src.slice(scoreToggleStart, scoreToggleEnd);

      assert.match(
        block,
        /updateParams\(\{ scoreMode: key, sort: 'audience_buzz' \}\)/,
        `${relPath}: switching to audience scoreMode must set sort:'audience_buzz' so AUDIENCE (not CRITICS) shows as active`,
      );
      assert.doesNotMatch(
        block,
        /updateParams\(\{ scoreMode: key, sort: 'score_desc' \}\)/,
        `${relPath}: must not force sort:'score_desc' on audience mode — that branch already sorts by audience score while CRITICS renders active`,
      );
    });
  }
});
