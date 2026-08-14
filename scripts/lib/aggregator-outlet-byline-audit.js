/**
 * aggregator-outlet-byline-audit.js — keep-vs-collapse predicate for reviews
 * filed under an AGGREGATOR outlet (dtli, london-box-office,
 * theatre-reviews-limited) that carry a real, named critic byline.
 *
 * Context (Notion card, BRO-225): these three aggregators legitimately employ
 * staff/contributing critics (David Roberts edits Theatre Reviews Limited;
 * Stuart King writes for London Box Office; DTLI runs a rotating pool of
 * contributors). A separate, now-closed bug (createOrMergeReviewFile Case-2
 * cross-domain refinement, fixed 2c679ad4bb1) could collapse a real outlet's
 * review onto the aggregator's outletId when the URL sat on the aggregator's
 * own domain. Frequency of the byline is NOT a reliable signal — DTLI has
 * several genuine one-off contributors. The reliable signal is CONTENT: a
 * collapsed file's fullText is lifted verbatim (or near-verbatim, via a long
 * shared word-shingle) from a sibling review filed under a real, non-
 * aggregator outlet for the same show. A file with no such match is treated
 * as the aggregator's own staff/contributing-critic content.
 *
 * Confirmed case (2026-08-14): a-beautiful-noise-the-neil-diamond-musical-2022
 * /dtli--juan-michael-porter-ii.json carries a paragraph lifted verbatim from
 * wsj--charles-isherwood.json ("There are certainly some infectious
 * sing-along numbers, notably 'Sweet Caroline.' ...") — a duplicate, not a
 * distinct staff-critic review.
 */

const STAFF_CRITIC_AGGREGATOR_OUTLET_IDS = new Set([
  'dtli',
  'london-box-office',
  'theatre-reviews-limited',
]);

// Two false-positive classes found during corpus validation (2026-08-14):
//   1. Two independent critics quoting the SAME distinctive line of dialogue
//      or lyric from the show itself (e.g. both quote "Bright Star"'s "truth
//      seeks us out" epigraph) — a coincidental match, not duplicated review
//      prose. Fix: strip quoted spans before shingling.
//   2. Shared CMS/page chrome ("share on facebook (opens in new window)...")
//      that leaks into fullText identically across totally unrelated shows.
//      Fix: strip known chrome phrases before shingling.
const BOILERPLATE_PATTERNS = [
  /share on \w+(?:\s*\(opens in new window\))?/g,
  /\(opens in new window\)/g,
  /click to share on \w+/g,
  /related articles?/g,
  /read more/g,
  /subscribe to (?:our|the) newsletter/g,
];

