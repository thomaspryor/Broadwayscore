/**
 * Regression test: Path-3 short-capsule-review fallback misclassifying legit
 * WSJ (Terry Teachout-era) capsule reviews as truncated.
 *
 * Bug (task #860): Path 3 in classifyContentTier requires wordCount>=150,
 * a proper ending, zero truncation signals, looseExcerptCheck, AND
 * hasOpinionLanguage(fullText). Terry Teachout's WSJ drama column runs
 * 150-300 words as a matter of style (not truncation) and his terse,
 * dry critical vocabulary ("still leaves a nasty taste in the mouth")
 * frequently failed the hasOpinionLanguage() keyword match, so real,
 * complete, correctly-recovered review text fell through to
 * contentTier=truncated / incompleteReason=paywall. Observed on a routine
 * rebuild pass: 8 of 69 wsj-subscriber-browser-session-recovered reviews
 * regressed this way (2026-08-02 live audit; blackbird-2016,
 * falsettos-2016, fish-in-the-dark-2015, fully-committed-2016, junk-2017,
 * she-loves-me-2016, the-gin-game-2015, the-humans-2016).
 *
 * Fix: (1) broadened hasOpinionLanguage()'s vocabulary for terse capsule
 * style (excellent/impressive/ideal/sublime/witty/well-made/etc), and
 * (2) for fetchMethod values ending in -subscriber-browser-session (an
 * authenticated session pulled the real article DOM, not a scraped
 * snippet), Path 3 no longer requires the opinion-language keyword match
 * at all — the trusted capture method is a stronger completeness signal
 * than a keyword heuristic for these terse historical styles. The bypass
 * is narrowly scoped: it does not relax wordCount, hasProperEnding, or
 * the zero-truncation-signal requirements, so genuinely truncated
 * subscriber-session captures (bad ending, real truncation signals) must
 * still classify as truncated.
 *
 * Per CLAUDE.md §15: require() the real function; never duplicate logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyContentTier, hasOpinionLanguage } =
  require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));

const REVIEW_TEXTS_BASE = '/Users/tompryor/broadway-review-texts';

function loadReview(showId, filename) {
  try {
    return JSON.parse(readFileSync(`${REVIEW_TEXTS_BASE}/${showId}/${filename}`, 'utf8'));
  } catch {
    return null;
  }
}

// ── Real-file tests (most reliable; skip gracefully where the private
// review-texts checkout isn't present, e.g. CI) ─────────────────────────────

const REGRESSED_TEACHOUT_FILES = [
  ['blackbird-2016', 'wsj--terry-teachout.json'],
  ['falsettos-2016', 'wsj--terry-teachout.json'],
  ['fish-in-the-dark-2015', 'wsj--terry-teachout.json'],
  ['fully-committed-2016', 'wsj--terry-teachout.json'],
  ['junk-2017', 'wsj--terry-teachout.json'],
  ['she-loves-me-2016', 'wsj--terry-teachout.json'],
  ['the-gin-game-2015', 'wsj--terry-teachout.json'],
  ['the-humans-2016', 'wsj--terry-teachout.json'],
];

for (const [showId, filename] of REGRESSED_TEACHOUT_FILES) {
  test(`${showId} WSJ Teachout capsule review → classifyContentTier returns complete`, () => {
    const d = loadReview(showId, filename);
    if (!d) return; // private repo not present in this environment
    const result = classifyContentTier(d);
    assert.equal(result.contentTier, 'complete',
      `Expected complete for real recovered Teachout capsule review, got ${result.contentTier} (reason: ${result.tierReason})`);
  });
}

// ── Structural tests (no dependency on private repo) ────────────────────────

// Neutral ~180-word review body that deliberately avoids every keyword in
// hasOpinionLanguage()'s list, to isolate the isTrustedSubscriberCapture bypass.
const NEUTRAL_SENTENCES = [
  'The revival runs at a midtown theater through the end of the season.',
  'Two veteran film actors return to the stage after a long absence.',
  'The director stages the central confrontation in a single unbroken scene.',
  'A cramped office set keeps both actors under fluorescent light for the full running time.',
  'The text raises questions about guilt and memory that it declines to resolve.',
  'The supporting cast appears only in a handful of brief scenes near the end.',
  'The running time is ninety minutes with no intermission.',
  'Ticket prices range from thirty nine dollars to one hundred forty five dollars.',
  'The production closes in June after a run of several months.',
  'Audiences can be heard debating the ending in the lobby afterward.',
];
function buildNeutralText(minWords) {
  let out = [];
  let words = 0;
  let i = 0;
  while (words < minWords) {
    const s = NEUTRAL_SENTENCES[i % NEUTRAL_SENTENCES.length];
    out.push(s);
    words += s.split(/\s+/).length;
    i++;
  }
  return out.join(' ');
}
const NEUTRAL_TEXT = buildNeutralText(160);

test('sanity: NEUTRAL_TEXT hits no hasOpinionLanguage() keywords', () => {
  assert.equal(hasOpinionLanguage(NEUTRAL_TEXT), false,
    'Test fixture must contain zero opinion-language keywords to isolate the bypass');
});

test('subscriber-session capture, no opinion keywords, clean ending → complete (bypass applies)', () => {
  const result = classifyContentTier({
    outlet: 'The Wall Street Journal',
    outletId: 'wsj',
    fullText: NEUTRAL_TEXT,
    fetchMethod: 'wsj-subscriber-browser-session',
    url: 'https://www.wsj.com/articles/test-review',
  });
  assert.equal(result.contentTier, 'complete',
    `Expected complete via isTrustedSubscriberCapture bypass, got ${result.contentTier} (reason: ${result.tierReason})`);
});

test('same neutral text WITHOUT a trusted fetchMethod → NOT complete (bypass is narrowly scoped)', () => {
  const result = classifyContentTier({
    outlet: 'The Wall Street Journal',
    outletId: 'wsj',
    fullText: NEUTRAL_TEXT,
    // no fetchMethod — e.g. an ordinary scrape, not an authenticated session capture
    url: 'https://www.wsj.com/articles/test-review',
  });
  assert.notEqual(result.contentTier, 'complete',
    `Expected non-complete without a trusted subscriber-session fetchMethod, got ${result.contentTier}`);
});

test('subscriber-session capture that is genuinely truncated (bad ending) stays truncated', () => {
  // Same neutral prose but cut off mid-sentence — no proper ending, so the
  // bypass must not rescue it regardless of fetchMethod.
  const truncatedText = NEUTRAL_TEXT.slice(0, -20) + ' and the actors continue to';
  const result = classifyContentTier({
    outlet: 'The Wall Street Journal',
    outletId: 'wsj',
    fullText: truncatedText,
    fetchMethod: 'wsj-subscriber-browser-session',
    url: 'https://www.wsj.com/articles/test-review',
  });
  assert.notEqual(result.contentTier, 'complete',
    `Expected non-complete for a genuinely truncated subscriber-session capture, got ${result.contentTier}`);
});

test('newyorker-subscriber-browser-session also gets the trusted-capture bypass', () => {
  const result = classifyContentTier({
    outlet: 'The New Yorker',
    outletId: 'newyorker',
    fullText: NEUTRAL_TEXT,
    fetchMethod: 'newyorker-subscriber-browser-session',
    url: 'https://www.newyorker.com/magazine/test-review',
  });
  assert.equal(result.contentTier, 'complete',
    `Expected complete via isTrustedSubscriberCapture bypass for newyorker, got ${result.contentTier} (reason: ${result.tierReason})`);
});
