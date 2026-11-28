// BRO-2507: unit tests for the pure decision logic behind the
// `Validate archive productions` step in .github/workflows/test.yml
// (scripts/validate-archive-productions.js → scripts/lib/archive-productions-validator.js).
// CLAUDE.md §15: require() the real functions, never copy logic here.
// Fixtures only: the script runs in the continue-on-error data-validation job,
// so a data-coupled case here would make it blocking (CLAUDE.md §19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MISMATCH_THRESHOLD,
  getYearFromId,
  validateDtliArchive,
  validateBwwArchive,
  validateShowScoreArchive,
  applyOutcome,
  exceedsMismatchThreshold,
} = require('../../scripts/lib/archive-productions-validator.js');

const LOST_BOYS = { id: 'the-lost-boys-2026', title: 'The Lost Boys', venue: 'Palace Theatre', category: 'broadway' };
const ROCKY = { id: 'the-rocky-horror-show-2026', title: 'The Rocky Horror Show', venue: 'Studio 54', category: 'broadway' };
const LITTLE_WOMEN = {
  id: 'little-women-the-musical-off-broadway-2026', title: 'Little Women', venue: 'X', category: 'off-broadway',
};

const dtli = (title, date, theater) =>
  `<title>${title}</title>Opening Night:&nbsp;<span>${date}</span> Theater: <a href="x">${theater}</a>`;

test('getYearFromId reads a trailing 4-digit year only', () => {
  assert.equal(getYearFromId('our-town-2024'), 2024);
  assert.equal(getYearFromId('our-town'), null);
  assert.equal(getYearFromId('2024-our-town'), null);
});

test('every validator: unknown show → warning only, not counted as checked', () => {
  for (const [fn, source] of [
    [validateDtliArchive, 'dtli'],
    [validateBwwArchive, 'bww'],
    [validateShowScoreArchive, 'show-score'],
  ]) {
    const out = fn('no-such-show-1999', undefined, '<title>x</title>', 'no-such-show-1999.html');
    assert.deepEqual(out, {
      checked: false,
      valid: false,
      mismatches: [],
      warnings: [{ showId: 'no-such-show-1999', source, issue: 'Show not found in shows.json' }],
    });
  }
});

test('DTLI: matching year + theater is valid', () => {
  const out = validateDtliArchive(LOST_BOYS.id, LOST_BOYS, dtli('The Lost Boys', 'April 1, 2026', 'Palace Theatre'), 'f.html');
  assert.equal(out.checked, true);
  assert.equal(out.valid, true);
  assert.deepEqual(out.mismatches, []);
  assert.deepEqual(out.warnings, []);
});

test('DTLI: year off by >1 with a non-confirming title is a blocking mismatch', () => {
  const out = validateDtliArchive(ROCKY.id, ROCKY, dtli('Something Else Entirely', 'October 15, 2000', 'Circle in the Square'), 'rocky.html');
  assert.equal(out.valid, false);
  assert.equal(out.mismatches.length, 1);
  assert.deepEqual(out.mismatches[0], {
    showId: ROCKY.id,
    source: 'dtli',
    file: 'rocky.html',
    expected: { year: 2026, venue: 'Studio 54' },
    found: { year: 2000, theater: 'circle in the square' },
    issue: 'Year mismatch: expected 2026, found 2000',
  });
});

test('DTLI: year mismatch whose <title> confirms the show is downgraded to a warning (#1763)', () => {
  const out = validateDtliArchive(ROCKY.id, ROCKY, dtli('The Rocky Horror Show', 'October 15, 2000', 'Circle in the Square'), 'rocky.html');
  assert.equal(out.checked, true);
  assert.equal(out.valid, false);
  assert.deepEqual(out.mismatches, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0].issue, /^Year mismatch: expected 2026, found 2000 \(title confirms show/);
});

