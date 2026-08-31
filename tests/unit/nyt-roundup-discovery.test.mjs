/**
 * BRO-155: NYT's "14 Off Broadway Shows (and 1 Festival) to Elevate Your
 * August" (2026-08-01) listed 15 items; data/shows.json had only 6. Root
 * cause: these are tiny off-off-Broadway productions with no BWW/Show
 * Score/DTLI/Playbill footprint, so none of the existing aggregator
 * scrapers — which key off an outlet publishing a *review* roundup, not a
 * curated editorial pick list — ever surface them. NYT itself is paywalled
 * and its feature format isn't stable enough to scrape reliably, so this
 * guards the DATA fix (the 5 titles below, independently corroborated via
 * Playbill/TheaterMania/Stage and Cinema/local-press coverage since the NYT
 * piece itself is inaccessible) rather than a one-off NYT parser. New
 * editorial-roundup gaps should reuse findMissingRoundupShows, not a fresh
 * scraper, per scripts/lib/roundup-coverage-check.js.
 *
 * Two of the 7 titles the card originally flagged missing (ISLA, Benevolent)
 * had already landed via the BWW-roundup pipeline by the time this ran —
 * left in ROUNDUP_ENTRIES so this test also pins that they don't regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { findMissingRoundupShows } = require(path.join(REPO, 'scripts/lib/roundup-coverage-check.js'));

// The 7 titles named in BRO-155 as missing from the 2026-08-01 NYT roundup.
const ROUNDUP_ENTRIES = [
  { title: 'Matchbook Fest', venue: 'Greenwich House Theater' },
  { title: "Brooklyn's Bridge", venue: 'The Space at Irondale' },
  { title: 'ISLA', venue: 'WP Theater' },
  { title: 'The Whole Sky All Diamonds', venue: 'Loft Story' },
  { title: 'The Bathroom Attendant', venue: '124 Bank Street Theater' },
  { title: 'benevolent', venue: 'IATI Theater' },
  { title: 'Michael R. Jackson: Wake Up Call', venue: "Joe's Pub" },
];

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'data/shows.json'), 'utf8'));
  return raw.shows || raw;
}

test('findMissingRoundupShows flags a title with no matching show', () => {
  const missing = findMissingRoundupShows(
    [{ title: 'Totally Made Up Show Title', venue: 'Nowhere Theater' }],
    loadShows()
  );
  assert.equal(missing.length, 1);
});

test('findMissingRoundupShows flags a title match at the wrong venue (guards against matching the wrong production of a recurring title)', () => {
  const shows = loadShows();
  const real = shows.find((s) => s.id === 'isla-off-broadway-2026');
  assert.ok(real, 'isla-off-broadway-2026 should exist in data/shows.json');
  const missing = findMissingRoundupShows(
    [{ title: real.title, venue: 'Some Venue That Does Not Exist' }],
    shows
  );
  assert.equal(missing.length, 1, 'a venue mismatch on a matching title should still be reported, not silently covered');
});

test('findMissingRoundupShows treats a matching title as covered when the candidate has no venue', () => {
  const shows = loadShows();
  const real = shows.find((s) => s.id === 'isla-off-broadway-2026');
  const missing = findMissingRoundupShows([{ title: real.title }], shows);
  assert.equal(missing.length, 0);
});

test('all 7 shows named in the BRO-155 NYT August roundup gap now exist in data/shows.json', () => {
  const missing = findMissingRoundupShows(ROUNDUP_ENTRIES, loadShows());
  assert.deepEqual(
    missing,
    [],
    `still missing from data/shows.json: ${missing.map((m) => m.title).join(', ')}`
  );
});
