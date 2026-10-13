// BRO-2684: the five BRO-155 off-off-Broadway stubs were added with no
// reviews and image paths that pointed at files nobody had fetched. This pins
// the backfill: every image path the stubs reference is a real file in the
// repo, and the shows that had published reviews keep them. Michael R.
// Jackson: Wake Up Call was a one-night Joe's Pub set with no scoreable
// reviews, so it is checked for art only (the card says not to force it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STUBS = [
  'matchbook-fest-off-broadway-2026',
  'brooklyns-bridge-off-broadway-2026',
  'the-whole-sky-all-diamonds-off-broadway-2026',
  'the-bathroom-attendant-off-broadway-2026',
  'michael-r-jackson-wake-up-call-off-broadway-2026',
];
// Reviews found and ingested for the stubs (2026-10-13 backfill), as a floor.
const MIN_REVIEWS = {
  'brooklyns-bridge-off-broadway-2026': 1,
  'the-whole-sky-all-diamonds-off-broadway-2026': 1,
  'the-bathroom-attendant-off-broadway-2026': 3,
};

function readJsonIfPresent(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')); } catch { return null; }
}

test('every BRO-155 stub has thumbnail and poster art committed in public/images', () => {
  for (const id of STUBS) {
    for (const f of ['thumbnail.jpg', 'poster.jpg']) {
      const p = path.join(REPO, 'public', 'images', 'shows', id, f);
      assert.ok(fs.existsSync(p) && fs.statSync(p).size > 1000, `${id}/${f} is missing or empty`);
    }
  }
});

test('the image paths shows.json gives the stubs resolve to real files', (t) => {
  const raw = readJsonIfPresent('data/shows.json');
  if (!raw) { t.skip('data/shows.json not linked in this checkout (private core data)'); return; }
  const shows = Array.isArray(raw) ? raw : raw.shows;
  for (const id of STUBS) {
    const show = shows.find((s) => s.id === id);
    assert.ok(show, `${id} is in shows.json`);
    for (const kind of ['thumbnail', 'poster']) {
      const rel = show.images && show.images[kind];
      if (!rel) continue;
      assert.ok(fs.existsSync(path.join(REPO, 'public', rel)), `${id} ${kind} points at ${rel}, which does not exist`);
    }
  }
});

test('the stubs with published reviews keep at least the backfilled count', (t) => {
  const raw = readJsonIfPresent('data/reviews.json');
  if (!raw) { t.skip('data/reviews.json not linked in this checkout (private core data)'); return; }
  const reviews = Array.isArray(raw) ? raw : raw.reviews;
  for (const [id, min] of Object.entries(MIN_REVIEWS)) {
    const n = reviews.filter((r) => r.showId === id).length;
    assert.ok(n >= min, `${id} has ${n} review(s), expected at least ${min}`);
  }
});
