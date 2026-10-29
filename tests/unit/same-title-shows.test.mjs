// BRO-4309: venue line only on rows that share a title with another row.
// TESTS-VS-DERIVED-DATA-EXEMPT: structural invariant over whatever shows.json holds (no specific fact pinned)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameTitleShowIds, normalizeTitle } from '../../src/lib/same-title-shows.ts';

test('flags both productions of a same-title pair, leaves the rest alone', () => {
  const ids = sameTitleShowIds([
    { id: 'dream-globe', title: "A Midsummer Night's Dream", venue: "Shakespeare's Globe" },
    { id: 'dream-park', title: 'A Midsummer Night’s Dream', venue: 'Regent’s Park Open Air Theatre' },
    { id: 'cinderella-pal', title: 'Cinderella', venue: 'London Palladium' },
    { id: 'cinderella-lyric', title: ' cinderella ', venue: 'Lyric Hammersmith' },
    { id: 'hamilton', title: 'Hamilton' },
  ]);
  assert.deepEqual([...ids].sort(), ['cinderella-lyric', 'cinderella-pal', 'dream-globe', 'dream-park']);
});

test('same title but identical venue (two tours) is not flagged', () => {
  const ids = sameTitleShowIds([
    { id: 'a', title: 'Beetlejuice', venue: 'North American Tour' },
    { id: 'b', title: 'Beetlejuice', venue: 'North American Tour' },
  ]);
  assert.equal(ids.size, 0);
});

test('no duplicates -> empty set; empty list -> empty set', () => {
  assert.equal(sameTitleShowIds([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]).size, 0);
  assert.equal(sameTitleShowIds([]).size, 0);
});

test('real shows.json: every flagged row has a same-title twin at a different venue', () => {
  const shows = JSON.parse(readFileSync('data/shows.json', 'utf8')).shows;
  const open = shows.filter((s) => s.status === 'open');
  const flagged = sameTitleShowIds(open);
  for (const id of flagged) {
    const s = open.find((x) => x.id === id);
    const twins = open.filter((x) => normalizeTitle(x.title) === normalizeTitle(s.title));
    const venues = new Set(twins.map((x) => (x.venue ?? '').trim().toLowerCase()).filter(Boolean));
    assert.ok(twins.length > 1 && venues.size > 1, id);
  }
});

test('ShowListCard renders venue only behind showVenue, in both variants; lists wire it', () => {
  const card = readFileSync('src/components/show-cards/ShowListCard.tsx', 'utf8');
  assert.equal((card.match(/showVenue && show\.venue/g) || []).length, 2);
  assert.match(readFileSync('src/components/BrowseListClient.tsx', 'utf8'), /showVenue=\{sameTitleIds\.has\(show\.id\)\}/);
  assert.match(readFileSync('src/components/show-cards/WindowedShowCardList.tsx', 'utf8'), /showVenue=\{sameTitleIds\.has\(show\.id\)\}/);
});

test('a twin with no venue does not count as a distinct venue', () => {
  const ids = sameTitleShowIds([
    { id: 'a', title: 'Cinderella', venue: 'Adelphi Theatre' },
    { id: 'b', title: 'Cinderella', venue: null },
  ]);
  assert.equal(ids.size, 0);
});