test('DTLI: 1970 epoch placeholder and ±1 year drift are not year mismatches', () => {
  const epoch = validateDtliArchive(ROCKY.id, ROCKY, dtli('Nope', 'January 1, 1970', 'Studio 54'), 'f.html');
  assert.equal(epoch.valid, true);
  const drift = validateDtliArchive(ROCKY.id, ROCKY, dtli('Nope', 'March 1, 2025', 'Studio 54'), 'f.html');
  assert.equal(drift.valid, true);
});

test('DTLI: venue mismatch blocks only when the year also differs', () => {
  const beaches = { id: 'beaches-2026', title: 'Beaches, A New Musical', venue: 'Majestic Theatre' };
  const differentYear = validateDtliArchive(beaches.id, beaches, dtli('Unrelated Page', 'April 1, 2025', 'Lyceum Theatre'), 'b.html');
  assert.equal(differentYear.mismatches.length, 1);
  assert.equal(differentYear.mismatches[0].issue, 'Venue mismatch: expected Majestic Theatre, found lyceum theatre');
  const sameYear = validateDtliArchive(beaches.id, beaches, dtli('Unrelated Page', 'April 1, 2026', 'Lyceum Theatre'), 'b.html');
  assert.equal(sameYear.valid, true);
});

test('BWW: title naming a different production year is a mismatch', () => {
  const out = validateBwwArchive(LOST_BOYS.id, LOST_BOYS, '<title>The Lost Boys Reviews 2011</title> 2011 2012', 'lb.html');
  assert.equal(out.checked, true);
  assert.equal(out.valid, false);
  assert.deepEqual(out.mismatches, [{
    showId: LOST_BOYS.id,
    source: 'bww',
    file: 'lb.html',
    expected: { year: 2026 },
    found: { yearsInPage: [2011, 2012], titleYear: 2011 },
    issue: 'Possible wrong production: title mentions 2011, expected 2026',
  }]);
});

test('BWW: other years only in the body (not the title) are fine', () => {
  const out = validateBwwArchive(LOST_BOYS.id, LOST_BOYS, '<title>The Lost Boys Reviews</title> the 1987 film', 'lb.html');
  assert.equal(out.valid, true);
});

test('BWW: Kennedy Center in title/h1 is a tour/tryout mismatch; sidebar mentions are ignored', () => {
  const title = validateBwwArchive(LOST_BOYS.id, LOST_BOYS, '<title>Lost Boys Kennedy Center</title> 2026', 'lb.html');
  assert.equal(title.mismatches.length, 1);
  assert.equal(title.mismatches[0].issue, 'Page TITLE references Kennedy Center - this is a tour/tryout page, not Broadway');
  assert.deepEqual(title.mismatches[0].found, { title: 'lost boys kennedy center' });
  const h1 = validateBwwArchive(LOST_BOYS.id, LOST_BOYS, '<title>x 2026</title><h1 class="a">At the Kennedy Center</h1>', 'lb.html');
  assert.equal(h1.mismatches.length, 1);
  const sidebar = validateBwwArchive(LOST_BOYS.id, LOST_BOYS, '<title>Lost Boys 2026</title><aside>Kennedy Center ad</aside>', 'lb.html');
  assert.equal(sidebar.valid, true);
  const kennedyShow = { ...LOST_BOYS, venue: 'Kennedy Center Opera House' };
  assert.equal(validateBwwArchive(LOST_BOYS.id, kennedyShow, '<title>Kennedy Center 2026</title>', 'lb.html').valid, true);
});

test('Show Score: off-Broadway canonical on a Broadway show is a mismatch', () => {
  const out = validateShowScoreArchive(LOST_BOYS.id, LOST_BOYS,
    '<link rel="canonical" href="https://www.show-score.com/off-broadway-shows/lost-boys">', 'lb.html');
  assert.equal(out.mismatches.length, 1);
  assert.equal(out.mismatches[0].issue, 'Canonical URL is off-Broadway/off-off-Broadway, but show is Broadway');
  assert.deepEqual(out.mismatches[0].expected, { type: 'Broadway' });
});

