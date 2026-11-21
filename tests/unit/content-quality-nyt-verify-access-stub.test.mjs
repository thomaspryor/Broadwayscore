/**
 * Regression test: NYT "verify access" interstitial detected as severe truncation.
 *
 * Bug class: A second NYT bot-stub variant — "Thank you for your patience while we
 * verify access" — was NOT in TRUNCATION_SIGNALS.severeAnywhere. Files that got the
 * access-verification interstitial mid-scrape were short (<4k chars) but classified as
 * 'complete' because the pattern didn't appear in the 70% window and had no severeAnywhere
 * match. 6 files affected across 5 shows (2026-06-09 audit).
 *
 * Fix: Added /thank\s+you\s+for\s+your\s+patience\s+while\s+we\s+verify\s+access/i
 * to TRUNCATION_SIGNALS.severeAnywhere.
 *
 * Per CLAUDE.md §15: require() the real function; never duplicate logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyContentTier, detectTruncationSignals, TRUNCATION_SIGNALS } =
  require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));

// Simulate a short NYT access-verification page served instead of the article.
// These are short (<4k chars), so the stub is within the text but often at >70%.
const VERIFY_ACCESS_STUB = '\n\nThank you for your patience while we verify access.\n\nAlready a subscriber? Log in.\n\nWant all of The Times? Subscribe.';

// ~350 words of plausible theater review prose (>300-word threshold for 'complete')
const SHORT_REVIEW_PROSE = `The revival of "Betrayal" at the Jacobs Theatre opens with Harold Pinter at his most enigmatic — a play structured in reverse chronology, demanding the audience piece together a love triangle from its fragments. Tom Hiddleston brings a coiled intensity to the role of Robert, a man who has absorbed a betrayal and allows it to fester in silence until the final scene (the first, chronologically). Zawe Ashton is quietly devastating as Emma, navigating regret without sentimentality. Charlie Cox's Jerry, the betrayer, is rendered with enough charm that you understand the temptation and enough weakness that you can't forgive it. Ivo van Hove's staging strips the play to almost nothing — bare stage, single table — letting Pinter's pauses do the architectural work. The result is theater that trusts its audience completely. There is something almost clinical about the way Pinter divides knowledge between characters and audience, giving us everything while withholding the emotional weight of the revelations until later scenes that, chronologically speaking, are earlier moments. The set — a spare collection of furniture suggesting hotel rooms, offices, and suburban kitchens — serves its purpose without comment. The direction enforces a tension that never quite breaks; scenes end before the air fully clears. What lingers is not the affair itself but the question of what the three characters actually wanted from each other beyond the affair: friendship, perhaps, or the simple comfort of being known by someone other than a spouse. Hiddleston, in his final monologue, gives the play its beating heart: a man who could have confronted and didn't, who chose knowledge over action, and now sits with both. It is a production that makes the case for Pinter's continued relevance not through concept or spectacle but through sheer fidelity to the text.`;

const NYT_VERIFY_ACCESS_TEXT = SHORT_REVIEW_PROSE + VERIFY_ACCESS_STUB;

test('NYT verify-access stub is in severeAnywhere array', () => {
  assert.ok(Array.isArray(TRUNCATION_SIGNALS.severeAnywhere), 'severeAnywhere should be an array');
  const testText = 'Thank you for your patience while we verify access.';
  const matches = TRUNCATION_SIGNALS.severeAnywhere.some(p => p.test(testText));
  assert.ok(matches, 'severeAnywhere should contain a pattern matching the verify-access text');
});

test('detectTruncationSignals finds nyt_bot_stub in verify-access file', () => {
  const result = detectTruncationSignals(NYT_VERIFY_ACCESS_TEXT);
  assert.ok(result.signals.includes('nyt_bot_stub'),
    `expected nyt_bot_stub in signals, got: ${JSON.stringify(result.signals)}`);
  assert.ok(result.severeCount > 0, 'expected severeCount > 0');
});

test('classifyContentTier returns truncated (not complete) for verify-access file', () => {
  const review = {
    showId: 'betrayal-2019',
    outletId: 'nytimes',
    fullText: NYT_VERIFY_ACCESS_TEXT,
  };
  const result = classifyContentTier(review);
  assert.notEqual(result.contentTier, 'complete',
    `expected NOT 'complete', got '${result.contentTier}' (tierReason: ${result.tierReason})`);
  // Should be truncated or stub — either is acceptable for re-collection routing
  assert.ok(['truncated', 'stub'].includes(result.contentTier),
    `expected 'truncated' or 'stub', got '${result.contentTier}'`);
});

test('verify-access pattern with variant casing is matched (case-insensitive)', () => {
  const variants = [
    'Thank you for your patience while we verify access.',
    'THANK YOU FOR YOUR PATIENCE WHILE WE VERIFY ACCESS.',
    'Thank  you  for  your  patience  while  we  verify  access.', // extra spaces
  ];
  for (const v of variants) {
    const matches = TRUNCATION_SIGNALS.severeAnywhere.some(p => p.test(v));
    assert.ok(matches, `pattern should match variant: "${v}"`);
  }
});

test('clean NYT review without verify-access stub is still classified as complete (no regression)', () => {
  const cleanEnding = ' The direction, design, and performances cohere into something genuinely memorable.';
  const cleanReview = {
    showId: 'betrayal-2019',
    outletId: 'nytimes',
    fullText: SHORT_REVIEW_PROSE + cleanEnding,
  };
  const result = classifyContentTier(cleanReview);
  assert.equal(result.contentTier, 'complete',
    `expected 'complete' for clean review, got '${result.contentTier}' (tierReason: ${result.tierReason})`);
});
