'use strict';
/**
 * loureviews-match.js — pure matching helpers for the LouReviews blog poller.
 *
 * loureviews.blog is a SINGLE-CRITIC WordPress blog (Louise Penn). Each review
 * post is one review by her, titled like:
 *   "Play review: The P Word at Bush Theatre"
 *   "Musical review: Avenue Q at Shaftesbury Theatre"
 *   "Opera review: Così fan tutte by English National Opera"
 * Non-reviews we must reject: film/home-media/book reviews, previews, interviews
 * ("Female theatre reviewers project: …"), and multi-show fringe roundups
 * ("Brighton Fringe reviews: A, and B").
 *
 * Extracted as a pure module (no I/O) so the poller's decision logic is unit
 * tested against real post-title fixtures (CLAUDE.md §15). The poller
 * (scripts/poll-loureviews.js) requires these; tests require them too.
 */

// Theatre review prefixes we accept. Deliberately excludes Film / Home media /
// Book / TV / Radio / Album / Digital (recorded) — those aren't live stage
// productions in our DB.
const ACCEPT_PREFIX = /^(play|musical|musical theatre|theatre|opera|dance|cabaret|concert|drama|gig theatre|circus)\s+review:\s*(.+)$/i;
const REJECT_PREFIX = /^(film|home media|book|tv|radio|album|digital play|digital|dvd|streaming|audio)\s+review/i;

// Words that carry no disambiguating signal in a title.
const GENERIC_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'at', 'on', 'for', 'by']);

// Meaningful words a candidate title may carry WITHOUT the post mentioning them
// (format suffixes / subtitles). A candidate word outside this set that the post
// doesn't match is a distinguishing word — e.g. "Future" in "Back to the Future"
// vs the post "I'll Be Back" — and blocks the match.
const ALLOWED_EXTRA = new Set(['musical', 'play', 'part', 'parts', 'live', 'concert', 'show']);

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#8217;|&#039;|&rsquo;|&#8216;/g, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/&#8230;|&hellip;/g, '...')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Normalise a title for word-overlap matching: lowercase, entity-decode,
 * apostrophes/punctuation → spaces, collapse whitespace.
 */
function normalizeTitle(s) {
  return decodeEntities(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a LouReviews post title into { showTitle } if it is a single-show stage
 * review, else null. Strips the "X review:" prefix and the trailing venue /
 * company qualifier (" at …", " by …", " – …", "(…)").
 */
function parseReviewPost(rawTitle) {
  const title = decodeEntities(rawTitle);
  if (!title) return null;
  if (REJECT_PREFIX.test(title)) return null;
  const m = title.match(ACCEPT_PREFIX);
  if (!m) return null;
  let show = m[2].trim();
  // Multi-show roundup inside a single post ("A, B and C") — reject; we can't
  // attribute one review to one show reliably.
  if (/\breviews:\s/i.test(title)) return null;
  // Strip trailing venue/company/qualifier. The bracket strip is anchored to a
  // TRAILING group only — stripping from the first "(" anywhere would corrupt
  // titles like "(This Is Not A) Happy Room" into an empty string (silent drop).
  show = show
    .replace(/\s+(?:at|by|@)\s+.*$/i, '')
    .replace(/\s*[([][^)\]]*[)\]]\s*$/, '')
    .replace(/\s+[-–—:]\s+.*$/, '')
    .trim();
  if (!show || show.length < 2) return null;
  return { showTitle: show };
}

function meaningfulWords(title) {
  return [...new Set(normalizeTitle(title).split(' ').filter((w) => w.length > 2 && !GENERIC_WORDS.has(w)))];
}

function hasWholeWord(haystackNorm, word) {
  return new RegExp(`(?:^| )${word}(?: |$)`).test(haystackNorm);
}

/**
 * Score how well a parsed show title matches a candidate shows.json title.
 * Returns { matched, confidence }. Mirrors the conservative thresholds used by
 * the WET/TR aggregator matchers: multi-word needs ≥60% of meaningful words
 * (min 2) as whole words; 1–2 word titles need all words present.
 */
function titleMatch(showTitle, candidateTitle) {
  const words = meaningfulWords(showTitle);
  const candNorm = normalizeTitle(candidateTitle);
  if (words.length === 0) {
    const whole = normalizeTitle(showTitle);
    return { matched: !!whole && hasWholeWord(candNorm, whole), confidence: 0.4 };
  }
  const matched = words.filter((w) => hasWholeWord(candNorm, w));
  const threshold = words.length <= 2 ? words.length : Math.max(2, Math.ceil(words.length * 0.6));
  // Symmetry guard: every meaningful word the candidate carries that the post did
  // NOT match must be a format/subtitle word (ALLOWED_EXTRA). Otherwise the
  // candidate names a distinct production ("Back to the Future" vs "I'll Be
  // Back"; "Company of Angels" vs "Company"). Matched post-words are whole-word
  // hits, so the candidate's unmatched meaningful words are the residual.
  const matchedSet = new Set(matched);
  const candExtras = meaningfulWords(candidateTitle).filter((w) => !matchedSet.has(w) && !hasWholeWord(normalizeTitle(showTitle), w));
  const extrasOk = candExtras.every((w) => ALLOWED_EXTRA.has(w));
  const ok = matched.length >= threshold && extrasOk;
  return { matched: ok, confidence: ok ? matched.length / words.length : 0 };
}

/**
 * Match a parsed post to the best show in `shows`. Restricted to UK markets
 * (west-end / off-west-end) because LouReviews only covers UK stage productions
 * — this alone eliminates the historical same-title Broadway false positives
 * (Company 1993, Saint Joan 1977, etc.) that a global match would surface.
 *
 * @param {string} showTitle  parsed show title from parseReviewPost
 * @param {Array<{id,title,category}>} shows
 * @returns {{ showId, confidence } | null}
 */
function matchPostToShow(showTitle, shows, opts = {}) {
  const markets = opts.markets || ['west-end', 'off-west-end'];
  let best = null;
  for (const s of shows) {
    if (!markets.includes(s.category)) continue;
    const r = titleMatch(showTitle, s.title || '');
    if (r.matched && (!best || r.confidence > best.confidence)) {
      best = { showId: s.id, confidence: r.confidence, _title: s.title };
    }
  }
  if (!best) return null;
  return { showId: best.showId, confidence: best.confidence };
}

module.exports = { parseReviewPost, matchPostToShow, titleMatch, normalizeTitle, decodeEntities };
