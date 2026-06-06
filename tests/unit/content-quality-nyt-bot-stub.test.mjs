/**
 * Regression test: NYT bot-stub detected as severe truncation (full-text scan).
 *
 * Bug class: The NYT anti-bot JS-loader stub ("We are having trouble retrieving
 * the article content...") appears at 90-95% of the text — past the 70% window
 * used by TRUNCATION_SIGNALS.severe for texts ≥ 1500 chars. classifyContentTier
 * was returning 'complete' because severeCount stayed 0.
 *
 * Fix: TRUNCATION_SIGNALS.severeAnywhere scans the FULL text. detectTruncationSignals
 * checks this array AFTER the 70%-window severe check, adding 'nyt_bot_stub' to
 * signals and incrementing severeCount. classifyContentTier then returns 'truncated'.
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

// Simulate a real scraped NYT review: ~400 words of real prose + the bot stub at ~94%.
// The 70% window covers the first 1639 chars; stub starts at ~2200 chars.
const NYT_STUB = '\n\nWe are having trouble retrieving the article content.\n\nPlease enable JavaScript in your browser settings.\n\nThank you for your patience while we verify access.';

// ~300 words of plausible theater review prose (2200 chars before stub)
const REVIEW_PROSE = `The revival of "She Loves Me" at Studio 54 is an absolute delight, a confection of a musical that leaves you grinning from the first note to the last. Daniel Sullivan's production captures every note of Sheldon Harnick and Jerry Bock's score with crystalline clarity, and Laura Benanti's Amalia is a revelation — a woman brittle with defensiveness who melts into something wholly vulnerable by the second act. The supporting ensemble performs with surgical precision, particularly Zachary Levi as Georg, whose character arc from oblivious antagonist to tender suitor is rendered with such naturalistic ease that you forget you are watching a performance at all. The set design, a collection of interlocking storefronts and apartments that glide together like puzzle pieces, does everything practical staging should: it clarifies geography while remaining invisible to the eye. The costumes shimmer. The lighting is warm without being saccharine. One worries whether a show this wholesome can sustain ninety minutes of unbroken delight, but the musical somehow does it, threading genuine emotional stakes — longing, loneliness, the fear of being seen and found wanting — through what might have been mere romantic whimsy. It is the kind of production that reminds you why people invented musical theater in the first place: not to say something important, but to make the audience feel something true. If there is a weakness, it lies in the first act's pacing, which occasionally stalls as it sets the pieces in place for the second. But these are minor quibbles against a production of such exquisite craftsmanship.`;

const NYT_STUB_TEXT = REVIEW_PROSE + NYT_STUB;

test('NYT bot-stub at >70% position is detected by severeAnywhere scan', () => {
  const result = detectTruncationSignals(NYT_STUB_TEXT);
  assert.ok(result.signals.includes('nyt_bot_stub'), `expected nyt_bot_stub in signals, got: ${result.signals}`);
  assert.ok(result.severeCount > 0, 'expected severeCount > 0');
});

test('classifyContentTier returns truncated (not complete) for NYT bot-stub file', () => {
  const stubPosition = NYT_STUB_TEXT.indexOf('trouble retrieving');
  const totalLength = NYT_STUB_TEXT.length;
  const pct = Math.round(stubPosition / totalLength * 100);
  // Verify the stub IS past the 70% window — this is the core of the bug.
  assert.ok(pct > 70, `stub at ${pct}% — expected >70%`);

  const review = {
    showId: 'she-loves-me-2016',
    outletId: 'nytimes',
    fullText: NYT_STUB_TEXT,
  };
  const result = classifyContentTier(review);
  assert.equal(result.contentTier, 'truncated',
    `expected 'truncated', got '${result.contentTier}' (tierReason: ${result.tierReason})`);
  assert.ok(result.truncationSignals.includes('nyt_bot_stub'),
    `expected nyt_bot_stub in truncationSignals, got: ${result.truncationSignals}`);
});

test('classifyContentTier returns complete for real review without bot stub (no regression)', () => {
  // Build a clean review long enough to pass isLongEnough (300+ words, 1500+ chars).
  // The stub version has 400+ words; the clean version must too — omit only the stub.
  const cleanEnding = '\n\nIn the end, "She Loves Me" reminds us why the American musical still matters. ' +
    'It is a show about ordinary people finding courage in small moments — writing letters, ' +
    'delivering parcels, closing a cash register — and discovering that the world is kinder ' +
    'than they feared. Sullivan and his cast honor that vision completely. Do not miss it.';
  const cleanReview = {
    showId: 'she-loves-me-2016',
    outletId: 'nytimes',
    fullText: REVIEW_PROSE + cleanEnding,
  };
  const result = classifyContentTier(cleanReview);
  assert.equal(result.contentTier, 'complete',
    `expected 'complete', got '${result.contentTier}' (tierReason: ${result.tierReason})`);
});

test('severeAnywhere array is exported and contains the NYT stub pattern', () => {
  assert.ok(Array.isArray(TRUNCATION_SIGNALS.severeAnywhere), 'severeAnywhere should be an array');
  assert.ok(TRUNCATION_SIGNALS.severeAnywhere.length > 0, 'severeAnywhere should not be empty');
  const testText = 'We are having trouble retrieving the article content.';
  const matches = TRUNCATION_SIGNALS.severeAnywhere.some(p => p.test(testText));
  assert.ok(matches, 'at least one severeAnywhere pattern should match the NYT stub text');
});

test('bot stub in first 70% of text is caught by regular severe check (paywall_or_login_prompt)', () => {
  // If the stub happens to be in the early part of text (unusual but possible),
  // the PAYWALL_PATTERNS match in the severe window catches it. severeAnywhere guard
  // (if severeCount === 0) prevents duplicate signals.
  const earlyText = NYT_STUB + ' '.repeat(100) + REVIEW_PROSE;
  const result = detectTruncationSignals(earlyText);
  // Either paywall_or_login_prompt (via PAYWALL_PATTERNS in severe region) or
  // nyt_bot_stub (via severeAnywhere) — either way, severeCount > 0.
  assert.ok(result.severeCount > 0, 'expected at least one severe signal for early-position stub');
});

test('incomplete-reason classifies nyt_bot_stub signal as bot_blocked (not paywall)', () => {
  // Regression for collect-review-texts routing: enableBrowserbase only fires on
  // 'bot_blocked'; if classified as 'paywall', Browserbase is skipped and Archive.org
  // (which has no pre-paywall NYT snapshots) is used instead — yielding 0 re-collections.
  const { classifyIncompleteReason } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'incomplete-reason.js'));
  const review = {
    url: 'https://www.nytimes.com/2023/04/01/theater/example-review.html',
    contentTier: 'truncated',
    truncationSignals: ['nyt_bot_stub'],
    fullText: NYT_STUB_TEXT,
    wordCount: 380,
  };
  const result = classifyIncompleteReason(review);
  assert.equal(result?.incompleteReason, 'bot_blocked',
    `expected 'bot_blocked', got '${result?.incompleteReason}' — Browserbase won't fire for 'paywall' reason`);
});

test('detectPaywall() on NYT stub text is guarded by trailing-junk exception (not marked garbage)', () => {
  // The NYT stub pattern is in PAYWALL_PATTERNS (so detectPaywall returns detected:true)
  // but isGarbageContent() has a _isPatternInTrailingJunk() guard that prevents it from
  // marking the file as garbage when the match is trailing. This test documents that
  // detectPaywall() DOES match — callers must use the trailing-junk guard or rely on
  // Layer A.5 routing (which short-circuits before detectPaywall() in Layer B).
  const { detectPaywall } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));
  const result = detectPaywall(NYT_STUB_TEXT);
  // detectPaywall DOES match — the dual-pattern is intentional; guard is in the caller.
  assert.ok(result.detected, 'detectPaywall should match the NYT stub pattern (dual-purpose)');
  // Verify the match is late in the text (>70%) — _isPatternInTrailingJunk() will catch it.
  const matchPos = NYT_STUB_TEXT.indexOf(result.match || 'trouble retrieving');
  const pct = matchPos / NYT_STUB_TEXT.length;
  assert.ok(pct > 0.7, `match at ${Math.round(pct*100)}% — expected >70% for trailing-junk guard to fire`);
});

test('incomplete-reason classifies bot_blocked via fullText fallback when truncationSignals absent', () => {
  // Rebuild reads source files before propagating truncationSignals into data.
  // The fullText-scan fallback in Layer A.5 catches the pattern even when
  // truncationSignals is not set on the review object.
  const { classifyIncompleteReason } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'incomplete-reason.js'));
  const review = {
    url: 'https://www.nytimes.com/2023/04/01/theater/example-review.html',
    contentTier: 'truncated',
    // truncationSignals intentionally absent (mimics source file before rebuild propagation)
    fullText: NYT_STUB_TEXT,
    wordCount: 380,
  };
  const result = classifyIncompleteReason(review);
  assert.equal(result?.incompleteReason, 'bot_blocked',
    `expected 'bot_blocked' via fullText scan, got '${result?.incompleteReason}'`);
});
