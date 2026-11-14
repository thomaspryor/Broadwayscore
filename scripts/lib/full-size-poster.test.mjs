// BRO-6393: rules for the social cards' full-size poster originals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fsp = require('./full-size-poster.js');

test('isUsablePoster: portrait at least 440 wide, never a landscape or a thumbnail', () => {
  assert.equal(fsp.isUsablePoster({ width: 800, height: 1262 }), true); // Mezzanine original
  assert.equal(fsp.isUsablePoster({ width: 480, height: 720 }), true);
  assert.equal(fsp.isUsablePoster({ width: 400, height: 631 }), false); // too small
  assert.equal(fsp.isUsablePoster({ width: 800, height: 500 }), false); // venue og:image
  assert.equal(fsp.isUsablePoster({ width: 1080, height: 1080 }), false); // square
  assert.equal(fsp.isUsablePoster({}), false);
  // EXIF orientation 6/8: stored portrait, displayed landscape
  assert.equal(fsp.isUsablePoster({ width: 1000, height: 1500, orientation: 6 }), false);
  assert.equal(fsp.isUsablePoster({ width: 1500, height: 1000, orientation: 8 }), true);
  assert.equal(fsp.isUsablePoster({ width: 1000, height: 1500, orientation: 1 }), true);
});

test('originalUrl strips Contentful transforms and fixes protocol-relative URLs', () => {
  assert.equal(fsp.originalUrl('//images.ctfassets.net/a/b/c/p.jpg?w=200&h=300'), 'https://images.ctfassets.net/a/b/c/p.jpg');
  assert.equal(fsp.originalUrl('https://example.com/p.jpg?x=1'), 'https://example.com/p.jpg?x=1');
  assert.equal(fsp.originalUrl(''), null);
  assert.equal(fsp.originalUrl('not a url'), null);
});

test('posterCandidates: recorded full-size first, manual sources skipped, todaytix-ids.json used', () => {
  const show = { id: 's1', todaytixId: null, images: { poster: '/images/shows/s1/poster.webp' } };
  const c = fsp.posterCandidates(show, {
    sources: { s1: { poster: 'manual:owner' } },
    fullSize: { s1: { url: 'https://x.test/big.jpg' }, _tried: {} },
    todaytixIds: { s1: { id: 48323 } },
  });
  assert.deepEqual(c.map((x) => Object.keys(x)[0]), ['url', 'todaytixId', 'file']);
  assert.equal(c[0].url, 'https://x.test/big.jpg');
  assert.equal(c[1].todaytixId, 48323);
  // show.todaytixId wins over the ids file
  assert.equal(fsp.posterCandidates({ ...show, todaytixId: 7 }, { todaytixIds: { s1: { id: 48323 } } })[0].todaytixId, 7);
});

test('fullSizePosterFor never returns the _tried bookkeeping map', () => {
  const map = { _tried: { url: 'x' }, a: { url: 'u' } };
  assert.equal(fsp.fullSizePosterFor('_tried', map), null);
  assert.equal(fsp.fullSizePosterFor('a', map).url, 'u');
  assert.equal(fsp.fullSizePosterFor('b', map), null);
});

test('recentlyTried: skip for 3 days after a miss', () => {
  const map = { _tried: { a: '2026-10-25' } };
  assert.equal(fsp.recentlyTried('a', map, '2026-10-26'), true);
  assert.equal(fsp.recentlyTried('a', map, '2026-10-28'), false);
  assert.equal(fsp.recentlyTried('b', map, '2026-10-26'), false);
});

test('waitingForPosterIds tolerates every ledger shape, including none', () => {
  assert.deepEqual(fsp.waitingForPosterIds({}), []);
  assert.deepEqual(fsp.waitingForPosterIds({ _meta: {} }), []);
  assert.deepEqual(fsp.waitingForPosterIds({ _meta: { waitingForPoster: ['a', { showId: 'b' }, { id: 'c' }, null] } }), ['a', 'b', 'c']);
  assert.deepEqual(fsp.waitingForPosterIds({ _meta: { waitingForPoster: { d: {}, e: {} } } }), ['d', 'e']);
});

