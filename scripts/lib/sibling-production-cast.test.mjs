import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { findSiblingProductionCastMismatch, titleKey } = require('./sibling-production-cast');

// Real shapes (BRO-5499): the 2019 Broadway entry and the Oct 2026 Off-Broadway entry.
const SEA_WALL_2019 = {
  id: 'sea-wall-a-life-2019', title: 'Sea Wall / A Life', category: 'broadway', market: 'broadway',
  cast: [{ name: 'Tom Sturridge' }, { name: 'Jake Gyllenhaal' }],
  creativeTeam: [{ name: 'Carrie Cracknell', role: 'Director' }, { name: 'Kaye Voyce and Christopher Peterson', role: 'Costume Design' }],
};
const SEA_WALL_2026 = {
  id: 'sea-wall-off-broadway-2026', title: 'Sea Wall', category: 'off-broadway', market: 'broadway',
  cast: [{ name: 'Andrew Scott' }], creativeTeam: [{ name: 'Tina Satter', role: 'Director' }],
};
const ALL = [SEA_WALL_2019, SEA_WALL_2026];
const pad = ' The monologue circles grief and faith for an hour with no interval at all.'.repeat(8);

test('titleKey folds subtitle and article', () => {
  assert.equal(titleKey('Sea Wall / A Life'), 'sea wall');
  assert.equal(titleKey('The Music Man'), 'music man');
});

test('flags a review that names only the earlier production\'s actors', () => {
  const text = 'The evening, beautifully acted by Tom Sturridge and Jake Gyllenhaal, is haunting.' + pad;
  const r = findSiblingProductionCastMismatch(text, SEA_WALL_2026, ALL);
  assert.equal(r.siblingId, 'sea-wall-a-life-2019');
  assert.deepEqual(r.siblingNamesFound.sort(), ['jake gyllenhaal', 'tom sturridge']);
});

test('leaves a review alone when it also names this production\'s cast', () => {
  const text = 'Andrew Scott is superb, a long way from the Gyllenhaal staging of 2019 (Jake Gyllenhaal).' + pad;
  assert.equal(findSiblingProductionCastMismatch(text, SEA_WALL_2026, ALL), null);
});

test('is symmetric when the later entry lists two actors', () => {
  const later = { ...SEA_WALL_2026, cast: [{ name: 'Andrew Scott' }, { name: 'Jane Example' }] };
  const text = 'Andrew Scott and Jane Example are fine, directed by Tina Satter.' + pad;
  const r = findSiblingProductionCastMismatch(text, SEA_WALL_2019, [SEA_WALL_2019, later]);
  assert.equal(r.siblingId, 'sea-wall-off-broadway-2026');
});

test('one sibling actor alone is not enough (passing reference)', () => {
  const text = 'Tom Sturridge once played Alex.' + pad;
  assert.equal(findSiblingProductionCastMismatch(text, SEA_WALL_2026, ALL), null);
});

test('does nothing when the show has no cast on file, or the text is a blurb', () => {
  assert.equal(findSiblingProductionCastMismatch('Tom Sturridge' + pad, { ...SEA_WALL_2026, cast: [], creativeTeam: [] }, ALL), null);
  assert.equal(findSiblingProductionCastMismatch('Tom Sturridge and Jake Gyllenhaal', SEA_WALL_2026, ALL), null);
});

test('a declared return of the earlier production is the same production', () => {
  const returning = { ...SEA_WALL_2026, priorRuns: [{ id: 'sea-wall-a-life-2019' }] };
  const text = 'Tom Sturridge and Jake Gyllenhaal are back.' + pad;
  assert.equal(findSiblingProductionCastMismatch(text, returning, [SEA_WALL_2019, returning]), null);
});

test('different titles are never siblings; partial name matches do not count', () => {
  const other = { id: 'x-2026', title: 'Another Play', category: 'off-broadway', cast: [{ name: 'Tom Sturridge' }] };
  assert.equal(findSiblingProductionCastMismatch('Tom Sturridge shines.' + pad, SEA_WALL_2026, [SEA_WALL_2026, other]), null);
  assert.equal(findSiblingProductionCastMismatch('Tom Sturridgeon shines.' + pad, SEA_WALL_2026, ALL), null);
});

test('cross-market and tour siblings are not compared', () => {
  const tour = { id: 'sea-wall-tour-2026', title: 'Sea Wall', category: 'tour', market: 'tour', cast: [{ name: 'Tom Sturridge' }] };
  const westEnd = { id: 'sea-wall-west-end-2008', title: 'Sea Wall', category: 'west-end', market: 'west-end', cast: [{ name: 'Andrew Scott' }] };
  const text = 'Andrew Scott is superb as Alex.' + pad;
  assert.equal(findSiblingProductionCastMismatch('Tom Sturridge is superb.' + pad, SEA_WALL_2026, [SEA_WALL_2026, tour]), null);
  assert.equal(findSiblingProductionCastMismatch(text, { ...SEA_WALL_2019, cast: [{ name: 'Tom Sturridge' }] }, [SEA_WALL_2019, westEnd]), null);
});

