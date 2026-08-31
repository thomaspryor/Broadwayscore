/**
 * Regression test: NYT bot-stub text must not reach the LLM scorer (BRO-36).
 *
 * Bug class: scripts/lib/content-quality.js's classifyContentTier() correctly
 * labels NYT bot-stub reviews contentTier='truncated' (see
 * content-quality-nyt-bot-stub.test.mjs), but scripts/lib/text-quality.js is a
 * SEPARATE truncation-detection module — the one getBestTextForScoring() uses to
 * build the text actually sent to the LLM scorer (via
 * scripts/llm-scoring/input-builder.ts). It was blind to the stub: it returned
 * status='complete'/confidence='high' and included the raw "enable JavaScript"
 * chrome verbatim in the scoring text, even for reviews already correctly
 * labeled contentTier='truncated' elsewhere in the pipeline.
 *
 * Fix: text-quality.js now imports content-quality.js's canonical
 * TRUNCATION_SIGNALS.severeAnywhere patterns (single source of truth — no
 * re-declared regex copy) and uses them in three places: checkTruncation()
 * (signal detection), stripTrailingJunk() (physically strips the raw stub text
 * before cleanText() output reaches the LLM), and assessFullText() (an early
 * raw-text check before cleaning, because an unrelated photo-credit-stripping
 * regex in cleanText() can collaterally eat part of the stub and leave a
 * coincidentally-proper-ending remainder that would otherwise misclassify as
 * 'complete').
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
const { checkTruncation, assessFullText, cleanText, getBestTextForScoring } =
  require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'text-quality.js'));

// ~300 words of plausible theater review prose (2200 chars before stub).
const REVIEW_PROSE = `The revival of "She Loves Me" at Studio 54 is an absolute delight, a confection of a musical that leaves you grinning from the first note to the last. Daniel Sullivan's production captures every note of Sheldon Harnick and Jerry Bock's score with crystalline clarity, and Laura Benanti's Amalia is a revelation — a woman brittle with defensiveness who melts into something wholly vulnerable by the second act. The supporting ensemble performs with surgical precision, particularly Zachary Levi as Georg, whose character arc from oblivious antagonist to tender suitor is rendered with such naturalistic ease that you forget you are watching a performance at all. The set design, a collection of interlocking storefronts and apartments that glide together like puzzle pieces, does everything practical staging should: it clarifies geography while remaining invisible to the eye. The costumes shimmer. The lighting is warm without being saccharine. One worries whether a show this wholesome can sustain ninety minutes of unbroken delight, but the musical somehow does it, threading genuine emotional stakes — longing, loneliness, the fear of being seen and found wanting — through what might have been mere romantic whimsy. It is the kind of production that reminds you why people invented musical theater in the first place: not to say something important, but to make the audience feel something true. If there is a weakness, it lies in the first act's pacing, which occasionally stalls as it sets the pieces in place for the second. But these are minor quibbles against a production of such exquisite craftsmanship.`;

const NYT_STUB = '\n\nWe are having trouble retrieving the article content.\n\nPlease enable JavaScript in your browser settings.\n\nThank you for your patience while we verify access.';

const NYT_STUB_TEXT = REVIEW_PROSE + NYT_STUB;

// Reproduces the real-world "Credit... Photographer Name We are having trouble..."
// interaction: cleanText()'s Credit-stripping regex collaterally eats the first
// stub sentence, leaving only "Please enable JavaScript..." to survive cleaning.
const CREDIT_COLLATERAL_TEXT = REVIEW_PROSE +
  '\n\nCredit... Sara Krulwich/The New York Times ' +
  'We are having trouble retrieving the article content. ' +
  'Please enable JavaScript in your browser settings. ' +
  'Thank you for your patience while we verify access. ' +
  'Already a subscriber? Log in.';

test('checkTruncation flags NYT bot-stub text', () => {
  const result = checkTruncation(NYT_STUB_TEXT);
  assert.ok(result.isTruncated, 'expected isTruncated true for bot-stub text');
  assert.ok(result.signals.includes('bot-wall-stub'),
    `expected 'bot-wall-stub' in signals, got: ${JSON.stringify(result.signals)}`);
});

test('checkTruncation does not flag clean review prose', () => {
  const cleanEnding = '\n\nIn the end, "She Loves Me" reminds us why the American musical still matters.';
  const result = checkTruncation(REVIEW_PROSE + cleanEnding);
  assert.ok(!result.signals.includes('bot-wall-stub'), 'clean text should not carry bot-wall-stub signal');
});

test('cleanText strips the raw NYT bot-stub text entirely', () => {
  const cleaned = cleanText(NYT_STUB_TEXT);
  assert.ok(!/trouble\s+retrieving/i.test(cleaned), 'stub JS-loader sentence must not survive cleaning');
  assert.ok(!/enable\s+javascript/i.test(cleaned), 'enable-javascript fragment must not survive cleaning');
  assert.ok(!/verify\s+access/i.test(cleaned), 'verify-access fragment must not survive cleaning');
});

test('cleanText strips the stub even when a photo-credit regex eats the first sentence', () => {
  // Regression for the collateral-stripping interaction: Credit\s*\.{3}[^.]+\.
  // can consume "We are having trouble retrieving the article content." as part
  // of the credit match, leaving "Please enable JavaScript..." dangling.
  const cleaned = cleanText(CREDIT_COLLATERAL_TEXT);
  assert.ok(!/enable\s+javascript/i.test(cleaned),
    `enable-javascript fragment leaked through collateral-stripping interaction: ${JSON.stringify(cleaned.slice(-200))}`);
  assert.ok(!/verify\s+access/i.test(cleaned), 'verify-access fragment must not survive cleaning');
});

test('assessFullText returns truncated (not complete) for NYT bot-stub file', () => {
  const status = assessFullText(NYT_STUB_TEXT, true);
  assert.equal(status, 'truncated', `expected 'truncated', got '${status}'`);
});

test('assessFullText returns truncated even when the pre-stub prose ends with proper punctuation', () => {
  // The raw-text bot-stub check runs BEFORE cleaning, so a coincidentally
  // well-punctuated remainder after stripping must not misclassify as complete.
  const status = assessFullText(CREDIT_COLLATERAL_TEXT, true);
  assert.equal(status, 'truncated', `expected 'truncated', got '${status}'`);
});

test('assessFullText returns complete for real review without bot stub (no regression)', () => {
  const cleanEnding = '\n\nIn the end, "She Loves Me" reminds us why the American musical still matters. ' +
    'It is a show about ordinary people finding courage in small moments — writing letters, ' +
    'delivering parcels, closing a cash register — and discovering that the world is kinder ' +
    'than they feared. Sullivan and his cast honor that vision completely. Do not miss it.';
  const status = assessFullText(REVIEW_PROSE + cleanEnding, true);
  assert.equal(status, 'complete', `expected 'complete', got '${status}'`);
});

test('getBestTextForScoring returns truncated status and stub-free text for a bot-stub review', () => {
  const review = {
    showId: 'she-loves-me-2016',
    outletId: 'nytimes',
    fullText: NYT_STUB_TEXT,
  };
  const result = getBestTextForScoring(review);
  assert.equal(result.status, 'truncated', `expected 'truncated', got '${result.status}'`);
  assert.notEqual(result.confidence, 'high', 'bot-stub text must not score high confidence');
  assert.ok(!/enable\s+javascript/i.test(result.text || ''),
    'LLM-facing scoring text must not contain the raw bot-stub chrome');
});

test('getBestTextForScoring returns high confidence for a real complete review (no regression)', () => {
  const cleanEnding = '\n\nIn the end, "She Loves Me" reminds us why the American musical still matters. ' +
    'It is a show about ordinary people finding courage in small moments. Do not miss it.';
  const review = {
    showId: 'she-loves-me-2016',
    outletId: 'nytimes',
    fullText: REVIEW_PROSE + cleanEnding,
  };
  const result = getBestTextForScoring(review);
  assert.equal(result.status, 'complete', `expected 'complete', got '${result.status}'`);
});
