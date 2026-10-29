// BRO-4309: venue line only on rows that share a title with another row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameTitleShowIds } from '../../src/lib/same-title-shows.ts';

test('flags both productions of a same-title pair, leaves the rest alone', () => {
  const ids = sameTitleShowIds([
    { id: 'dream-globe', title: "A Midsummer Night's Dream" },
    { id: 'dream-park', title: 'A Midsummer Night’s Dream' },
    { id: 'cinderella-pal', title: 'Cinderella' },
    { id: 'cinderella-lyric', title: ' cinderella ' },
    { id: 'hamilton', title: 'Hamilton' },
  ]);
  assert.deepEqual([...ids].sort(), ['cinderella-lyric', 'cinderella-pal', 'dream-globe', 'dream-park']);
});

test('no duplicates -> empty set; empty list -> empty set', () => {
  assert.equal(sameTitleShowIds([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]).size, 0);
  assert.equal(sameTitleShowIds([]).size, 0);
});

test('real shows.json: every same-title group in the current list is flagged', () => {
  const shows = JSON.parse(readFileSync('data/shows.json', 'utf8')).shows;
  const open = shows.filter((s) => s.status === 'open');
  const flagged = sameTitleShowIds(open);
  const counts = {};
  for (const s of open) counts[s.title.toLowerCase().trim()] = (counts[s.title.toLowerCase().trim()] || 0) + 1;
  const dupRows = open.filter((s) => counts[s.title.toLowerCase().trim()] > 1).length;
  assert.ok(flagged.size >= dupRows);
});

test('ShowListCard renders venue only behind showVenue, in both variants; lists wire it', () => {
  const card = readFileSync('src/components/show-cards/ShowListCard.tsx', 'utf8');
  assert.equal((card.match(/showVenue && show\.venue/g) || []).length, 2);
  assert.match(readFileSync('src/components/BrowseListClient.tsx', 'utf8'), /showVenue=\{sameTitleIds\.has\(show\.id\)\}/);
  assert.match(readFileSync('src/components/show-cards/WindowedShowCardList.tsx', 'utf8'), /showVenue=\{sameTitleIds\.has\(show\.id\)\}/);
});