test('orderShowsForPosterSearch: held, then next 14 days soonest first, then last 90 days newest first', () => {
  const shows = [
    { id: 'old', openingDate: '2026-01-01' },
    { id: 'recent-a', openingDate: '2026-10-01' },
    { id: 'recent-b', openingDate: '2026-10-20' },
    { id: 'soon-b', openingDate: '2026-11-05' },
    { id: 'soon-a', openingDate: '2026-10-28' },
    { id: 'far', openingDate: '2027-01-01' },
    { id: 'held', openingDate: '2025-05-01' },
    { id: 'nodate' },
  ];
  const ids = fsp.orderShowsForPosterSearch(shows, { today: '2026-10-26', waiting: ['held'] }).map((s) => s.id);
  assert.deepEqual(ids, ['held', 'soon-a', 'soon-b', 'recent-b', 'recent-a']);
});

test('isSiteRoot and findShowLink pick the show page off a venue site', () => {
  assert.equal(fsp.isSiteRoot('https://www.orangetreetheatre.co.uk/'), true);
  assert.equal(fsp.isSiteRoot('https://x.test/whats-on/show/'), false);
  const html = `
    <a href="/whats-on/the-cherry-orchard/">Other</a>
    <a href="https://orangetreetheatre.co.uk/whats-on/murder-cathedral/">Murder</a>
    <a href="/whats-on/murder-cathedral/tickets/extra/">Longer path</a>
    <a href="https://elsewhere.test/murder-cathedral/">Other site</a>
    <a href="/">Home</a>`;
  assert.equal(fsp.findShowLink(html, 'https://www.orangetreetheatre.co.uk/', 'Murder in the Cathedral'),
    'https://orangetreetheatre.co.uk/whats-on/murder-cathedral/');
  assert.equal(fsp.findShowLink(html, 'https://www.orangetreetheatre.co.uk/', 'Hamlet'), null);
  assert.equal(fsp.findShowLink(html, 'https://www.orangetreetheatre.co.uk/', 'The'), null); // no distinctive words
});

test('load/save: missing file reads as empty, corrupt file throws instead of being overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-'));
  const f = path.join(dir, 'full-size-posters.json');
  assert.deepEqual(fsp.loadFullSizePosters(f), {});
  fsp.saveFullSizePosters({ a: { url: 'u' } }, f);
  assert.deepEqual(fsp.loadFullSizePosters(f), { a: { url: 'u' } });
  fs.writeFileSync(f, '{broken');
  assert.throws(() => fsp.loadFullSizePosters(f));
  assert.deepEqual(fsp.loadFullSizePostersSafe(f), {}); // the social cards keep posting
  fs.rmSync(dir, { recursive: true });
});

test('artVerdict: only a positive Gemini match passes', () => {
  assert.equal(fsp.artVerdict({ match: true }).ok, true);
  assert.equal(fsp.artVerdict({ match: false, confidence: 'high', description: 'wrong show' }).ok, false);
  assert.equal(fsp.artVerdict({ skipped: true }).ok, false);
  assert.equal(fsp.artVerdict(null).ok, false);
});

test('the tracked data file parses and every entry passes the size rule', () => {
  const map = fsp.loadFullSizePosters();
  for (const [id, e] of Object.entries(map)) {
    if (id === '_tried') continue;
    assert.ok(/^https:\/\//.test(e.url), `${id}: url`);
    assert.ok(fsp.isUsablePoster(e), `${id}: ${e.width}x${e.height}`);
  }
});

test('isUsablePoster: a smaller layout may pass its own minimum width', () => {
  assert.equal(fsp.isUsablePoster({ width: 400, height: 631 }, 346), true);
  assert.equal(fsp.isUsablePoster({ width: 400, height: 631 }), false);
});
