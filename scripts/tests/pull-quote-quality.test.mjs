/**
 * Corpus-wide pull-quote quality guard (card em-20260801-000455 / #727 / #728,
 * re-armed 2026-08-16 as a P1: "bad and missing pull quotes on new and recent
 * BW and WE shows").
 *
 * Requires the real production function via require() (CLAUDE.md rule 15) —
 * findBadPullQuotes is the same corpus scan audit-pull-quotes.js runs from the
 * CLI, so a regression here fails this test the same way it would fail a
 * manual `node scripts/audit-pull-quotes.js --fail-on-hit` run.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { findBadPullQuotes } = require('../audit-pull-quotes.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
// Same env-override convention as audit-pull-quotes.js — lets this run against
// a real checkout from a worktree that doesn't clone the private review-texts
// repo (see CLAUDE.md §11 / memory/private-repos.md).
const REVIEWS_FILE = process.env.REVIEWS_FILE || path.join(ROOT, 'data', 'reviews.json');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');

function loadReviews() {
  if (!fs.existsSync(REVIEWS_FILE)) return null;
  return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8')).reviews || [];
}

describe('pull-quote corpus quality guard', () => {
  test('no shipped pull quote trips a hard guard (listing chrome / tag cloud / mid-word truncation / promo teaser / internal note / copyright chrome)', () => {
    const reviews = loadReviews();
    if (!reviews) return; // data/reviews.json not checked out in this environment
    const badQuotes = findBadPullQuotes(reviews, REVIEW_TEXTS_DIR);
    if (badQuotes.length) {
      const preview = badQuotes
        .slice(0, 10)
        .map(b => `  ${b.showId}/${b.outletId} [${b.reason}]: ${JSON.stringify(b.pullQuote.slice(0, 100))}`)
        .join('\n');
      assert.fail(`${badQuotes.length} shipped pull quote(s) trip a hard guard:\n${preview}`);
    }
  });

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
