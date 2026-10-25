'use strict';

/**
 * syndicated-reprint-match.js — is a syndication-portal URL a reprint of a
 * review we already hold? (BRO-5489)
 *
 * The review-gap audit counted aol.co.uk / yahoo.com reprints as missing
 * reviews. Antigone Exits (2026-10): the census listed
 * aol.co.uk/articles/antigone-exits-review-emotions-run-104342000.html, a
 * reprint of the Guardian review we held the whole time. The portal is never
 * the outlet, ingest of the portal page failed, and the opening-window alert
 * re-fired every hour on a review that was already collected.
 *
 * Portal slugs are the reprinted headline with stopwords dropped and a numeric
 * id appended, and stored review text opens with that headline. So: slug words
 * in order, inside a short span, near the start of a held file's text. No
 * fetch, no spend.
 *
 * Conservative on purpose. A slug made only of show-title / venue / generic
 * words ("review-king-lear-royal-exchange") identifies the production, not the
 * review, and would match any held review of the show, so it never matches and
 * stays a gap. At least MIN_DISTINCTIVE headline-specific words must match.
 *
 * Same contract as outlet-canonicalize's sameOutletUrlVariant: returns
 * { dup, matchedUrl, reason } and the caller records the dedupe.
 */

const { isSyndicationHost } = require('./syndication-canonical');

const MIN_SLUG_TOKENS = 4;
const MIN_DISTINCTIVE = 2;
// Stored text starts with the headline, sometimes after a kicker ("Review").
const HEAD_CHARS = 400;
// Portal slugs drop stopwords, so matched words may sit a little apart.
const MAX_SPAN_FACTOR = 2;

const GENERIC = new Set([
  'review', 'reviews', 'reviewed', 'theatre', 'theater', 'broadway', 'musical',
  'play', 'show', 'stage', 'production', 'west', 'end', 'off', 'new', 'york',
  'london', 'the', 'a', 'an', 'and', 'of', 'at', 'in', 'on', 'to', 'for', 'is',
  'with', 'by', 'its', 'it', 'as', 'from', 'html', 'htm', 'articles', 'article',
]);

function words(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function slugTokens(url) {
  let seg = '';
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    seg = parts[parts.length - 1] || '';
  } catch { return []; }
  return words(seg.replace(/\.html?$/i, '')).filter((t) => !/^\d+$/.test(t));
}

// Ordered subsequence of `needle` in `hay` whose span is at most maxSpan words.
function orderedWithinSpan(hay, needle, maxSpan) {
  for (let start = 0; start < hay.length; start++) {
    if (hay[start] !== needle[0]) continue;
    let j = 1;
    let i = start + 1;
    for (; i < hay.length && j < needle.length && i - start < maxSpan; i++) {
      if (hay[i] === needle[j]) j++;
    }
    if (j === needle.length) return true;
  }
  return false;
}

/**
 * @param {object} p
 * @param {string} p.candidateUrl the listed URL
 * @param {Array<{url?: string, fullText?: string}>} p.heldFiles covered review files for the show
 * @param {string} [p.showTitle]
 * @param {string} [p.venue]
 * @returns {{dup: boolean, matchedUrl?: string, reason?: string}}
 */
const MIN_HELD_FOR_RARITY = 3;

function syndicatedReprintOf({ candidateUrl, heldFiles, showTitle, venue }) {
  if (!candidateUrl || !isSyndicationHost(candidateUrl)) return { dup: false };
  const slug = slugTokens(candidateUrl);
  if (slug.length < MIN_SLUG_TOKENS) return { dup: false };
  const held = (heldFiles || [])
    .filter((f) => f && f.url && f.fullText && !isSyndicationHost(f.url))
    .map((f) => ({ url: f.url, head: words(String(f.fullText).slice(0, HEAD_CHARS)) }));
  if (held.length === 0) return { dup: false };
  // Distinctive = not a title/venue/generic word AND rare across the show's
  // held headlines. The rarity test covers a venue we were not told about:
  // "royal exchange" opens most King Lear reviews, "emotions run" opens one.
  const known = new Set([...words(showTitle), ...words(venue), ...GENERIC]);
  const df = (t) => held.filter((h) => h.head.includes(t)).length;
  // Rarity is meaningless with few held reviews (every word is "rare" in a
  // one-file corpus), so a small show never dedupes: it keeps alerting.
  if (held.length < MIN_HELD_FOR_RARITY) return { dup: false };
  const rareMax = Math.floor(held.length / 3);
  const distinctive = slug.filter((t) => !known.has(t) && df(t) <= rareMax);
  if (distinctive.length < MIN_DISTINCTIVE) {
    // BRO-5633: AOL moves the editorial "Review" label within the headline
    // (De Profundis). When only one rare word survives, require a contiguous
    // phrase of at least four words in exactly one held headline. Never drop
    // a portal URL solely because of its host or production title.
    const phrase = slug.filter(t => t !== 'review' && t !== 'reviews');
    if (distinctive.length !== 1 || phrase.length < MIN_SLUG_TOKENS) return { dup: false };
    const matches = held.filter(h => orderedWithinSpan(
      h.head.filter(t => t !== 'review' && t !== 'reviews'), phrase, phrase.length,
    ));
    return matches.length === 1
      ? { dup: true, matchedUrl: matches[0].url, reason: 'syndicated-reprint' }
      : { dup: false };
  }
  const maxSpan = slug.length * MAX_SPAN_FACTOR;
  for (const h of held) {
    if (orderedWithinSpan(h.head, slug, maxSpan)) {
      return { dup: true, matchedUrl: h.url, reason: 'syndicated-reprint' };
    }
  }
  return { dup: false };
}

module.exports = { syndicatedReprintOf, slugTokens };
