/**
 * BRO-2820: AMAZE (New World Stages) was labelled amaze-off-broadway-2026 with no
 * dates, so 9 reviews dated 2025-08-13 were bulk-flagged wrongProduction with an
 * empty reason and the show had no critic score. Fixed by correcting the entry
 * (id/year + openingDate). This pins the corrected entry, the review rows, and
 * that no wrongProduction flag is left without a reason.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ID = 'amaze-magic-off-broadway-2025';
const OLD_ID = 'amaze-off-broadway-2026';
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const have = (p) => fs.existsSync(path.join(root, p));

test('AMAZE entry carries the Playbill/IBDB-validated opening date, old 2026 id is gone', { skip: !have('data/shows.json') }, () => {
  const raw = readJson('data/shows.json');
  const shows = raw.shows || raw;
  assert.ok(!shows.some((s) => s.id === OLD_ID), 'old dateless 2026 entry must not exist');
  const s = shows.find((x) => x.id === ID);
  assert.ok(s, `${ID} missing`);
  assert.strictEqual(s.openingDate, '2025-08-13');
  assert.strictEqual(s.previewsStartDate, '2025-07-20');
  assert.strictEqual(s.venue, 'New World Stages');
});

test('AMAZE has scoreable reviews and no empty-reason wrongProduction flags', { skip: !have('data/reviews.json') }, () => {
  const raw = readJson('data/reviews.json');
  const rows = (Array.isArray(raw.reviews || raw) ? (raw.reviews || raw) : Object.values(raw.reviews || raw))
    .filter((r) => r.showId === ID);
  assert.ok(rows.filter((r) => typeof r.assignedScore === 'number').length >= 5, 'expected >=5 scored AMAZE reviews');
  for (const r of rows) {
    if (r.wrongProduction) assert.ok((r.wrongProductionReason || '').trim(), `${r.outlet}: wrongProduction without reason`);
  }
});

test('AMAZE critic score is non-null on the slim file', { skip: !have(`public/data/shows/${ID}.json`) }, () => {
  const cs = readJson(`public/data/shows/${ID}.json`).cs;
  assert.ok(typeof cs === 'number' && cs >= 60 && cs <= 100, `cs=${cs}`);
});
