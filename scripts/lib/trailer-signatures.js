/**
 * trailer-signatures.js — the known page trailers that follow a review's last
 * paragraph and are not review prose, shared by two readers that must agree:
 *
 *   - content-quality.js stripVenueListingsTrailer(): the ending-punctuation
 *     check. It reads the text, never changes the stored copy, and rebuild
 *     re-tiers every file on each run, so adding a signature here upgrades
 *     false "truncated" files at the next rebuild with no rewrite.
 *   - text-cleaning.js stripTrailingJunk(): removes the same trailer from text
 *     being collected, so new files are stored without it.
 *
 * Why this exists: 1,768 files were tiered "truncated" only for
 * `Missing proper ending or other signals` (zero-gap plan, section 0). The
 * Guardian alone has 245, every one ending `• At the Almeida, London, until 7
 * June`. The review is whole; the listing line has no full stop.
 *
 * Every function is pure and conservative: a trailer goes only when the text
 * before it ends a sentence, the trailer is short, and (for the outlet-scoped
 * ones) the outlet is named. A review cut off mid-sentence right before a
 * trailer keeps its truncated verdict.
 */

'use strict';

const SENTENCE_END_RE = /[.!?]["'”’)]?$/;
const BULLET_RE = /[•·]/;

// ---------------------------------------------------------------------------
// UK listing bullets (Guardian, Observer): "... end of review. • At the
// Almeida, London, until 7 June", "• Until 12 October", "• 1984 continues at
// Her Majesty's Theatre until 27 May, before touring to ...", "• This article
// was amended on 22 December 2022 to ...". The trailer is one or more bullets.
// ---------------------------------------------------------------------------
const UK_TRAILER_MAX = 700;
const UK_SEGMENT_MAX = 260;
const UK_LISTING_CUE_RE = /^(?:At|Until|Touring|On tour)\b|\b(?:until|touring|continues|is at|is on|are at|are on|runs at|runs until|runs to|to \d{1,2} [A-Z][a-z]+|from \d{1,2} [A-Z][a-z]+)\b/;
const UK_AMENDED_NOTE_RE = /^This (?:article|review|piece) was (?:amended|corrected|updated)\b/;

function isUkTrailerSegment(seg) {
  if (!seg || seg.length > UK_SEGMENT_MAX) return false;
  if (UK_AMENDED_NOTE_RE.test(seg)) return true; // a correction note is prose, but never review prose
  // A listing has no sentence in it; one full stop at the very end is fine.
  // "At Crucible, Sheffield, until 7 February. Then touring" is one listing.
  const body = seg.replace(/\.$/, '').replace(/\.\s+(?=Then\b)/g, ', ');
  if (/[.!?]/.test(body.replace(/\b(?:St|Mr|Mrs|Dr)\./g, ''))) return false;
  return UK_LISTING_CUE_RE.test(body);
}

// The same listing with the bullet lost in extraction: "... the end. At Theatre
// Royal Haymarket, London, until 3 August" or "Antigone Exits runs at the Minerva
// theatre, Chichester, until 17 October". Stricter than the bulleted form because
// nothing marks where the trailer starts: it must be the whole last sentence,
// open with "At"/"Until"/"<Title> runs|continues|is|are", and name a date.
const UK_BARE_LISTING_START_RE = /^(?:(?:At|Until)\s|[A-Z][\w'’:&-]*(?:\s[\w'’:&-]+){0,8}\s(?:runs|continues|is|are|plays)\s(?:at|until|on|to)\s)/;
const UK_DATE_RE = /\b(?:until|to|from)\s+\d{1,2}\s+[A-Z][a-z]{2,8}\b|\buntil\s+(?:[A-Z][a-z]+day|[A-Z][a-z]{2,8}\s+\d{1,2})\b/;

