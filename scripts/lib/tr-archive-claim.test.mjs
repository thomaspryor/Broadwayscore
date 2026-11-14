import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { checkTrArchiveClaim, quarantineClaimedOrphans, claimsFromCoverage, aliasMapFromShows } = require('./tr-archive-claim.js');

const page = (url) => `<html><head><link rel="canonical" href="${url}"/></head><body>x</body></html>`;
const claims = claimsFromCoverage({ shows: [
  { showId: 'godot-2017', roundupUrl: 'https://theatre.reviews/reviews-roundup/godot-2017-reviews/' },
  { showId: 'godot-2024', roundupUrl: 'https://theatre.reviews/reviews-roundup/godot-2024-reviews/' },
] });

test('page claimed by another show is rejected', () => {
  const v = checkTrArchiveClaim(page('https://theatre.reviews/reviews-roundup/godot-2024-reviews'), 'godot-2017', claims);
  assert.equal(v.ok, false);
  assert.equal(v.owner, 'godot-2024');
});
test('own page, unclaimed page and page without canonical are kept', () => {
  assert.equal(checkTrArchiveClaim(page('https://theatre.reviews/reviews-roundup/godot-2017-reviews/'), 'godot-2017', claims).ok, true);
  assert.equal(checkTrArchiveClaim(page('https://theatre.reviews/reviews-roundup/nobody-reviews/'), 'godot-2017', claims).ok, true);
  assert.equal(checkTrArchiveClaim('<html></html>', 'godot-2017', claims).ok, true);
});
test('quarantine renames only claimed-by-other orphans', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trq-'));
  fs.writeFileSync(path.join(d, 'bad.html'), page('https://theatre.reviews/reviews-roundup/godot-2024-reviews/'));
  fs.writeFileSync(path.join(d, 'free.html'), page('https://theatre.reviews/reviews-roundup/nobody-reviews/'));
  const q = quarantineClaimedOrphans(d, ['bad', 'free'], claims);
  assert.deepEqual(q, [{ showId: 'bad', owner: 'godot-2024' }]);
  assert.ok(fs.existsSync(path.join(d, 'bad.html.mismatch')));
  assert.ok(fs.existsSync(path.join(d, 'free.html')));
});

test('BRO-6968: a claim under a renamed show\'s old id belongs to the current id', () => {
  const aliases = aliasMapFromShows([{ id: 'mass-off-west-end-2026', aliases: ['mass-west-end-2026'] }]);
  const c = claimsFromCoverage({ shows: [{ showId: 'mass-west-end-2026', roundupUrl: 'https://theatre.reviews/reviews-roundup/mass-donmar-reviews/' }] }, aliases);
  const p = page('https://theatre.reviews/reviews-roundup/mass-donmar-reviews/');
  assert.equal(checkTrArchiveClaim(p, 'mass-off-west-end-2026', c).ok, true, 'own round-up, not another show\'s');
  assert.equal(checkTrArchiveClaim(p, 'other-show', c).owner, 'mass-off-west-end-2026');
  const raw = claimsFromCoverage({ shows: [{ showId: 'gone-2020', roundupUrl: 'https://theatre.reviews/reviews-roundup/g/' }] }, aliases);
  assert.equal(raw[0].showId, 'gone-2020', 'unknown ids are kept as recorded');
});
