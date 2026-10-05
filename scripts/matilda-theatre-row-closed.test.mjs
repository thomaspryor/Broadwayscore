// BRO-328: Matilda (Theatre Row) was a 4-day KOTA run (8/6-8/9/2026) left status=open, which
// made the uncollected-blackout alarm fire for a show with no critic coverage to collect.
// Data-state check; run on demand, intentionally not in test.yml (live data would make CI flap).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOW = 'matilda-the-musical-theatre-row-off-broadway-2026';
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

test(`${SHOW} is closed with its real closing date`, () => {
  const raw = readJson('data/shows.json');
  const s = (raw.shows || raw).find((x) => x.id === SHOW);
  assert.equal(s.status, 'closed');
  assert.equal(s.closingDate, '2026-08-09');
});

test(`uncollected-blackout:${SHOW} does not fire`, () => {
  const audit = readJson('data/audit/uncollected-live-reviews.json');
  assert.ok(!audit.blackoutShows.includes(SHOW), `${SHOW} is a total blackout`);
});
