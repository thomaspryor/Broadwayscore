import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  resolveShow,
  resolveShowMatches,
  extractShowTitlesFromText,
  normalizeShowName,
} = require('./resolve-show.js');

const SHOWS = [
  { id: 'ma-1971', slug: 'ma', title: 'Ma', status: 'closed', openingDate: '1971-03-01' },
  { id: 'rent-1996', slug: 'rent', title: 'Rent', status: 'closed', openingDate: '1996-04-29' },
  { id: 'rent-we-2021', slug: 'rent-west-end', title: 'Rent', status: 'closed', openingDate: '2021-10-01' },
  {
    id: 'different-times-1972',
    slug: 'different-times',
    title: 'Different Times',
    status: 'closed',
    openingDate: '1972-05-01',
  },
  {
    id: 'happy-journey-1948',
    slug: 'happy-journey',
    title: 'The Happy Journey to Trenton and Camden',
    status: 'closed',
    openingDate: '1948-03-01',
  },
  {
    id: 'misterman-theatre-row-off-broadway-2026',
    slug: 'misterman-theatre-row-off-broadway',
    title: 'Misterman (Theatre Row)',
    status: 'open',
    openingDate: '2026-06-25',
  },
  { id: 'romeo-juliet-2024', slug: 'romeo-juliet', title: 'Romeo & Juliet', status: 'closed', openingDate: '2024-10-24' },
];

// The GH #393 regression: "Ma" (earlier in the array) must not hijack
// "MISTERMAN" via reverse-substring, and the parenthetical qualifier in the
// stored title must not block the match.
test('MISTERMAN resolves to Misterman (Theatre Row), not Ma', () => {
  const show = resolveShow('MISTERMAN', SHOWS);
  assert.equal(show?.id, 'misterman-theatre-row-off-broadway-2026');
});

test('exact title beats fuzzy ranks', () => {
  assert.equal(resolveShow('Ma', SHOWS)?.id, 'ma-1971');
  assert.equal(resolveShow('Different Times', SHOWS)?.id, 'different-times-1972');
});

test('short titles never reverse-substring into longer names', () => {
  const matches = resolveShowMatches('Misterman', SHOWS);
  assert.deepEqual(
    matches.map((s) => s.id),
    ['misterman-theatre-row-off-broadway-2026']
  );
});

test('rent does not match inside "currently" or "Trenton"', () => {
  // "rent" as a token-sequence is not contained in these titles' tokens
  const matches = resolveShowMatches('rent', SHOWS);
  assert.deepEqual(new Set(matches.map((s) => s.id)), new Set(['rent-1996', 'rent-we-2021']));
});

test('multiple productions: open/newest wins single-resolve', () => {
  const show = resolveShow('rent', SHOWS);
  assert.equal(show?.id, 'rent-we-2021');
});

test('ampersand and "and" are interchangeable', () => {
  assert.equal(resolveShow('Romeo and Juliet', SHOWS)?.id, 'romeo-juliet-2024');
});

test('extractShowTitlesFromText requires token boundaries', () => {
  const msg =
    'We have been tracking MISTERMAN at Theatre Row. There are currently no references to our production, and my grandparents took a happy journey at different times.';
  const titles = extractShowTitlesFromText(msg, SHOWS);
  assert.ok(titles.includes('Misterman (Theatre Row)'), `expected Misterman in ${titles}`);
  assert.ok(!titles.includes('Rent'), '"currently" must not match Rent');
  // "different times" DOES appear as words in the message — legitimate match
  assert.ok(titles.includes('Different Times'));
});

test('junk inputs return empty', () => {
  assert.equal(resolveShow('', SHOWS), null);
  assert.equal(resolveShow('N/A', SHOWS), null);
  assert.equal(resolveShow(null, SHOWS), null);
  assert.deepEqual(extractShowTitlesFromText('', SHOWS), []);
});

test('normalizeShowName strips punctuation and case', () => {
  assert.equal(normalizeShowName("  Schmigadoon!  "), 'schmigadoon');
  assert.equal(normalizeShowName("O'Hara's Place"), 'o hara s place');
});