function stripQuotedSpans(text) {
  if (!text) return '';
  return String(text)
    .replace(/[“"][^“”"]{4,}[”"]/g, ' ') // smart or straight double-quoted spans
    .replace(/[‘][^‘’]{4,}[’]/g, ' ') // smart single-quoted spans (min length 4 avoids eating short contractions)
    // Straight single-quoted spans ('like this') — UK outlets (theatre-reviews-
    // limited, london-box-office) commonly quote dialogue/lyrics this way, the
    // same false-positive source stripped above for curly quotes. Requires a
    // word-boundary on both sides so "don't"/"critic's" contractions — which
    // have no boundary before their apostrophe — never match as an open quote.
    .replace(/(?<=^|[\s([])'[^']{4,}?'(?=[\s).,!?;:]|$)/g, ' ');
}

function stripBoilerplate(text) {
  let out = String(text || '');
  for (const p of BOILERPLATE_PATTERNS) out = out.replace(p, ' ');
  return out;
}

function normalizeForShingles(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Consecutive-word shingles — robust to a garbled prefix/suffix on the
// aggregator side (the collapse case has unrelated content spliced in before
// and after the lifted paragraph). Quoted dialogue/lyrics and known page
// chrome are stripped first so a shingle can only be built from the critic's
// own analytical prose (see BOILERPLATE_PATTERNS / stripQuotedSpans above).
// A third false-positive class found during corpus validation: shared cast
// lists ("Featuring: A, B, C, D...") sourced from the same press release and
// reproduced verbatim by multiple outlets — not duplicated review prose. Cast
// enumerations pack 3+ commas into a tight word window; real critic sentences
// almost never do. Reject any shingle at or above that density.
function isCastListLike(shingle) {
  return (shingle.match(/,/g) || []).length >= 3;
}

function wordShingles(text, shingleLen = 16, stride = 4) {
  const cleaned = stripBoilerplate(stripQuotedSpans(text));
  const words = normalizeForShingles(cleaned).split(' ').filter(Boolean);
  const shingles = [];
  for (let i = 0; i + shingleLen <= words.length; i += stride) {
    const shingle = words.slice(i, i + shingleLen).join(' ');
    if (!isCastListLike(shingle)) shingles.push(shingle);
  }
  return shingles;
}

/**
 * Classify one aggregator-filed, named-critic review against its sibling
 * review-text files for the same show.
 *
 * @param {object} aggregatorReview - the review-text JSON for the aggregator
 *   file under audit. Expects outletId/outlet, criticName, fullText,
 *   dtliExcerpt (optional).
 * @param {object[]} siblingReviews - review-text JSON objects for every OTHER
 *   file in the same show directory (any outlet, including other aggregator
 *   files — those are skipped internally).
 * @returns {{classification: 'staff-critic'|'collapsed-duplicate'|'not-applicable', reason: string, duplicateOfOutlet?: string, duplicateOfCritic?: string}}
 *
 * IMPORTANT for callers applying a fix on 'collapsed-duplicate': set
 * `wrongAttribution: true`, NOT `duplicateOf`. safeWriteReview's write guard
 * (review-write-guard.js) auto-clears any `duplicateOf` pointer whose URL
 * doesn't match the target file's URL — which is always true here, since the
 * whole point is an aggregator-domain URL vs. the real outlet's own URL. A
 * `duplicateOf` fix silently self-heals away on the next write; `wrongAttribution`
 * is the only exclusion flag that survives the guard for this shape of fix.
 */
function classifyAggregatorByline(aggregatorReview, siblingReviews) {
  const outletId = aggregatorReview.outletId || aggregatorReview.outlet;
  if (!STAFF_CRITIC_AGGREGATOR_OUTLET_IDS.has(outletId)) {
    return { classification: 'not-applicable', reason: `outlet "${outletId}" is not a staff-critic aggregator` };
  }
  const criticName = aggregatorReview.criticName;
  if (!criticName || criticName === 'Unknown' || /^(staff|editor)/i.test(criticName)) {
    return { classification: 'not-applicable', reason: 'no named critic byline to audit' };
  }

  const candidateText = aggregatorReview.fullText || aggregatorReview.dtliExcerpt || '';
  const shingles = wordShingles(candidateText);
  if (shingles.length === 0) {
    return { classification: 'staff-critic', reason: 'insufficient text to compare — default to staff/contributing-critic content' };
  }

  for (const sibling of siblingReviews || []) {
    const sibOutlet = sibling.outletId || sibling.outlet;
    if (STAFF_CRITIC_AGGREGATOR_OUTLET_IDS.has(sibOutlet)) continue; // only real outlets count as ground truth
    const sibText = normalizeForShingles(sibling.fullText);
    if (!sibText || sibText.length < 200) continue;
    for (const shingle of shingles) {
      if (sibText.includes(shingle)) {
        return {
          classification: 'collapsed-duplicate',
          reason: `fullText shares a verbatim passage with "${sibOutlet}" (critic: ${sibling.criticName || 'unknown'}) — byline collapsed onto the aggregator, not a distinct review`,
          duplicateOfOutlet: sibOutlet,
          duplicateOfCritic: sibling.criticName || null,
        };
      }
    }
  }

  return { classification: 'staff-critic', reason: 'no matching content found in any sibling real-outlet review — treated as the aggregator\'s own staff/contributing-critic content' };
}

module.exports = { classifyAggregatorByline, STAFF_CRITIC_AGGREGATOR_OUTLET_IDS, wordShingles, normalizeForShingles };
