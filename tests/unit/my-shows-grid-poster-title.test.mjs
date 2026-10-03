/**
 * BRO-3861: My Shows grid cards are poster-only, so a show with no poster
 * rendered as an anonymous mask tile and the date was the most prominent
 * text on the card. Grid callers now pass the title, and Poster prints it
 * in the placeholder. List rows (text-xl posters) print the title beside
 * the thumbnail, so they stay title-less.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(join(ROOT, 'src/app/my-shows/MyShowsClient.tsx'), 'utf8');

test('every grid-size Poster names the show', () => {
  const gridPosters = SOURCE.match(/<Poster [^>]*iconClass="text-3xl"[^>]*\/>/g) || [];
  // UpcomingGridCard, DiaryGridCard, WatchlistCard.
  assert.ok(gridPosters.length >= 3, `expected at least 3 grid posters, found ${gridPosters.length}`);
  for (const p of gridPosters) assert.match(p, /\btitle=\{title\}/, `grid poster without a title: ${p}`);
});

test('the poster-less placeholder renders the title', () => {
  const start = SOURCE.indexOf('function Poster(');
  assert.ok(start !== -1, 'Poster not found');
  const body = SOURCE.slice(start, SOURCE.indexOf('\nfunction ', start + 1));
  assert.match(body, /if \(title\)/);
  assert.match(body, /\{title\}<\/span>/, 'placeholder must print the title text');
});