test('Show Score: Broadway canonical on an off-Broadway show (detected from the id) is a mismatch', () => {
  const out = validateShowScoreArchive(LITTLE_WOMEN.id, LITTLE_WOMEN,
    '<link rel="canonical" href="https://www.show-score.com/broadway-shows/little-women">', 'lw.html');
  assert.equal(out.mismatches.length, 1);
  assert.equal(out.mismatches[0].issue, 'Canonical URL is Broadway, but show is Off-Broadway');
});

test('Show Score: lowercase shows.json category off-broadway is OB even without an -off-broadway id suffix', () => {
  const ginGame = { id: 'the-gin-game-2026', title: 'The Gin Game', venue: 'X', category: 'off-broadway' };
  const bwCanonical = validateShowScoreArchive(ginGame.id, ginGame,
    '<link rel="canonical" href="https://www.show-score.com/broadway-shows/the-gin-game">', 'g.html');
  assert.equal(bwCanonical.mismatches.length, 1);
  assert.equal(bwCanonical.mismatches[0].issue, 'Canonical URL is Broadway, but show is Off-Broadway');
  const obCanonical = validateShowScoreArchive(ginGame.id, ginGame,
    '<link rel="canonical" href="https://www.show-score.com/off-broadway-shows/the-gin-game">', 'g.html');
  assert.equal(obCanonical.valid, true);
  assert.deepEqual(obCanonical.mismatches, []);
  // legacy capitalised values still work; off-off-broadway too
  for (const category of ['Off-Broadway', 'off-off-broadway']) {
    const out = validateShowScoreArchive(ginGame.id, { ...ginGame, category },
      '<link rel="canonical" href="https://www.show-score.com/broadway-shows/the-gin-game">', 'g.html');
    assert.equal(out.mismatches.length, 1, category);
  }
});

test('Show Score: matching canonical is valid; an "off-broadway" mention warns AND stays valid', () => {
  const ok = validateShowScoreArchive(ROCKY.id, ROCKY,
    '<link rel="canonical" href="https://www.show-score.com/broadway-shows/rocky">', 'r.html');
  assert.deepEqual(ok, { checked: true, valid: true, mismatches: [], warnings: [] });
  const mention = validateShowScoreArchive(ROCKY.id, ROCKY, '<p>an off-broadway transfer</p>', 'r.html');
  assert.equal(mention.valid, true);
  assert.deepEqual(mention.warnings, [{
    showId: ROCKY.id, source: 'show-score', issue: 'Page mentions "off-broadway" - verify this is correct production',
  }]);
});

test('applyOutcome folds outcomes into running totals in order', () => {
  const results = { checked: 0, valid: 0, mismatches: [], warnings: [], errors: [] };
  applyOutcome(results, { checked: true, valid: true, mismatches: [], warnings: [{ w: 1 }] });
  applyOutcome(results, { checked: true, valid: false, mismatches: [{ m: 1 }], warnings: [] });
  applyOutcome(results, { checked: false, valid: false, mismatches: [], warnings: [{ w: 2 }] });
  assert.equal(results.checked, 2);
  assert.equal(results.valid, 1);
  assert.deepEqual(results.mismatches, [{ m: 1 }]);
  assert.deepEqual(results.warnings, [{ w: 1 }, { w: 2 }]);
});

test('exceedsMismatchThreshold fails only strictly above 80', () => {
  assert.equal(MISMATCH_THRESHOLD, 80);
  assert.equal(exceedsMismatchThreshold(80), false);
  assert.equal(exceedsMismatchThreshold(81), true);
  assert.equal(exceedsMismatchThreshold(0), false);
});

test('Show Score: an "off-broadway" mention on an OB show is expected, not a warning (BRO-5261)', () => {
  const ob = { id: 'the-gin-game-2026', category: 'off-broadway' };
  const r = validateShowScoreArchive(ob.id, ob, '<p>the Off-Broadway revival</p>', 'g.html');
  assert.equal(r.valid, true);
  assert.deepEqual(r.warnings, []);
});
