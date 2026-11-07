// BRO-5501: Cherry Orchard 2026 (West End + Park Avenue Armory) data regressions.
// Reads core data (shows.json / reviews.json); skips when the private core data is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const showsPath = path.join(root, 'data', 'shows.json');
const reviewsPath = path.join(root, 'data', 'reviews.json');
const haveData = fs.existsSync(showsPath) && fs.existsSync(reviewsPath);
const opts = { skip: haveData ? false : 'core data not present' };

const WE = 'the-cherry-orchard-west-end-2026';
const ARMORY = 'the-cherry-orchard-park-avenue-armory-off-broadway-2026';

let shows, reviews;
if (haveData) {
  const s = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  shows = Array.isArray(s) ? s : s.shows;
  const r = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  reviews = Array.isArray(r) ? r : r.reviews;
}
const show = (id) => shows.find((x) => x.id === id);
const rev = (id, outletId) => reviews.filter((r) => r.showId === id && r.outletId === outletId);

test('WE: Evening Standard (Nick Curtis) carries the 2026 review', opts, () => {
  const [r] = rev(WE, 'standard');
  assert.ok(r, 'standard review present');
  assert.equal(r.criticName, 'Nick Curtis');
  assert.match(r.url, /the-cherry-orchard-review-b1300867/);
  assert.ok(r.assignedScore >= 75 && r.assignedScore <= 90, `score ${r.assignedScore}`);
  assert.ok(!r.wrongProduction);
});

test('WE: Time Out London (Andrzej Lukowski) has the 2026 url', opts, () => {
  const [r] = rev(WE, 'timeout-london');
  assert.ok(r);
  assert.equal(r.criticName, 'Andrzej Lukowski');
  assert.match(r.url, /harold-pinter-theatre-101426$/);
  assert.equal(r.publishDate, '2026-10-14');
});

test('WE: Times review present for the 2026 url', opts, () => {
  const [r] = rev(WE, 'times-uk');
  assert.ok(r);
  assert.match(r.url, /gc88pnwh6$/);
});

test('WE: Matinee Mouse has an LLM score', opts, () => {
  const [r] = rev(WE, 'matineemouse');
  assert.ok(r);
  assert.equal(r.scoreSource, 'llm-v6');
});

test('WE: creativeTeam has director, adapter and designers', opts, () => {
  const names = Object.fromEntries(show(WE).creativeTeam.map((c) => [c.name, c.role]));
  assert.equal(names['Ian Rickson'], 'Director');
  assert.equal(names['Conor McPherson'], 'Adaptation');
  assert.ok(Object.values(names).some((r) => /Design/.test(r)));
});

test('WE: no junk or missing bylines on the previously flagged outlets', opts, () => {
  const junk = new Set(['Ltr', 'LTR', 'The Recs Jdh', 'Wheelie Good Show']);
  const rows = reviews.filter((r) => r.showId === WE);
  for (const r of rows) assert.ok(!junk.has(r.criticName), `${r.outletId}: ${r.criticName}`);
  for (const id of ['all-that-dazzles-uk', 'cultural-capital', 'firstnightmagazine', 'the-spy-in-the-stalls', 'curtain-call-reviews', 'london-theatre-reviews']) {
    for (const r of rev(WE, id)) assert.ok(r.criticName, `${id} missing byline`);
  }
});

test('Armory: cast is the Korean production, not the 2009-style American cast', opts, () => {
  const cast = show(ARMORY).cast.map((c) => c.name);
  for (const n of ['Jeon Do-yeon', 'Park Hae-soo']) assert.ok(cast.includes(n), n);
  for (const n of ['John Turturro', 'Dianne Wiest', 'Josh Hamilton', 'Daniel Davis', 'Juliet Rylance', 'Michael Urie', 'Elisabeth Waterston', 'Katherine Waterston']) {
    assert.ok(!cast.includes(n), `${n} must not be in cast`);
  }
});

test('Armory: creativeTeam has Simon Stone and production credits', opts, () => {
  const ct = show(ARMORY).creativeTeam;
  assert.ok(ct.some((c) => c.name === 'Simon Stone' && c.role === 'Director'));
  assert.ok(ct.length >= 5);
});

test('Armory: Theatrely multi-show roundup is excluded from reviews.json', opts, () => {
  assert.equal(rev(ARMORY, 'theatrely').length, 0);
  const p = path.join(process.env.REVIEW_TEXTS_DIR || path.join(root, 'data', 'review-texts'), ARMORY, 'theatrely--joey-sims.json');
  if (fs.existsSync(p)) assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).isRoundupArticle, true);
});
