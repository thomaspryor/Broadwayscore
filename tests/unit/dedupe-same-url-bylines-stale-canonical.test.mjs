/**
 * Regression test (BRO-318): dedupe-same-url-bylines.js's fix() must clear a
 * STALE duplicateOf/duplicateTextOf the chosen canonical carries at one of
 * its own new losers.
 *
 * queen-versailles-2025's Vulture review was scraped under two split bylines
 * (David Fox, Sara Holdren) plus the real co-byline ("Sara Holdren and Jesse
 * David Fox"). The byline-explosion collapse correctly marked the two split
 * files duplicateOf the co-byline canonical — but the canonical itself still
 * carried a duplicateTextOf pointer at one of them, left over from an earlier
 * collect-time content-fingerprint pass. That made the pair mutually point at
 * each other, which rebuild-all-reviews.js's one-hop circular-recovery logic
 * reads as "ambiguous — keep both," handing the decision to the fingerprint
 * dedup — a check with no idea which side is canonical. It kept the loser by
 * file sort order and silently dropped the canonical, producing a duplicate
 * URL in reviews.json (the exact validate-data.js error that reddened main).
 *
 * REVIEW_TEXTS_DIR must be set BEFORE dedupe-same-url-bylines.js is required
 * (it reads the env var once, at module load, into a top-level const) — this
 * file requires it dynamically after setting the env var for that reason.
 *
 * Run: node --test tests/unit/dedupe-same-url-bylines-stale-canonical.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const REVIEW_TEXTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-stale-canon-'));
process.env.REVIEW_TEXTS_DIR = REVIEW_TEXTS_DIR;
const { fix } = require('../../scripts/dedupe-same-url-bylines.js');

const body = (n) => 'x'.repeat(n);

test('fix(): clears a stale duplicateTextOf the canonical carries at its own new loser', () => {
  const showId = 'queen-versailles-2025';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir);

  const canonName = 'vulture--sara-holdren-and-jesse-david-fox.json';
  const loserName = 'vulture--david-fox.json';

  // Canonical carries a stale duplicateTextOf pointer at the file this same
  // fix() call is about to subordinate to it — the exact corruption pattern.
  fs.writeFileSync(path.join(showDir, canonName), JSON.stringify({
    showId, outletId: 'vulture', criticName: 'Sara Holdren and Jesse David Fox',
    url: 'https://www.vulture.com/article/theater-review-queen-of-versailles.html',
    fullText: body(3000), duplicateOf: null, duplicateTextOf: loserName,
  }));
  fs.writeFileSync(path.join(showDir, loserName), JSON.stringify({
    showId, outletId: 'vulture', criticName: 'David Fox',
    url: 'https://www.vulture.com/article/theater-review-queen-of-versailles.html',
    fullText: body(3000),
  }));

  const cohesive = [{ showId, canonical: canonName, losers: [loserName] }];
  const r = fix(cohesive);

  const canonData = JSON.parse(fs.readFileSync(path.join(showDir, canonName), 'utf-8'));
  assert.equal(canonData.duplicateOf, null, 'canonical must stay primary');
  // duplicateTextOf must be DELETED, not nulled — a null duplicateTextOf is
  // itself a validate-data.js warning (scripts/lib/canonical-duplicate-
  // pointers.js's documented null-vs-delete distinction).
  assert.equal('duplicateTextOf' in canonData, false, 'stale self-pointer must be deleted, not nulled');
  assert.match(canonData.duplicateClearReason, /pointed back into its own byline cluster/);

  const loserData = JSON.parse(fs.readFileSync(path.join(showDir, loserName), 'utf-8'));
  assert.equal(loserData.duplicateOf, canonName, 'loser must be marked duplicate of the canonical');

  assert.equal(r.staleCanonicalPointerCleared, 1);
  assert.equal(r.losersMarked, 1);
});

test('fix(): does not touch a canonical with no stale pointer at its losers', () => {
  const showId = 'some-show-2026';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir);

  const canonName = 'outlet--critic-a.json';
  const loserName = 'outlet--critic-b.json';
  const url = 'https://example.com/review';

  fs.writeFileSync(path.join(showDir, canonName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic A', url, fullText: body(3000),
  }));
  fs.writeFileSync(path.join(showDir, loserName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic B', url, fullText: body(3000),
  }));

  const cohesive = [{ showId, canonical: canonName, losers: [loserName] }];
  const r = fix(cohesive);

  assert.equal(r.staleCanonicalPointerCleared, 0);
  const canonData = JSON.parse(fs.readFileSync(path.join(showDir, canonName), 'utf-8'));
  assert.equal(canonData.duplicateOf, undefined);
});
