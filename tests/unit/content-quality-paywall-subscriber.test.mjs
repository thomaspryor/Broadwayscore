/**
 * Regression test for content-quality.js paywall detector.
 *
 * Bug: bare word "Subscriber" in WSJ nav chrome ("Subscriber Sign-In") was
 * triggering PAYWALL_PATTERNS[5] — /subscriber(s)?(\s+only)?(\s+content)?/i —
 * because both qualifier groups were optional. Every WSJ opening-night review
 * fetched by Browserbase YTD was rejected as "Paywall/subscription prompt:
 * 'Subscriber'" despite containing ~5900 chars of real review content.
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
const { isGarbageContent, detectPaywall } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));

// Representative WSJ review body that contains "Subscriber" as part of nav
// chrome ("Subscriber Sign-In"), then ~5900 chars of real review with >=3
// theater keywords. Based on actual Browserbase output 2026-04-21.
const WSJ_REAL_REVIEW_WITH_NAV_SUBSCRIBER = [
  'WSJ News Exclusive Subscriber Sign-In Search',
  '',
  'Fallen Angels Review: Rose Byrne and Kelli O’Hara in a Bubbly Broadway Revival',
  'By Charles Isherwood',
  '',
  'The 1925 Noël Coward comedy gets a frothy Broadway production at the Booth Theatre',
  'directed by Scott Ellis, with two bored society wives awaiting the return of the',
  'Frenchman they both loved before marriage. The performances are superb — Rose Byrne',
  'as Julia delivers the play’s sharp one-liners with perfect timing, and Kelli O’Hara',
  'as Jane matches her every step of the way. The second-act duet, in which the two',
  'characters drink themselves into near-oblivion while awaiting their shared former',
  'lover, is a showcase of comic technique, with both actresses leaning into the',
  'physicality of the bit without letting it descend into slapstick. David Zinn’s set',
  'depicts the fashionable London flat with period-appropriate Art Deco flourishes,',
  'and Linda Cho’s costumes are a parade of 1920s drop-waists and silk pajamas.',
  '',
  // Pad to >500 chars with additional theater-relevant text so hasSubstantialReviewContent is true.
  'The direction keeps the farce moving briskly through its three acts. The performance',
  'is a reminder of why Coward’s comedies of manners continue to fill Broadway theatres.',
  'The cast, the score, the production design all combine into one of the most',
  'entertaining revivals of the current Broadway season. The musical interludes,',
  'performed live by a small onstage ensemble, bridge scene changes elegantly.',
].join('\n');

test('content-quality: bare "Subscriber" in WSJ nav does NOT flag as paywall', () => {
  const result = isGarbageContent(WSJ_REAL_REVIEW_WITH_NAV_SUBSCRIBER);
  assert.equal(
    result.isGarbage,
    false,
    `Expected WSJ review with "Subscriber Sign-In" nav to pass, but was rejected: ${result.reason}`
  );
});

test('content-quality: "Subscribers only" still detected as paywall', () => {
  const text = 'Subscribers only. Please sign in to continue reading this article.';
  const p = detectPaywall(text);
  assert.equal(p.detected, true, 'Subscribers only should still be detected');
});

test('content-quality: "Subscriber only content" still detected as paywall', () => {
  const text = 'This is subscriber only content. Sign in to access.';
  const p = detectPaywall(text);
  assert.equal(p.detected, true, 'subscriber only content should still be detected');
});

test('content-quality: "Subscribe to continue reading" still detected as paywall', () => {
  const text = 'Subscribe to continue reading this article';
  const p = detectPaywall(text);
  assert.equal(p.detected, true, 'Subscribe to continue reading should still be detected');
});

test('content-quality: "Already a subscriber? Sign in" still detected', () => {
  const text = 'Already a subscriber? Sign in';
  const p = detectPaywall(text);
  assert.equal(p.detected, true, 'Already a subscriber should still be detected');
});

test('content-quality: bare "Subscriber" word is NOT treated as paywall', () => {
  // Bare "Subscriber" is ambiguous — could be nav chrome, byline, or label.
  // Real paywall strings always include a qualifier (only/content/exclusive/access).
  const text = 'Subscriber Customer Service';
  const p = detectPaywall(text);
  assert.equal(p.detected, false, 'Bare "Subscriber" alone should NOT be treated as paywall');
});

test('content-quality: NYT JS-loader chrome ("trouble retrieving the article content") is paywall', () => {
  // NYT serves bot-detected requests a partial article followed by a JS-loader stub:
  // "We are having trouble retrieving the article content. Please enable JavaScript in
  // your browser settings. Thank you for your patience while we verify access."
  // Affected 44+ archived NYT reviews where the scraper got real review prose then
  // hit this stub at the bottom.
  const text = 'We are having trouble retrieving the article content. Please enable JavaScript.';
  const p = detectPaywall(text);
  assert.equal(p.detected, true, 'NYT JS-loader chrome must be detected as paywall');
});

test('content-quality: NYT chrome appended to real review prose flags isGarbage when chrome is most of text', () => {
  // Short bait of review prose + the JS-loader chrome — chrome dominates → isGarbage true
  const text = 'A solid revival.\n\nWe are having trouble retrieving the article content. Please enable JavaScript in your browser settings. Thank you for your patience while we verify access.';
  const result = isGarbageContent(text);
  assert.equal(result.isGarbage, true,
    `expected garbage when JS-loader chrome dominates a short bait, got: ${result.reason}`);
});