test('a review dated far outside the sibling\'s run is not the sibling\'s (recalling the original cast)', () => {
  const orig = { id: 'chicago-1975', title: 'Chicago', category: 'broadway', market: 'broadway', openingDate: '1975-06-03', closingDate: '1977-10-23', cast: [{ name: 'Jerry Orbach' }, { name: 'Gwen Verdon' }] };
  const revival = { id: 'chicago-1996', title: 'Chicago', category: 'broadway', market: 'broadway', openingDate: '1996-11-14', cast: [{ name: 'Bebe Neuwirth' }] };
  const text = 'The revival has changed hands again, long after Jerry Orbach and Gwen Verdon made the show a hit.' + pad;
  assert.equal(findSiblingProductionCastMismatch(text, revival, [orig, revival], { publishDate: 'April 22, 2006' }), null);
  assert.ok(findSiblingProductionCastMismatch(text, revival, [orig, revival], { publishDate: '1975-06-05' }));
  assert.ok(findSiblingProductionCastMismatch(text, revival, [orig, revival]));
});

// Real shows.json rows as of 2026-10-16 (after plan bro-5499-a fixes the 2026 row): the 2019 row's cast
// list is partial (Tom Sturridge only) and the playwright is on both rows.
test('real Sea Wall rows: a 2019 review naming the 2019 actors and the shared playwright is flagged', () => {
  const real2019 = { id: 'sea-wall-a-life-2019', title: 'Sea Wall / A Life', category: 'broadway', market: 'broadway', openingDate: '2019-02-14', closingDate: '2019-04-14',
    cast: [{ name: 'Tom Sturridge' }], creativeTeam: [{ name: 'Carrie Cracknell', role: 'Director' }, { name: 'Simon Stephens', role: 'Playwright' }] };
  const real2026 = { id: 'sea-wall-off-broadway-2026', title: 'Sea Wall', category: 'off-broadway', market: 'broadway', openingDate: '2026-10-16',
    cast: [{ name: 'Andrew Scott', role: 'Alex' }], creativeTeam: [{ name: 'Simon Stephens', role: 'Playwright' }, { name: 'Tina Satter', role: 'Director' }] };
  const wrong = 'A double bill of monologues by Simon Stephens, beautifully acted by Tom Sturridge and Jake Gyllenhaal, on the existential questions.' + pad;
  const r = findSiblingProductionCastMismatch(wrong, real2026, [real2019, real2026]);
  assert.equal(r && r.siblingId, 'sea-wall-a-life-2019');
  const right = 'Simon Stephens wrote it for Andrew Scott, who plays Alex under Tina Satter, with a nod to Tom Sturridge in 2019.' + pad;
  assert.equal(findSiblingProductionCastMismatch(right, real2026, [real2019, real2026]), null);
  // the playwright alone proves nothing
  assert.equal(findSiblingProductionCastMismatch('Simon Stephens writes about grief.' + pad, real2026, [real2019, real2026]), null);
});

test('cannot tell productions apart when this entry has nobody the sibling lacks', () => {
  const a = { id: 'x-2019', title: 'X', category: 'broadway', market: 'broadway', cast: [{ name: 'Ann Lee' }, { name: 'Bob Ray' }] };
  const b = { id: 'x-2026', title: 'X', category: 'broadway', market: 'broadway', cast: [{ name: 'Ann Lee' }, { name: 'Bob Ray' }] };
  assert.equal(findSiblingProductionCastMismatch('Ann Lee and Bob Ray.' + pad, b, [a, b]), null);
});

test('findCopiedSiblingCasts: a Met Opera Macbeth carrying the 2022 Broadway Macbeth cast is reported; a plain revival is not', () => {
  const { findCopiedSiblingCasts } = require('./sibling-production-cast');
  const cast = (...n) => n.map((name) => ({ name }));
  const broadway = { id: 'macbeth-2022', title: 'Macbeth', category: 'broadway', market: 'broadway', openingDate: '2022-04-28', cast: cast('Daniel Craig', 'Ruth Negga', 'Amber Gray', 'Paul Lazar') };
  const met = { id: 'macbeth-off-broadway-2026', title: 'Macbeth', category: 'off-broadway', market: 'broadway', openingDate: '2026-09-22', cast: cast('Daniel Craig', 'Ruth Negga', 'Amber Gray', 'Paul Lazar') };
  assert.deepEqual(findCopiedSiblingCasts([broadway, met]).map((c) => [c.showId, c.siblingId]), [['macbeth-off-broadway-2026', 'macbeth-2022']]);
  const revival = { ...met, cast: cast('Quinn Kelsey', 'Lise Davidsen', 'Freddie De Tommaso', 'Ryan Speedo Green') };
  assert.deepEqual(findCopiedSiblingCasts([broadway, revival]), []);
  const sameYear = { ...met, openingDate: '2023-01-01' };
  assert.deepEqual(findCopiedSiblingCasts([broadway, sameYear]), []);
});

test('findCopiedSiblingCasts: undated or unparseable rows are skipped, and the year is read from the string (BRO-5499)', () => {
  const { findCopiedSiblingCasts } = require('./sibling-production-cast');
  const cast = (...n) => n.map((name) => ({ name }));
  const base = { title: 'X', category: 'broadway', market: 'broadway', cast: cast('Ann Lee', 'Bob Ray', 'Cy Poe') };
  const dated = { ...base, id: 'x-2024', openingDate: '2024-05-01' };
  assert.deepEqual(findCopiedSiblingCasts([dated, { ...base, id: 'x-tba' }]), [], 'missing date');
  assert.deepEqual(findCopiedSiblingCasts([dated, { ...base, id: 'x-bad', openingDate: 'TBA' }]), [], 'unparseable date');
  const jan1 = { ...base, id: 'x-2021', openingDate: '2021-01-01' };
  const hit = findCopiedSiblingCasts([{ ...base, id: 'x-2024b', openingDate: '2024-01-01' }, jan1]);
  assert.equal(hit.length, 1, 'exactly 3 calendar years apart');
  assert.equal(hit[0].year, 2024);
});
