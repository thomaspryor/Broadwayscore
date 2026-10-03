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
// Poster and UpcomingGridCard moved here (BRO-4481) so Shared Plans reuses them.
const CARDS = readFileSync(join(ROOT, 'src/components/user/upcoming-cards.tsx'), 'utf8');

test('every grid-size Poster names the show', () => {
  const gridPosters = SOURCE.match(/<Poster [^>]*iconClass="text-3xl"[^>]*\/>/g) || [];
  // DiaryGridCard, WatchlistCard.
  assert.ok(gridPosters.length >= 2, `expected at least 2 grid posters, found ${gridPosters.length}`);
  for (const p of gridPosters) assert.match(p, /\btitle=\{title\}/, `grid poster without a title: ${p}`);
});

test('the Upcoming grid card prints the show name under the poster', () => {
  const start = CARDS.indexOf('export function UpcomingGridCard(');
  assert.ok(start !== -1, 'UpcomingGridCard not found');
  const body = CARDS.slice(start, CARDS.indexOf('\nexport function ', start + 1));
  assert.match(body, /line-clamp-2[^>]*>\{title\}<\/p>/, 'title must render under the poster (iOS design)');
});

test('the poster-less placeholder renders the title', () => {
  const start = CARDS.indexOf('export function Poster(');
  assert.ok(start !== -1, 'Poster not found');
  const body = CARDS.slice(start, CARDS.indexOf('\nexport function ', start + 1));
  assert.match(body, /if \(title\)/);
  assert.match(body, /\{title\}<\/span>/, 'placeholder must print the title text');
});