function stripBareUkListing(t) {
  const base = Math.max(0, t.length - 300);
  const tail = t.slice(base);
  // Try each sentence boundary in the tail, earliest first: the listing may be
  // two sentences ("... until 7 February. Then touring").
  const boundary = /([.!?]["'”’)]?)\s+/g;
  let m;
  while ((m = boundary.exec(tail)) !== null) {
    const frag = tail.slice(m.index + m[0].length).trim();
    if (frag.length < 8 || frag.length > UK_SEGMENT_MAX) continue;
    if (/[•·]/.test(frag)) continue;
    if (!UK_BARE_LISTING_START_RE.test(frag) || !UK_DATE_RE.test(frag) || !isUkTrailerSegment(frag)) continue;
    return t.slice(0, base + m.index + m[1].length);
  }
  return t;
}

function stripUkListingBullets(text) {
  if (!text || typeof text !== 'string') return text;
  const t = text.replace(/\s+$/, '');
  const bare = stripBareUkListing(t);
  if (bare !== t) return bare;
  const from = Math.max(0, t.length - UK_TRAILER_MAX);
  let at = from;
  while (true) {
    const m = BULLET_RE.exec(t.slice(at));
    if (!m) return text;
    const idx = at + m.index;
    at = idx + 1;
    const before = t.slice(0, idx).replace(/\s+$/, '');
    // Whitespace must separate the sentence end from the bullet.
    if (before.length === idx || !SENTENCE_END_RE.test(before)) continue;
    const segs = t.slice(idx).split(BULLET_RE).map((s) => s.trim()).filter(Boolean);
    if (segs.length && segs.every(isUkTrailerSegment)) return before;
  }
}

// ---------------------------------------------------------------------------
// thefourthwalsh: the review is followed by a production-info block that ends
// in the site footer. All 112 corpus files with the footer carry the block
// starting at "Running Time:" (longest 801 chars):
//   Running Time: ... At <venue> ... Performances are: ... For more information
//   or tickets Production photos by X For more Chicago theatre information and
//   reviews, please visit Theatre in Chicago Facebook --> Share on:
// ---------------------------------------------------------------------------
const FOURTHWALSH_BLOCK_RE = /\s*Running Time:[\s\S]{0,1100}?For more Chicago theatre information and reviews, please visit Theatre in Chicago(?:\s*Facebook\s*-->)?(?:\s*Share on:)?\s*$/;
// The footer alone: the sentence is unique to this site, so it is safe for any outlet.
const FOURTHWALSH_FOOTER_RE = /\s*For more Chicago theatre information and reviews, please visit Theatre in Chicago(?:\s*Facebook\s*-->)?(?:\s*Share on:)?\s*$/;

function stripFourthWalshInfoBlock(text) {
  if (!text || typeof text !== 'string') return text;
  const m = FOURTHWALSH_BLOCK_RE.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index).replace(/\s+$/, '');
  // Only when a whole review sits in front of the block.
  return SENTENCE_END_RE.test(before) && before.length >= 400 ? before : text;
}

// ---------------------------------------------------------------------------
// one-minute-critic: after the verdict line the page lists related-post
// headlines, one paragraph each ("Books - In 'X,' falling apart is just the
// beginning"). They carry no final full stop. Needs 2+ trailing headline
// paragraphs after a paragraph that ends a sentence, so a review that merely
// ends on one short paragraph is not touched.
// ---------------------------------------------------------------------------
const HEADLINE_MAX = 240;
const RELATED_MIN_REMAINING = 600;

function stripRelatedPostHeadlines(text) {
  if (!text || typeof text !== 'string') return text;
  const trimmed = text.replace(/\s+$/, '');
  const paras = trimmed.split(/\n\s*\n/);
  let k = paras.length;
  while (k > 1) {
    const p = paras[k - 1].trim();
    if (!p || p.length > HEADLINE_MAX || SENTENCE_END_RE.test(p)) break;
    k--;
  }
  const headlines = paras.length - k;
  if (headlines < 2 || k < 1) return text;
  const body = paras.slice(0, k).join('\n\n').replace(/\s+$/, '');
  if (!SENTENCE_END_RE.test(body) || body.length < RELATED_MIN_REMAINING) return text;
  return body;
}

// ---------------------------------------------------------------------------
// Guardian/Observer API-era footer: "... Explore more on these topics Theatre
// Musicals reviews Share Reuse this content". The sentence is unique to the
// Guardian CMS, so it is safe for any outlet; 274 corpus files carry it.
// ---------------------------------------------------------------------------
const GUARDIAN_TOPICS_FOOTER_RE = /\s*Explore more on these topics[\s\S]{0,260}?Share\s+Reuse this content\s*$/;

function stripGuardianTopicsFooter(text) {
  if (!text || typeof text !== 'string') return text;
  const m = GUARDIAN_TOPICS_FOOTER_RE.exec(text);
  return m ? text.slice(0, m.index) : text;
}

// Outlet-scoped strippers (outletId is the registry id on the review file).
const OUTLET_TRAILER_STRIPPERS = Object.freeze({
  'one-minute-critic': stripRelatedPostHeadlines,
  thefourthwalsh: stripFourthWalshInfoBlock,
});

/** Strip the trailer known for this outlet; unknown outlet returns text unchanged. */
function stripOutletTrailer(text, outletId) {
  const fn = outletId && OUTLET_TRAILER_STRIPPERS[outletId];
  return fn ? fn(text) : text;
}

/**
 * Kill switch and dry-run seam: TRAILER_FIXES_DISABLED=true restores the
 * pre-fix classifier (no trailer stripping, ASCII-only ending class). The
 * false-truncation dry-run runs the classifier both ways to attribute every
 * tier change to this fix.
 */
function trailerFixesEnabled() {
  return process.env.TRAILER_FIXES_DISABLED !== 'true';
}

/** Every known trailer, for the ending-punctuation check. */
function stripKnownTrailers(text, outletId) {
  if (!trailerFixesEnabled()) return text;
  return stripOutletTrailer(stripUkListingBullets(stripGuardianTopicsFooter(text)), outletId);
}

module.exports = {
  stripUkListingBullets,
  stripFourthWalshInfoBlock,
  stripRelatedPostHeadlines,
  stripGuardianTopicsFooter,
  stripOutletTrailer,
  stripKnownTrailers,
  trailerFixesEnabled,
  FOURTHWALSH_FOOTER_RE,
  OUTLET_TRAILER_STRIPPERS,
};
