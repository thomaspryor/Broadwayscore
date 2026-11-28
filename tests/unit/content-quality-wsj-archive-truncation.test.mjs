/**
 * Regression test for BRO-3572: WSJ archive-reprint captures truncated at the
 * dowjones.com syndication interstitial were classified contentTier='complete'
 * and scored — the review's real lede sentence ends mid-thought with an
 * ellipsis, immediately followed by the page's "Most Popular Videos"/"Most
 * Popular Articles" navigation rail instead of the rest of the review.
 *
 * Two failure shapes were both live in production (task discovery):
 * - Short remnant (e.g. the-nap-2018): stripping the nav rail alone would
 *   leave a short-enough remainder to already classify as 'truncated'.
 * - Long remnant (e.g. mean-girls-2018): the surviving truncated lede is long
 *   enough (250-400+ words) to pass classifyContentTier's existing tolerance
 *   for a single `ends_with_ellipsis` moderate signal (moderateCount<=1), so
 *   stripping the nav rail alone is NOT sufficient — it stays misclassified
 *   'complete'. The fix must detect the RAW ellipsis-into-nav-rail adjacency
 *   itself (isGarbageContent -> contentTier='invalid'), not just react to a
 *   shortened post-strip word count.
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
const { classifyContentTier, isGarbageContent, detectStrongWsjArchiveTruncationAnywhere, STRONG_WSJ_ARCHIVE_TRUNCATION_PATTERNS } =
  require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));

const BROWSER_UPDATE_HEADER =
  'BROWSER UPDATE To gain access to the full experience, please upgrade your browser:\n\n' +
  'Note: If you are running Internet Explorer 10 and above, make sure it is not in compatibility mode\n\n';

const NAV_RAIL =
  '\n\nMost Popular Videos\nKey Moments From the Hearing\nSenate Hearing: Opening Statement\n\n' +
  'Most Popular Articles\nSEC Sues Musk for Fraud\nOpinion: Confirm the Nominee\n\n' +
  'Text Size Small Medium Large\nEmail Print Facebook Twitter WhatsApp SMS Copy Link';

test('short WSJ archive-truncation remnant is invalid, not complete', () => {
  // Mirrors the real the-nap-2018 shape: one paragraph, cut off with an
  // ellipsis, immediately into the nav rail.
  const text = BROWSER_UPDATE_HEADER +
    'New York Why on earth did anyone think it a good idea to mount a Broadway production ' +
    'of a British farce about a transgender gangster who attempts to fix a snooker tournament? ' +
    'Having squirmed without cease through...' + NAV_RAIL;
  const result = classifyContentTier({ fullText: text });
  assert.equal(result.contentTier, 'invalid', `expected invalid, got ${result.contentTier}: ${result.tierReason}`);
});

test('long WSJ archive-truncation remnant (250+ words) is invalid, not complete', () => {
  // Mirrors the real mean-girls-2018 shape: a long enough lede that a
  // strip-only fix would leave it passing the moderateCount<=1 tolerance.
  const longLede = 'Every generation has its own coming-of-age story that defines a decade of theatergoers. '.repeat(20);
  const text = BROWSER_UPDATE_HEADER + 'New York ' + longLede.trim() + '...' + NAV_RAIL;
  const result = classifyContentTier({ fullText: text });
  assert.equal(result.contentTier, 'invalid', `expected invalid, got ${result.contentTier}: ${result.tierReason}`);
});

test('FP guard: a genuinely complete WSJ review sharing the BROWSER UPDATE interstitial stays complete', () => {
  // Mirrors the real hamilton-2015/noises-off-2016 shape: full multi-paragraph
  // review with a proper closing sentence, byline signature, and an unrelated
  // trailing headline-list footer (tolerated elsewhere as footer junk) — no
  // "Most Popular" adjacency at all.
  const body = 'Classic farce is hard to write and harder to stage, and this revival gets the timing exactly right. '.repeat(15) +
    'This show is flawless, and it will make you laugh from curtain to curtain.';
  const footer = '\n\n—Mr. Teachout is the Journal’s drama critic. Write to him at tteachout@wsj.com.\n\n' +
    'Bavaria Protests Merkel’s Refugee Policy\n\nChina Fears Rattle Hong Kong Dollar\n\nPoll: Trump Widens His Lead';
  const text = BROWSER_UPDATE_HEADER + body + footer;
  const result = classifyContentTier({ fullText: text });
  assert.equal(result.contentTier, 'complete', `expected complete, got ${result.contentTier}: ${result.tierReason}`);
});

test('FP guard: a non-WSJ "Most Popular Articles" sidebar with no ellipsis adjacency is not flagged by the strong scan', () => {
  // Mirrors the real call-me-izzy-2025/exeunt-magazine shape: genuine trailing
  // sidebar junk, but no ellipsis immediately before it — must not match.
  const text = 'A wholly satisfying evening at the theater from a strong cast under sharp direction. '.repeat(10) +
    'Running Time 1hr 30min Most Popular Articles in the past seven days Review: Another Show Elsewhere';
  const r = detectStrongWsjArchiveTruncationAnywhere(text);
  assert.equal(r.detected, false, `expected no match, got: ${r.match}`);
});

test('detectStrongWsjArchiveTruncationAnywhere matches both ASCII and unicode ellipsis forms', () => {
  assert.equal(detectStrongWsjArchiveTruncationAnywhere('cut off mid-thought...\n\nMost Popular Videos').detected, true);
  assert.equal(detectStrongWsjArchiveTruncationAnywhere('cut off mid-thought…\n\nMost Popular Articles').detected, true);
  assert.equal(detectStrongWsjArchiveTruncationAnywhere('The musical was a delight from curtain to curtain.').detected, false);
});

test('isGarbageContent flags the WSJ archive-truncation signature directly', () => {
  const text = BROWSER_UPDATE_HEADER + 'A short truncated lede...' + NAV_RAIL;
  const r = isGarbageContent(text);
  assert.equal(r.isGarbage, true, `expected garbage, got: ${r.reason}`);
});

test('STRONG_WSJ_ARCHIVE_TRUNCATION_PATTERNS is a non-empty exported RegExp array', () => {
  assert.ok(Array.isArray(STRONG_WSJ_ARCHIVE_TRUNCATION_PATTERNS) && STRONG_WSJ_ARCHIVE_TRUNCATION_PATTERNS.length > 0);
  assert.ok(STRONG_WSJ_ARCHIVE_TRUNCATION_PATTERNS.every(p => p instanceof RegExp));
});
