// BRO-3137: Garry Starr: Classic Penguins (off-broadway) must not be an uncollected
// blackout (live show, zero critic reviews on site). Data-state check; run on demand,
// intentionally not in test.yml (live data would make CI flap).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOW = 'garry-starr-classic-penguins-off-broadway-2026';
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

test(`uncollected-blackout:${SHOW} does not fire`, () => {
  const audit = readJson('data/audit/uncollected-live-reviews.json');
  assert.ok(Array.isArray(audit.blackoutShows), 'audit has blackoutShows array');
  assert.ok(!audit.blackoutShows.includes(SHOW), `${SHOW} is a total blackout`);
  const f = (audit.findings || []).find((x) => x.showId === SHOW);
  if (f) assert.ok(f.usable > 0, `${SHOW} has ${f.usable} usable of ${f.discovered}`);
});

test(`${SHOW} has critic reviews on site`, () => {
  const site = readJson(`public/data/shows/${SHOW}.json`);
  assert.ok(site.rc > 0, `rc=${site.rc}`);
  assert.ok(typeof site.cs === 'number' && site.cs > 0, `cs=${site.cs}`);
});
