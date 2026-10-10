/**
 * detectConcatenatedArticles unique-match regression test.
 *
 * A review that legitimately mentions the same theater multiple times (opening
 * para, lede, production-info footer, photo credit) was being flagged as
 * multi-article concatenation by ARTICLE_BOUNDARY_PATTERNS counting raw matches.
 *
 * Regression trigger: Theatre Reviews Limited's Schmigadoon review 2026-04-23.
 * Text had 4 "at the Nederlander Theatre" mentions → boundary count 4 → tripped
 * the 3+ gate → classified as scraper_garbage → silently skipped by LLM scoring.
 * Fix: dedupe on the normalized matched substring. 4 mentions of one theater =
 * 1 unique signal (not a concatenation). 3 different theaters still flags.
 *
 * See memory/feedback_article_boundary_dedupe.md and
 * Broadwayscore commit history for the full incident.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = join(import.meta.dirname, '..', '..');
const { detectConcatenatedArticles } = require(
  join(ROOT, 'scripts/lib/content-quality.js')
);

// 600+ char fill so the 500-char floor in detectConcatenatedArticles is cleared.
const FILL = 'The production delivers charm, wit, and stagecraft across a spirited ensemble. '
  + 'The score pays homage to golden-age standards with clever lyrical turns and sharp ensemble numbers. '
  + 'Performances are crisp, costumes are radiant, and the pacing never flags. '
  + 'The director keeps every beat humming and the choreography lands every joke. '
  + 'There are moments of real tenderness tucked inside the pastiche that linger after the curtain. '
  + 'The band sounds full, the dance breaks are infectious, and the leads carry the heart of the evening. ';

test('Single-article review with repeated same-theater mentions is NOT flagged as concatenation', () => {
  // 4 mentions of "at the Nederlander Theatre" — one article, one theater.
  // Old behavior: 4 >= 3 → flagged. New behavior: 1 unique → not flagged.
  const text =
    'Broadway Review Schmigadoon! opens at the Nederlander Theatre tonight. '
    + FILL
    + 'The show plays at the Nederlander Theatre through September. '
    + FILL
    + 'Ensemble numbers fill the Nederlander Theatre with joy. '
    + FILL
    + 'Schmigadoon! runs at the Nederlander Theatre (208 West 41st Street).';

  const result = detectConcatenatedArticles(text, 'schmigadoon-2026');
  assert.strictEqual(
    result.detected,
    false,
    `Single-theater repetition should not be flagged as concatenation. ` +
      `Got: ${result.reason}. The dedupe must count unique matches, not raw count.`
  );
});

test('True concatenation with DIFFERENT theaters IS flagged', () => {
  // 3 distinct theaters from the ARTICLE_BOUNDARY_PATTERNS allowlist.
  // Avoid naming real shows here — would short-circuit via the detectMultiShow
  // branch instead of exercising the boundary-count branch we're testing.
  // Use connectors from the pattern list: playing|running|opens|opened|performs|
  // performing|staged|is. ("runs" is plural-3rd-person, NOT in the list — the
  // existing patterns only catch the gerund "running". Not the test's concern.)
  const text =
    'A new revue opens at the Winter Garden Theatre tonight. '
    + FILL
    + 'A separate revival is running at the Lyceum Theatre downtown. '
    + FILL
    + 'And in a third engagement, an intimate play is staged at the Belasco Theatre this week. '
    + FILL;

  const result = detectConcatenatedArticles(text, 'test-show');
  assert.strictEqual(
    result.detected,
    true,
    'Three different theater mentions should still flag as concatenation. ' +
      `Got: detected=${result.detected}, reason=${result.reason}`
  );
  assert.match(
    result.reason || '',
    /unique/i,
    'Reason string should mention unique-count for debuggability'
  );
});

test('Two different theater mentions are NOT flagged (threshold is 3+ unique)', () => {
  // The check is >= 3 unique. 2 unique shouldn't trip it.
  const text =
    'The show opens at the Majestic Theatre next month. '
    + FILL
    + 'Tickets are also available at the Shubert Theatre box office. '
    + FILL;

  const result = detectConcatenatedArticles(text, 'test-show');
  assert.strictEqual(
    result.detected,
    false,
    'Two unique theater mentions should NOT trigger concatenation detection ' +
      '(threshold is 3+). Multi-show false positive would block legitimate ' +
      'comparative reviews.'
  );
});

test('Short text (<500 chars) is never flagged regardless of match count', () => {
  const text = 'Quick one-liner playing at the Nederlander Theatre, at the Shubert Theatre, at the Majestic Theatre.';
  const result = detectConcatenatedArticles(text, 'test-show');
  assert.strictEqual(result.detected, false, '500-char floor protects snippets');
});
