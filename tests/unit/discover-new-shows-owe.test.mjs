/**
 * BRO-182 — Off-West-End venue-page discovery lacks the OB staging gate.
 *
 * Before this fix, all 10 Off-West-End VENUE_LISTING_PAGES sources (Almeida,
 * Menier, Southwark, The Other Palace, ...) pushed discovered candidates
 * straight into `discoveredShows`, which discover-new-shows.js writes
 * directly to shows.json — unlike the Off-Broadway venue-listing path, which
 * stages to data/audit/ob-venue-candidates.json and requires
 * scripts/promote-ob-venue-candidates.js cross-validation before landing.
 * Venue pages list one-night events (talks, tribute concerts, short kids
 * shows) alongside real productions, so an unreviewed direct write is unsafe.
 *
 * This test verifies (CLAUDE.md §15 — require the real functions, never copy
 * logic into the test):
 *   1. scripts/lib/owe-venue-staging.js's staging primitives actually work
 *      (write → load round-trip, hash-based de-dupe, atomic write).
 *   2. discover-new-shows.js's West End block calls writeOweStagingCandidates
 *      for OWE venue-page candidates instead of merging them into the
 *      discoveredShows array that gets written to shows.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');

const {
  STAGING_PATH,
  candidateHash,
  loadStaging,
  writeStagingCandidates,
} = require(join(ROOT, 'scripts/lib/owe-venue-staging.js'));

// --- Functional: staging primitives actually persist to an audit file ---

test('owe-venue-staging STAGING_PATH points at data/audit/owe-venue-candidates.json, not shows.json', () => {
  assert.ok(STAGING_PATH.endsWith(join('data', 'audit', 'owe-venue-candidates.json')));
});

test('writeStagingCandidates + loadStaging round-trip, with hash-based de-dupe', (t) => {
  const backup = fs.existsSync(STAGING_PATH) ? fs.readFileSync(STAGING_PATH, 'utf8') : null;
  t.after(() => {
    if (backup === null) { try { fs.unlinkSync(STAGING_PATH); } catch {} }
    else fs.writeFileSync(STAGING_PATH, backup);
  });

  writeStagingCandidates([]); // start from a clean slate for this test
  fs.writeFileSync(STAGING_PATH, '[]');

  const candidateA = { title: 'Space Dogs', venue: 'The Other Palace', slug: 'space-dogs', category: 'off-west-end', source: 'venue-page:the-other-palace' };
  const candidateB = { title: 'The Producers', venue: 'Menier Chocolate Factory', slug: 'the-producers', category: 'off-west-end', source: 'venue-page:menier-chocolate-factory' };

  writeStagingCandidates([candidateA, candidateB]);
  let staged = loadStaging();
  assert.equal(staged.length, 2);
  assert.ok(staged.every(c => typeof c.candidateHash === 'string' && c.candidateHash === candidateHash(c)));
  assert.ok(staged.every(c => typeof c.discoveredAt === 'string'));

  // Re-staging the same {title, venue} upserts (same candidateHash), not duplicates.
  writeStagingCandidates([{ ...candidateA, slug: 'space-dogs-refreshed' }]);
  staged = loadStaging();
  assert.equal(staged.length, 2, 're-staging an existing candidate must upsert by hash, not duplicate');
  const refreshed = staged.find(c => c.candidateHash === candidateHash(candidateA));
  assert.equal(refreshed.slug, 'space-dogs-refreshed');
});

test('writeStagingCandidates normalizes discoverySource to source (matches OB candidate shape)', (t) => {
  const backup = fs.existsSync(STAGING_PATH) ? fs.readFileSync(STAGING_PATH, 'utf8') : null;
  t.after(() => {
    if (backup === null) { try { fs.unlinkSync(STAGING_PATH); } catch {} }
    else fs.writeFileSync(STAGING_PATH, backup);
  });
  fs.writeFileSync(STAGING_PATH, '[]');

  // fetchSingleVenuePage's real candidate shape carries discoverySource, not source.
  const raw = { title: 'Foalby', venue: 'Southwark Playhouse', slug: 'foalby', category: 'off-west-end', discoverySource: 'venue-page:southwark-playhouse' };
  writeStagingCandidates([raw]);
  const [staged] = loadStaging();
  assert.equal(staged.source, 'venue-page:southwark-playhouse', 'a future promoter reads c.source (like promote-ob-venue-candidates.js) — it must not be undefined');
});

// --- Structural: discover-new-shows.js must route OWE venue candidates
// through staging, and must NOT merge them into the shows.json write path ---

test('discover-new-shows.js imports writeStagingCandidates from lib/owe-venue-staging', () => {
  const src = readFileSync(join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/lib\/owe-venue-staging['"]\)/.test(src),
    'discover-new-shows.js no longer requires ./lib/owe-venue-staging — the OWE staging gate was removed'
  );
});

test('OWE venue-page candidates (venueShows) are staged, not pushed into discoveredShows', () => {
  const src = readFileSync(join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');

  assert.ok(
    /writeOweStagingCandidates\(venueShows\)/.test(src),
    'discover-new-shows.js must call writeOweStagingCandidates(venueShows) to stage OWE venue-page candidates'
  );

  // The final push into discoveredShows (which the rest of the pipeline
  // writes straight to shows.json) must NOT include venueShows anymore.
  const pushMatch = src.match(/discoveredShows\.push\(\.\.\.todayTixWEShows[^)]*\);/);
  assert.ok(pushMatch, 'expected to find the West End discoveredShows.push(...) call');
  assert.ok(
    !/venueShows/.test(pushMatch[0]),
    `OWE venue-page candidates must not be merged directly into discoveredShows (found in: ${pushMatch[0]}) — ` +
      'this is the exact regression BRO-182 fixed (candidates landing in shows.json without review)'
  );
});
