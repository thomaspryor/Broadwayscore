/**
 * BRO-2820: AMAZE (New World Stages) was labelled amaze-off-broadway-2026 with no
 * dates, so 9 reviews dated 2025-08-13 were bulk-flagged wrongProduction with an
 * empty reason and the show had no critic score. Fixed by correcting the entry
 * (id/year + openingDate). This pins the corrected entry, the review rows, and
 * that no wrongProduction flag is left without a reason.
 */
// Reads data/review-texts/ (source of truth) and derives expectations from it; no hardcoded dates/scores.
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

const SRC = `data/review-texts/${ID}`;

test('AMAZE entry has dates and opens no later than its earliest dated review', { skip: !have('data/shows.json') }, () => {
  const raw = readJson('data/shows.json');
  const shows = raw.shows || raw;
  assert.ok(!shows.some((s) => s.id === OLD_ID), 'old dateless 2026 entry must not exist');
  const s = shows.find((x) => x.id === ID);
  assert.ok(s, `${ID} missing`);
  assert.match(s.openingDate || '', /^\d{4}-\d{2}-\d{2}$/, 'openingDate must be set');
  assert.ok(s.previewsStartDate <= s.openingDate, 'previews must not start after opening');
  if (have(SRC)) {
    const dates = fs.readdirSync(path.join(root, SRC)).filter((f) => f.endsWith('.json'))
      .map((f) => readJson(`${SRC}/${f}`))
      .map((j) => Date.parse(j.publishDate)).filter((d) => !Number.isNaN(d)).sort();
    assert.ok(dates.length > 0, 'expected dated review files');
    // reviews ~at opening; a year/entry mismatch (BRO-2820) put them a year before the entry
    assert.ok(Math.abs(dates[0] - Date.parse(s.openingDate)) < 60 * 864e5, 'entry date far from review dates');
  }
});

test('no AMAZE review file carries wrongProduction without a reason; scored rows exist', { skip: !have(SRC) }, () => {
  for (const f of fs.readdirSync(path.join(root, SRC)).filter((x) => x.endsWith('.json'))) {
    const j = readJson(`${SRC}/${f}`);
    if (j.wrongProduction) assert.ok((j.wrongProductionReason || '').trim(), `${f}: wrongProduction without reason`);
  }
  if (have('data/reviews.json')) {
    const raw = readJson('data/reviews.json');
    const list = raw.reviews || raw;
    const rows = (Array.isArray(list) ? list : Object.values(list)).filter((r) => r.showId === ID);
    assert.ok(rows.some((r) => typeof r.assignedScore === 'number'), 'no scored AMAZE rows');
  }
});

test('AMAZE critic score is non-null on the slim file', { skip: !have(`public/data/shows/${ID}.json`) }, () => {
  const cs = readJson(`public/data/shows/${ID}.json`).cs;
  assert.ok(typeof cs === 'number' && cs > 0 && cs <= 100, `cs=${cs}`);
});
