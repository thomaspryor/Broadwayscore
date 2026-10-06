/**
 * BRO-2023: discover-new-shows.js's title cross-reference detected a revival
 * whenever a new show's title matched ANY existing shows.json entry,
 * regardless of market — a same-title West End production transferring to
 * Broadway (Inter Alia 2026) got flagged isRevival:true solely because the
 * West End entry already existed. Fixed 2026-08-14 by requiring a
 * same-market match; this test locks that fix against regression using the
 * REAL function (extracted here from discover-new-shows.js so it's testable
 * in isolation, CLAUDE.md §15) rather than a re-implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeRevivalTitle, buildExistingTitleMap, detectRevivalByTitleCrossReference,
  writersConflict, describesNewWork, shouldAcceptIbdbRevival,
} = require('../../scripts/lib/revival-cross-reference.js');

test('normalizeRevivalTitle strips leading article + punctuation, case-folds', () => {
  assert.equal(normalizeRevivalTitle('The Seagull'), 'seagull');
  assert.equal(normalizeRevivalTitle("Schmigadoon!"), 'schmigadoon');
});

test('normalizeRevivalTitle folds diacritics before stripping non-ASCII (sibling-matchers guard)', () => {
  // foldDiacritics must run BEFORE the [^a-z0-9' ] strip, or an accented
  // title loses its accented letters entirely instead of folding to ASCII —
  // caught by tests/unit/sibling-matchers-diacritics.test.mjs when this file
  // was first extracted (it copied the unfolded original verbatim).
  assert.equal(normalizeRevivalTitle('Amélie'), 'amelie');
  const map = buildExistingTitleMap([{ title: 'Amelie', id: 'amelie-2017', type: 'musical', category: 'broadway' }]);
  const result = detectRevivalByTitleCrossReference({ title: 'Amélie', id: 'amelie-2030', category: 'broadway' }, map);
  assert.equal(result.isRevival, true);
});

test('buildExistingTitleMap skips very short titles', () => {
  const map = buildExistingTitleMap([{ title: 'Art', id: 'art-1998', type: 'play', category: null }]);
  assert.equal(map.size, 0);
});

test('a same-title WE->BW transfer does NOT set isRevival (Inter Alia)', () => {
  const existing = [
    { title: 'Inter Alia', id: 'inter-alia-london-2025', type: 'play', category: 'west-end' },
  ];
  const map = buildExistingTitleMap(existing);
  const newShow = { title: 'Inter Alia', id: 'inter-alia-broadway-2026', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, false);
  assert.equal(result.isTransfer, true);
});

test('a same-title, same-market match IS a revival (same-market evidence)', () => {
  const existing = [
    { title: 'Chicago', id: 'chicago-1996', type: 'musical', category: null }, // legacy Broadway = null category
  ];
  const map = buildExistingTitleMap(existing);
  const newShow = { title: 'Chicago', id: 'chicago-2030', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, true);
  assert.equal(result.confidence, 'high');
  assert.equal(result.detectedType, 'musical');
});

test('legacy null-category Broadway entry vs explicit "broadway" string still matches as same-market', () => {
  // isBroadwayCategory folds absent/null/'broadway' together — a match against
  // a legacy null-category entry must not be misread as cross-market (2026-08-14 review).
  const existing = [{ title: 'Gutenberg! The Musical', id: 'gutenberg-2023', type: 'musical', category: null }];
  const map = buildExistingTitleMap(existing);
  const newShow = { title: 'Gutenberg! The Musical', id: 'gutenberg-2030', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, true);
  assert.equal(result.isTransfer, false);
});

test('no match at all → neither revival nor transfer', () => {
  const map = buildExistingTitleMap([{ title: 'Some Other Show', id: 'x-2020', type: 'play', category: 'broadway' }]);
  const newShow = { title: 'A Brand New Play', id: 'y-2026', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, false);
  assert.equal(result.isTransfer, false);
  assert.equal(result.match, null);
});

test('a same-market prior production is found even when a cross-market entry has the same title (ship-check finding)', () => {
  // buildExistingTitleMap used to keep only the FIRST same-titled entry — if
  // that first one happened to be cross-market, a real same-market prior
  // production later in the list was shadowed and misread as a transfer.
  const existing = [
    { title: 'Network', id: 'network-london-2017', type: 'play', category: 'west-end' }, // seen first
    { title: 'Network', id: 'network-1958', type: 'play', category: null }, // real Broadway prior production
  ];
  const map = buildExistingTitleMap(existing);
  const newShow = { title: 'Network', id: 'network-2030', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, true);
  assert.equal(result.isTransfer, false);
  assert.equal(result.match.id, 'network-1958');
});

test('matching against itself (same id already in the map) is not a match', () => {
  const existing = [{ title: 'Gloria', id: 'gloria-2026', type: 'play', category: 'broadway' }];
  const map = buildExistingTitleMap(existing);
  const result = detectRevivalByTitleCrossReference({ title: 'Gloria', id: 'gloria-2026', category: 'broadway' }, map);
  assert.equal(result.isRevival, false);
  assert.equal(result.isTransfer, false);
});

// --- Wiring lock: discover-new-shows.js must call the real function ---
test('discover-new-shows.js calls the extracted cross-reference detector', () => {
  const src = require('fs').readFileSync(
    require('path').join(import.meta.dirname, '..', '..', 'scripts/discover-new-shows.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/revival-cross-reference['"]\)/);
  assert.match(src, /detectRevivalByTitleCrossReference\(show, existingTitleMap\)/);
});

// Soon 2026 (Off-Broadway, Nick Blaemire) was flagged a revival of the
// unrelated 1971 Broadway "Soon" because the two only share a title.
const SOON_1971 = {
  id: 'soon-1971', title: 'Soon', type: 'musical', category: 'broadway',
  creativeTeam: [
    { name: 'Martin Duberman', role: 'Book' },
    { name: 'Scott Fagan and J. M. Kookoolis', role: 'Lyrics' },
    { name: 'J. M. Kookoolis and Scott Fagan', role: 'Music' },
    { name: 'Jules Fisher', role: 'Lighting Design' },
  ],
};

test('same title, new show describes itself as a new musical: not a revival (Soon 2026)', () => {
  const map = buildExistingTitleMap([SOON_1971]);
  // category-less on purpose: reads as the same market as the 1971 entry
  const r = detectRevivalByTitleCrossReference(
    { id: 'soon-off-broadway-2026', title: 'Soon', description: 'Soon is a new indie pop musical about a young woman\'s anxiety.' }, map);
  assert.equal(r.isRevival, false);
  assert.equal(r.rejected, 'title-collision');
});

test('same title, disjoint writers: not a revival', () => {
  const map = buildExistingTitleMap([SOON_1971]);
  const r = detectRevivalByTitleCrossReference(
    { id: 'x', title: 'Soon', creativeTeam: [{ name: 'Nick Blaemire', role: 'Book, Music & Lyrics' }] }, map);
  assert.equal(r.isRevival, false);
});

test('same title, shared writer: still a revival', () => {
  const map = buildExistingTitleMap([SOON_1971]);
  const r = detectRevivalByTitleCrossReference(
    { id: 'x', title: 'Soon', creativeTeam: [{ name: 'Scott Fagan', role: 'Music' }] }, map);
  assert.equal(r.isRevival, true);
});

test('same title, no creators and no new-work copy: still a revival (genuine revivals keep working)', () => {
  const map = buildExistingTitleMap([SOON_1971]);
  const r = detectRevivalByTitleCrossReference({ id: 'x', title: 'Soon', description: 'A bold new production of the cult classic.' }, map);
  assert.equal(r.isRevival, true);
});

test('writersConflict: unknown on either side is not a conflict; designers do not count', () => {
  assert.equal(writersConflict([], SOON_1971.creativeTeam), false);
  assert.equal(writersConflict([{ name: 'Jules Fisher', role: 'Lighting Design' }], SOON_1971.creativeTeam), false);
  assert.equal(writersConflict([{ name: 'Nick Blaemire', role: 'Music' }], SOON_1971.creativeTeam), true);
  // music direction is not authorship
  assert.equal(writersConflict([{ name: 'Rob Mathes', role: 'Music Direction' }], SOON_1971.creativeTeam), false);
});

test('revised book writer on a revival is not a conflict (The Last Ship 2026)', () => {
  const lastShip2014 = { id: 'the-last-ship-2014', title: 'The Last Ship', type: 'musical', category: 'broadway',
    creativeTeam: [{ name: 'John Logan', role: 'Book' }, { name: 'Brian Yorkey', role: 'Book' }, { name: 'Sting', role: 'Music & Lyrics' }] };
  const map = buildExistingTitleMap([lastShip2014]);
  const r = detectRevivalByTitleCrossReference(
    { id: 'the-last-ship-off-broadway-2026', title: 'The Last Ship', category: 'broadway', creativeTeam: [{ name: 'Joe DiPietro', role: 'Book Writer' }] }, map);
  assert.equal(r.isRevival, true);
});

test('describesNewWork: "revival" in the copy cancels the new-work phrase', () => {
  assert.equal(describesNewWork({ description: 'The world premiere of a new musical' }), true);
  assert.equal(describesNewWork({ description: 'A revival of the new musical that thrilled 1999' }), false);
  assert.equal(describesNewWork({ description: 'A bold new production' }), false);
});

test('a genuine same-author prior production is still found behind an unrelated same-title one', () => {
  const earlierSoon = { id: 'soon-off-broadway-2019', title: 'Soon', type: 'musical', category: 'off-broadway',
    creativeTeam: [{ name: 'Nick Blaemire', role: 'Music & Lyrics' }] };
  const map = buildExistingTitleMap([SOON_1971, earlierSoon]);
  const r = detectRevivalByTitleCrossReference(
    { id: 'soon-off-broadway-2026', title: 'Soon', category: 'off-broadway', creativeTeam: [{ name: 'Nick Blaemire', role: 'Music & Lyrics' }] }, map);
  assert.equal(r.isRevival, true);
  assert.equal(r.match.id, 'soon-off-broadway-2019');
});

test('a rejected cross-market collision keeps the transfer signal', () => {
  const map = buildExistingTitleMap([{ ...SOON_1971, category: 'west-end' }]);
  const r = detectRevivalByTitleCrossReference(
    { id: 'x', title: 'Soon', category: 'off-broadway', creativeTeam: [{ name: 'Nick Blaemire', role: 'Music' }] }, map);
  assert.equal(r.isRevival, false);
  assert.equal(r.isTransfer, true);
});

test('combined authorship roles still count ("Writer/Director", "Music & Lyrics, Music Director")', () => {
  assert.equal(writersConflict([{ name: 'Nick Blaemire', role: 'Music & Lyrics, Music Director' }], SOON_1971.creativeTeam), true);
  assert.equal(writersConflict([{ name: 'Scott Fagan', role: 'Music & Lyrics, Music Director' }], SOON_1971.creativeTeam), false);
  assert.equal(writersConflict([{ name: 'Ann Lee', role: 'Writer/Director' }], [{ name: 'Bo Chan', role: 'Playwright' }]), true);
});

test('shouldAcceptIbdbRevival (discover Stage 3 + detect-revivals-ibdb backfill)', () => {
  assert.equal(shouldAcceptIbdbRevival({ isRevival: true }, { synopsis: 'Soon is a new indie pop musical.' }), false);
  assert.equal(shouldAcceptIbdbRevival({ isRevival: true }, { synopsis: 'A bold new production.' }), true);
  assert.equal(shouldAcceptIbdbRevival({ isRevival: false }, { synopsis: '' }), false);
});

test('transliteration variants of one author are not a conflict (Dürrenmatt / Duerrenmatt)', () => {
  assert.equal(writersConflict(
    [{ name: 'Friedrich Dürrenmatt', role: 'Playwright' }],
    [{ name: 'Friedrich Duerrenmatt', role: 'Playwright' }, { name: 'Maurice Valency', role: 'Playwright' }]), false);
});

test('describesNewWork ignores "new play-by-play" style copy', () => {
  assert.equal(describesNewWork({ description: 'a new play-by-play retelling' }), false);
});
