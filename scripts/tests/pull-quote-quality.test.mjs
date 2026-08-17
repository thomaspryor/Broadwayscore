/**
 * Pull-quote quality regression test (card em-20260801-000455 / #727 / #728,
 * re-armed 2026-08-16 as a P1: "bad and missing pull quotes on new and recent
 * BW and WE shows").
 *
 * The corpus-wide 0-hard-guard-hits scan (findBadPullQuotes(), same function
 * `node scripts/audit-pull-quotes.js --fail-on-hit` runs) lives in
 * check-corpus-drift.js instead of here — new reviews land continuously via
 * automated ingestion, so a blocking per-push assertion over the whole corpus
 * would red main for non-code reasons (the exact flap check-corpus-drift.yml
 * exists to absorb; second-opinion review 2026-08-17). This file keeps only
 * the pinned regression for the named case, which IS code-relevant: it fails
 * only if the extraction/fallback pipeline actually regresses.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
// Same env-override convention as audit-pull-quotes.js — lets this run against
// a real checkout from a worktree that doesn't clone the private review-texts
// repo (see CLAUDE.md §11 / memory/private-repos.md).
const REVIEWS_FILE = process.env.REVIEWS_FILE || path.join(ROOT, 'data', 'reviews.json');

function loadReviews() {
  if (!fs.existsSync(REVIEWS_FILE)) return null;
  return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8')).reviews || [];
}

describe('pull-quote corpus quality guard', () => {
  test('Les Misérables Arena Concert / Cititour has a real pull quote, not empty or a plot-summary fragment', () => {
    const reviews = loadReviews();
    if (!reviews) return;
    const r = reviews.find(
      x => x.showId === 'les-miserables-arena-concert-spectacular-off-broadway-2026' && x.outletId === 'cititour'
    );
    if (!r) return; // review removed/renamed since — not this test's concern
    assert.ok(
      r.pullQuote && r.pullQuote.trim().length >= 40,
      `expected a substantial pull quote, got ${JSON.stringify(r.pullQuote)}`
    );
    // The bug this review shipped with: no llmPullQuote, so selectBestExcerpt
    // fell back to a raw-fullText scrape that opened on a parenthetical aside
    // about a cast member's other credits instead of a verdict sentence.
    // A quote starting with "(" is the fingerprint of that fallback path.
    assert.ok(
      !/^[\s"'“‘]*\(/.test(r.pullQuote),
      `pull quote opens with a parenthetical aside — sign of the raw-fullText fallback, not a curated quote: ${JSON.stringify(r.pullQuote)}`
    );
  });
});
