/**
 * Pure helper functions extracted from rebuild-all-reviews.js for testability.
 *
 * These functions ARE the production code — rebuild-all-reviews.js imports from here.
 * Scoring thresholds and constants come from score-extractors.js (single source of truth).
 */

const { BUCKET_SCORES, THUMB_SCORES, scoreToBucket, scoreToThumb, OUTLET_VERIFIED_SOURCES, KNOWN_STAR_OUTLETS, OUTLET_STAR_AUTHORITATIVE, extractScore } = require('./score-extractors');
const { parseOriginalScore } = require('./score-parsers');
const { decodeHtmlEntities, cleanText } = require('./text-cleaning');
const { AGGREGATOR_SCORE_SOURCES: AGGREGATOR_SOURCES_SET } = require('./review-normalization');
const { isUncorroboratedGenericStar, adjudicationSidedWithStars, adjudicationContradictsRecordStar, adjudicationStarBasisGone } = require('./star-reliability');
const { publishedScoreViolation } = require('./published-score-star-band');

// Low-reliability star EXTRACTION sources — automated CSS/generic pattern matches
// that often read the wrong element (pagination, dates, sidebars). The LLM may
// override these; everything else (json-ld, verified star images, svg/unicode
// stars, letter grades, outlet APIs) is the critic's own published rating and is
// trusted. Module-scoped so both the P0.4 late-star fall-through (keyed on
// originalScoreSource) and the P0.5 reliability check use ONE list.
const LOW_RELIABILITY_STAR_SOURCES = new Set([
  'css-stars', 'star-class', 'css-rating', 'star-rating',
  'text-pattern', 'og-description', 'wp-api-title',
  'numeric-stars',    // Generic "X/5" pattern — false positives from pagination, dates, URLs
]);

// Whether a raw originalScore string is an UNAMBIGUOUS rating form that re-parses
// reliably (letter grade like "A"/"B+", or a star form like "3/5", "4 stars",
// "★★★"). Bare numbers ("5", "85") are AMBIGUOUS — "5" could mean 5/100 or 5 stars
// — so they are NOT unambiguous and must defer to the stored originalScoreNormalized
// (Pattern Card #7). Used by the stale-normalized guard in the P0 scoring path.
function isUnambiguousRatingString(raw) {
  if (raw == null) return false;
  const s = String(raw).trim();
  if (!s) return false;
  if (/^[A-Fa-f][+-]?$/.test(s)) return true;            // letter grade token
  if (/\d\s*\/\s*\d/.test(s)) return true;               // X/N (3/5, 8/10)
  if (/\bstars?\b/i.test(s)) return true;                // "4 stars", "3.5 stars"
  if (/[★⭑✪☆]/.test(s)) return true;                     // glyph stars
  if (/\bout of\b/i.test(s)) return true;                // "4 out of 5"
  return false;                                          // bare number / freeform → ambiguous
}

// ===================================================
// TEXT CLEANING
// ===================================================

// Canonical thumb spellings are 'Up' / 'Flat' / 'Down'. Aggregator scrapers
// have written 'Meh' (DTLI's own label), and — BRO-4204 audit S6-T6 — the
// upper-case 'UP' / 'MEH' / 'DOWN' (112 corpus files as of 2026-09-28), which
// the old exact-match version passed through untouched: the P2 thumb
// validation then read 'UP' as neutral and silently lost the signal. Any
// casing of up/meh/flat/down normalizes; an unknown spelling still passes
// through unchanged (callers treat it as neutral).
function normalizeThumb(thumb) {
  if (thumb == null) return thumb;
  const key = String(thumb).trim().toLowerCase();
  if (key === 'meh' || key === 'flat') return 'Flat';
  if (key === 'up') return 'Up';
  if (key === 'down') return 'Down';
  return thumb;
}

// Direction of a 0-100 score's bucket: Rave/Positive → positive, Negative/Pan
// → negative, Mixed → neutral.
function bucketDirectionOfScore(score) {
  const bucket = scoreToBucket(score);
  if (bucket === 'Rave' || bucket === 'Positive') return 'positive';
  if (bucket === 'Negative' || bucket === 'Pan') return 'negative';
  return 'neutral';
}

/**
 * BRO-4204 audit S6-T6: do BOTH aggregator thumbs (DTLI + BWW) agree with each
 * other AND point the opposite way from the verdict — a two-bucket
 * disagreement (both Up vs a Negative/Pan score, both Down vs a Positive/Rave
 * score)? Mixed verdicts and Flat thumbs never qualify: a one-bucket gap
 * (Up vs Mixed) is ordinary calibration noise that the P2 thumb validation
 * already handles. Two editors who both read the full review and both
 * disagree with the LLM by two buckets is the case the adjudication queue
 * exists for, so the rebuild stamps `needsAdjudication: true` on the emitted
 * record and queues it (reason 'both-thumbs-disagree-with-llm').
 *
 * Pure. Thumb spellings go through normalizeThumb.
 *
 * @param {object} data   review-text record (dtliThumb / bwwThumb read)
 * @param {number} score  the verdict being emitted
 * @returns {boolean}
 */
function bothThumbsOpposeVerdict(data, score) {
  if (!data || typeof score !== 'number' || !Number.isFinite(score)) return false;
  const dtli = data.dtliThumb ? normalizeThumb(data.dtliThumb) : null;
  const bww = data.bwwThumb ? normalizeThumb(data.bwwThumb) : null;
  if (!dtli || !bww || dtli !== bww) return false;
  if (dtli !== 'Up' && dtli !== 'Down') return false;
  const verdictDir = bucketDirectionOfScore(score);
  if (verdictDir === 'neutral') return false;
  const thumbDir = dtli === 'Up' ? 'positive' : 'negative';
  return thumbDir !== verdictDir;
}

// A one-step gap (Down thumb vs a Mixed score, Up thumb vs a Mixed score) only
// counts when the score sits at least this far inside Mixed from the thumb's
// side: Down flags at >= 60, Up flags at <= 64. Scores right at the bucket
// edge (55-59 vs Down, 65-69 vs Up) are calibration noise.
const ONE_STEP_THUMB_MARGIN = 5;

/**
 * BRO-4287: cross-check an LLM verdict against the aggregator editors' thumbs
 * (DTLI + BWW). Replaces the TODO that left ensembleData.thumbsMatch null.
 * Never changes a score: a flagged review is queued for the existing
 * adjudicator (adjudicate-review-queue.js), which is the only thing that may
 * move it.
 *
 * expectedThumb: the two thumbs when they agree, or the single one present.
 *   A decisive + Flat pair has no majority → null. Up vs Down → null + split flag.
 * thumbsMatch: scoreToThumb(score) === expectedThumb (null when no expectation).
 * flag: null | { reason, detail }
 *   'both-thumbs-disagree-with-llm'    both thumbs agree and oppose the score
 *   'aggregator-thumb-contradicts-llm' opposite direction, or one step past the margin
 *   'aggregator-thumbs-split'          DTLI and BWW disagree Up vs Down
 * A Flat expectation never flags (the adjudicator's audit found Flat thumbs
 * wrong 83% of the time). anchored: true (a star-banded verdict) flags only an
 * opposite-direction gap: the band already pins it to the critic's own star.
 *
 * @param {object} data   review-text record (dtliThumb / bwwThumb read)
 * @param {number} score  the verdict being emitted
 * @param {{anchored?: boolean}} [opts]
 */
function aggregatorThumbCheck(data, score, opts = {}) {
  const none = { expectedThumb: null, thumbsMatch: null, flag: null };
  if (!data || typeof score !== 'number' || !Number.isFinite(score)) return none;
  const canon = (t) => {
    const n = t ? normalizeThumb(t) : null;
    return n === 'Up' || n === 'Flat' || n === 'Down' ? n : null;
  };
  const dtli = canon(data.dtliThumb);
  const bww = canon(data.bwwThumb);
  if (!dtli && !bww) return none;
  const ours = scoreToThumb(score);
  const label = `${dtli || '-'}/${bww || '-'}`;

  if (dtli && bww && dtli !== bww) {
    if (dtli !== 'Flat' && bww !== 'Flat' && !opts.anchored) {
      return { ...none, flag: {
        reason: 'aggregator-thumbs-split',
        detail: `verdict ${score} (${scoreToBucket(score)}) vs split aggregator thumbs DTLI/BWW ${label}`,
      } };
    }
    return none;
  }

  const expectedThumb = dtli || bww;
  const thumbsMatch = ours === expectedThumb;
  const result = { expectedThumb, thumbsMatch, flag: null };
  if (thumbsMatch || expectedThumb === 'Flat') return result;

  const opposite = ours !== 'Flat';
  const pastMargin = expectedThumb === 'Down'
    ? score >= 55 + ONE_STEP_THUMB_MARGIN
    : score <= 69 - ONE_STEP_THUMB_MARGIN;
  if (!opposite && (opts.anchored || !pastMargin)) return result;

  const both = !!(dtli && bww);
  result.flag = {
    reason: both && opposite ? 'both-thumbs-disagree-with-llm' : 'aggregator-thumb-contradicts-llm',
    detail: `verdict ${score} (${scoreToBucket(score)}) vs aggregator thumbs DTLI/BWW ${label}`
      + ` — ${opposite ? 'opposite direction' : 'one bucket off'}, needsAdjudication`,
  };
  return result;
}

/**
 * BRO-4204 audit S6-T5: what makes an `originalScore` value a PUBLISHED rating
 * the P0.5 path may score from, as opposed to a bare number some upstream
 * writer relayed (Show-Score's 0-100 critic score, a manual --score, an
 * aggregator's normalized value) that only LOOKS like a rating?
 *
 *   'unambiguous'                 — letter grade / star form / X-out-of-N
 *                                   (isUnambiguousRatingString)
 *   'verified-scoreSource'        — the extraction source is one of the
 *                                   outlet-verified extractors
 *   'verified-originalScoreSource'— same, recorded on originalScoreSource
 *   'starRating'                  — the file carries the star form alongside
 *                                   the normalized number (manual ingest shape:
 *                                   starRating "4/5", originalScore 80)
 *   null                          — a bare numeric / percentage / freeform
 *                                   string with no verified provenance: NOT a
 *                                   published rating; P0.5 must not score it
 *
 * The Rocky Horror 2026 shape that motivated this (originalScore 75 numeric,
 * source 'manual', no starRating, no scoreSource) returns null. "88.6/100"
 * returns 'unambiguous' — an explicit denominator is a rating form by
 * isUnambiguousRatingString's definition — even from a relay source such as
 * theatre-record; provenance gating of X/100 strings would need its own field
 * and is out of scope here (documented in the colocated test).
 *
 * Parsing itself is unchanged: parseOriginalScore (score-parsers.js) keeps
 * its semantics; this is a gate at its P0.5 call site only.
 *
 * @param {string|number} raw  the candidate originalScore value
 * @param {object} data        review-text record (scoreSource / originalScoreSource / starRating read)
 * @returns {string|null}
 */
// Registry starScale by outletId (lazy, cached). Tests pass opts.starScale
// instead of touching the registry.
let _starScaleRegistry = null;
function registryStarScale(outletId) {
  if (!outletId) return null;
  if (_starScaleRegistry === null) {
    try {
      const _fs = require('fs');
      const _path = require('path');
      _starScaleRegistry = JSON.parse(_fs.readFileSync(_path.join(__dirname, '..', '..', 'data', 'outlet-registry.json'), 'utf-8'));
    } catch {
      _starScaleRegistry = { outlets: {} };
    }
  }
  const entry = (_starScaleRegistry.outlets || {})[outletId];
  if (!entry || !Number.isFinite(entry.starScale) || entry.starScale <= 0) return null;
  return entry.starScale;
}

// 'star-ladder' (S6-T5 follow-up): a bare number at an outlet the registry says
// publishes N-star ratings, sitting exactly on that ladder (k * 100/N for a
// whole k in 1..N — Time Out's 60 = ★★★, the Guardian's 80 = ★★★★, USA Today's
// 75 = ★★★ of 4), is the older web-search pipeline's star relay, not a made-up
// number. The strict gate's scoring-delta showed ~50 such T1 relays (timeout,
// guardian, times-uk) would otherwise be replaced by an LLM read within a few
// points of the published star. A number OFF the ladder (75 at a 5-star
// outlet, EW's 88) or at an outlet with no starScale stays ambiguous.
function isOnStarLadder(raw, starScale) {
  if (!Number.isFinite(starScale) || starScale <= 0) return false;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return false;
  const k = n / (100 / starScale);
  return Math.abs(k - Math.round(k)) < 1e-9 && Math.round(k) >= 1 && Math.round(k) <= starScale;
}

function publishedRatingEvidence(raw, data, opts) {
  if (raw == null || raw === '') return null;
  if (isUnambiguousRatingString(raw)) return 'unambiguous';
  const d = data || {};
  if (d.scoreSource && OUTLET_VERIFIED_SOURCES.has(d.scoreSource)) return 'verified-scoreSource';
  if (d.originalScoreSource && OUTLET_VERIFIED_SOURCES.has(d.originalScoreSource)) return 'verified-originalScoreSource';
  if (isUnambiguousRatingString(d.starRating)) return 'starRating';
  const starScale = opts && Object.prototype.hasOwnProperty.call(opts, 'starScale') ? opts.starScale : registryStarScale(d.outletId);
  if (isOnStarLadder(raw, starScale)) return 'star-ladder';
  return null;
}

function isPublishedRatingEvidence(raw, data) {
  return publishedRatingEvidence(raw, data) !== null;
}

const { normalizeDate } = require('./date-utils');
function normalizePublishDate(dateStr) {
  return normalizeDate(dateStr);
}

function fixMojibake(text) {
  if (!text) return text;
  return text
    .replace(/\u00e2\u0080\u0099/g, '\u2019')
    .replace(/\u00e2\u0080\u0098/g, '\u2018')
    .replace(/\u00e2\u0080\u009c/g, '\u201c')
    .replace(/\u00e2\u0080\u009d/g, '\u201d')
    .replace(/\u00e2\u0080\u0094/g, '\u2014')
    .replace(/\u00e2\u0080\u0093/g, '\u2013')
    .replace(/\u00e2\u0080\u00a6/g, '\u2026')
    .replace(/â€™/g, '\u2019')
    .replace(/â€˜/g, '\u2018')
    .replace(/â€œ/g, '\u201c')
    .replace(/â€\u009d/g, '\u201d')
    .replace(/â€"/g, '\u2014')
    .replace(/â€"/g, '\u2013')
    .replace(/â€¦/g, '\u2026')
    .replace(/Ã©/g, 'é')
    .replace(/Ã¨/g, 'è')
    .replace(/Ã¯/g, 'ï')
    .replace(/Ã¼/g, 'ü')
    .replace(/Ã¶/g, 'ö')
    .replace(/Ã´/g, 'ô')
    .replace(/Ã®/g, 'î')
    .replace(/Ã¢/g, 'â')
    .replace(/Ã /g, 'à');
}

function fixMissingPeriods(text) {
  if (!text) return text;
  let result = text;
  result = result.replace(/(\d{4})\s+([A-Z][a-z])/g, '$1. $2');
  result = result.replace(/No Comment\s*(BY\s)/i, 'No Comment. $1');
  result = result.replace(/\)([A-Z][a-z])/g, '). $1');
  result = result.replace(/Darkness([A-Z][a-z])/g, 'Darkness. $1');
  return result;
}

// ===================================================
// EXCERPT QUALITY GATES
// ===================================================

function isJunkExcerpt(text) {
  if (!text) return true;

  const junkPatterns = [
    /^Home\s+(Legit|News|Reviews)/i,
    /^\d{1,2}:\d{2}\s*(AM|PM)\s*(PT|ET|CT)/i,
    /Plus Icon.*Latest/i,
    /See All\s+[A-Z]/i,
    /\d+ (day|week|month|hour)s? ago/i,
    /Related Stories/i,
    /By [A-Z][a-z]+ [A-Z][a-z]+ Plus Icon/i,
    /TV Review.*TV Review/i,
    /Photo:/i,
    /Matthew Murphy\s+[A-Z]/,
    /\bdefineSlot\b|\bsetTargeting\b|\bgoogletag\b/i,
    /blogherads/i,
    /^NYC Events,?\s+Restaurants/i,
    /Cititour\.com\s*Review/i,
    /^(Facebook|Twitter|Pinterest|Threads)\s+(Twitter|Facebook|Pinterest|X\b)/i,
    /^Visit the Site/i,
    /^Tickets from \$/i,
    /By clicking submit/i,
    /<a\s+href=/i,
    /^Home\s*[>|]/i,
    /newsletter in your inbox/i,
    /Get all the top news.*discount/i,
    /Open\/Close Dates/i,
    /\bprivacy policy\b/i,
    /^Skip to (content|main)/i,
    /^Democracy Dies/i,
    /^Q:\s/i,
    /^Posted on\s+\w+\s+\d/i,
    /^This article was published more than/i,
    /^Listen\d+\s*min/i,
    /rose lovers|Bachelor in Paradise|couples grapple/i,
    /^(MUSIC|THEATER).*Add Topic/i,
    /^Trump says|^Biden|^Senate\s+(votes|passes)/i,
    /Keep Watching|mins ago\s/i,
    /Hear this story/i,
  ];

  for (const pattern of junkPatterns) {
    if (pattern.test(text)) return true;
  }

  const first50 = text.substring(0, 50);
  const datePatterns = first50.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/gi) || [];
  if (datePatterns.length >= 2) return true;

  if (text.length >= 40) {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    if (words.length >= 5) {
      const commonWords = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'is', 'it', 'that', 'for', 'was', 'on', 'are', 'with', 'as', 'but', 'this', 'his', 'her', 'not', 'has', 'had', 'an', 'be', 'at', 'by', 'or', 'its', 'from', 'who', 'than', 'if', 'so', 'no', 'more']);
      const commonCount = words.filter(w => commonWords.has(w)).length;
      const ratio = commonCount / words.length;
      if (ratio < 0.03) return true;
    }
  }

  return false;
}

function isGenericQuote(text) {
  if (!text) return true;
  const lower = text.toLowerCase().trim();

  const genericPatterns = [
    /^(it('s| is)|this is) (a )?(must[- ]see|worth seeing|not to be missed)\b/,
    /^don'?t miss (it|this)/,
    /^(highly )?recommended\.?$/,
    /^(go )?see (it|this show)/,
    /^a (great|good|wonderful|terrible|bad) show\.?$/,
  ];

  const sceneSettingPatterns = [
    /^when the (curtain|lights|house lights|show) /,
    /^at the [a-z]+ the(a|u)tre/,
    /^on a recent (evening|night|afternoon)/,
    /^(walking|stepping) into the /,
    /^the (stage|set) (is|was) (bare|dark|set)/,
  ];

  for (const p of [...genericPatterns, ...sceneSettingPatterns]) {
    if (p.test(lower)) return true;
  }

  if (lower.length < 100 && /(must[- ]see|not to be missed|highly recommended)\b/.test(lower)) {
    return true;
  }

  return false;
}

function trimToCompleteSentence(text) {
  if (!text) return text;
  const trimmed = text.trim();

  const contractionMatch = trimmed.match(/(^|\s)(he|she|it|we|they|who|wasn|wouldn|couldn|didn|don|isn|aren|won|haven|hasn|shouldn|mustn|weren|hadn|I)['\u2019]$/);
  if (contractionMatch) {
    const match = trimmed.match(/^(.*[.!?"\u201D])\s/s);
    if (match && match[1].length >= 40) return match[1].trim();
    return trimmed;
  }

  if (/[.!?"\u201D)]\s*$/.test(trimmed)) return trimmed;
  if (/[.!?][')\u2019]\s*$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(.*[.!?"\u201D'])\s*\S+.*$/s);
  if (match && match[1].length >= 40) return match[1].trim();
  return trimmed;
}

function normalizeQuoteWrapping(text) {
  if (!text) return text;
  let result = text.trim();
  if ((result.startsWith('"') || result.startsWith('\u201c')) &&
      (result.endsWith('"') || result.endsWith('\u201d'))) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

// ===================================================
// EXCERPT CLEANING
// ===================================================

/**
 * Clean excerpt text from aggregator sources.
 * Strips ad code, navigation boilerplate, photo credits, multi-critic concatenation.
 * Truncates to 350 chars at sentence boundary. Returns null for junk/empty input.
 */
function cleanExcerpt(text) {
  if (!text) return null;

  let cleaned = fixMissingPeriods(fixMojibake(decodeHtmlEntities(text)));

  // Reject URLs masquerading as excerpts
  if (/^https?:\/\//i.test(cleaned.trim())) return null;

  // --- Layer 1: Systematic excerpt quality gates ---
  cleaned = cleaned.replace(/Average Rating:.*$/s, '');
  cleaned = cleaned.replace(/\{\s*"@context".*$/s, '');
  cleaned = cleaned.replace(/^\*?CRITIC[''\u2019]?S PICK\*?\s*/i, '');
  cleaned = cleaned.replace(/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-zA-Z'-]+,\s+[A-Z][\w\s&.'-]{2,40}:\s*/, '');
  cleaned = cleaned.replace(/^[,\s]*:\s*/, '');
  cleaned = cleaned.replace(/[\u0080-\u009F]/g, '');
  cleaned = cleaned.replace(/â\s/g, '\u2014 ');
  cleaned = cleaned.replace(/â$/, '\u2014');

  // Strip navigation/boilerplate prefixes
  cleaned = cleaned.replace(/^Skip to (content|main content)\s*/i, '');
  cleaned = cleaned.replace(/^(This article was published more than[^.]*\.\s*)?Democracy Dies in Darkness\s*/i, '');
  cleaned = cleaned.replace(/^Q:\s+[^?]*\?\s*/i, '');
  cleaned = cleaned.replace(/^Posted on\s+\w+\s+\d{1,2},?\s+\d{4}\s*/i, '');
  cleaned = cleaned.replace(/^No Comment\s*(BY\s+)?/i, '');
  cleaned = cleaned.replace(/^Listen\s*\d+\s*min\s*/i, '');
  cleaned = cleaned.replace(/^[A-Z][^.]{10,80}\.\s*\([A-Z][a-z]+ [A-Z][a-z]+\)\s*/i, '');
  cleaned = cleaned.replace(/^Review by\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*(?:—\s*)?/i, '');
  cleaned = cleaned.replace(/^[^|]{0,80}\|\s*Photo\s*:\s*[A-Z][a-z]+(?:\s+(?:and\s+)?[A-Z][a-z]+)*(?:\s+[A-Z][a-z]+)*\s+/i, '');

  // Remove JavaScript/ad code patterns
  cleaned = cleaned.replace(/blogherads\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\.defineSlot\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setTargeting\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.addSize\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.exemptFromSleep\(\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setClsOptimization\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setSubAdUnitPath\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/googletag\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\(adsbygoogle\s*=\s*window\.adsbygoogle\s*\|\|\s*\[\]\)\.push\(\{[^}]*\}\);?\s*/g, '');
  cleaned = cleaned.replace(/\[\s*["']mid-article\d*["'][^\]]*\]/gi, '');
  cleaned = cleaned.replace(/Related Stories\s+[A-Z][^"]*$/gi, '');

  // Remove photo credits mixed into text
  cleaned = cleaned.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\s+(?=Thirty|The|In|When|After|Before|It|This|That|A|An)/g, '');

  // Stop at next critic attribution (BWW roundups concatenate multiple critics)
  const nextCriticMatch = cleaned.match(/\.\s+[A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)?,\s+[A-Z][^:]+:/);
  if (nextCriticMatch && nextCriticMatch.index > 50) {
    cleaned = cleaned.substring(0, nextCriticMatch.index + 1);
  }

  // Strip trailing boilerplate
  cleaned = cleaned.replace(/\s*By clicking submit[^]*$/i, '');
  cleaned = cleaned.replace(/\s*<a\s+href=[^]*$/i, '');
  cleaned = cleaned.replace(/\s*Copyright ©[^]*$/i, '');
  cleaned = cleaned.replace(/\s*Visit the Site\S*[^]*$/i, '');
  cleaned = cleaned.replace(/\s*(Read more|Continue reading|Read the full review)\.?\s*$/i, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Skip if starts mid-word/mid-sentence (unless it's a quote)
  if (/^[a-z]/.test(cleaned) && !cleaned.startsWith('"')) {
    const sentenceStart = cleaned.search(/[.!?]\s+[A-Z]/);
    if (sentenceStart > 0 && sentenceStart < cleaned.length - 50) {
      cleaned = cleaned.substring(sentenceStart + 2);
    } else {
      return null;
    }
  }

  // Skip junk excerpts
  if (isJunkExcerpt(cleaned)) {
    return null;
  }

  // Truncate to 350 chars at sentence boundary
  if (cleaned.length > 350) {
    const truncateAt = cleaned.lastIndexOf('.', 350);
    cleaned = truncateAt > 100 ? cleaned.substring(0, truncateAt + 1) : cleaned.substring(0, 347) + '...';
  }

  // Final junk check
  if (/defineSlot|setTargeting|blogherads|Plus Icon|adsbygoogle|googletag/i.test(cleaned)) {
    return null;
  }

  return cleaned.length > 30 ? cleaned : null;
}

// ===================================================
// SCORING LOGIC
// ===================================================

/**
 * Check if contentVerification is stale (text was re-fetched after verification,
 * or content hash has changed). Returns false if verification should be ignored.
 */
function isContentVerificationActive(data) {
  if (!data.contentVerification || !data.contentVerification.wrongArticle) return false;

  // Stale if text was fetched after verification
  if (data.textFetchedAt && data.contentVerification.verifiedAt) {
    const fetchedAt = new Date(data.textFetchedAt).getTime();
    const verifiedAt = new Date(data.contentVerification.verifiedAt).getTime();
    if (fetchedAt > verifiedAt) return false;
  }

  // Stale if content hash changed
  if (data.contentVerification.contentHash && data.fullText) {
    const currentHash = require('./content-verifier').contentHash(data.fullText);
    if (data.contentVerification.contentHash !== currentHash) return false;
  }

  return true;
}

// Distinctive-word tokens: lowercase alpha runs of 5+ chars. Short/common words
// carry no cross-show signal, so they're excluded from both sides of the
// overlap check below.
const _DISTINCTIVE_TOKEN_RE = /[a-z]{5,}/g;

// Only westEndTheatreExcerpt is checked here, NOT the full EXCERPT_FIELDS list.
// westEndTheatreExcerpt is scraped straight off the review's own page section
// (extractSectionReviews/extractStarRatings in sweep-we-aggregators.js) — when
// correctly matched, its wording is a literal slice of that same fullText.
// The other excerpt fields (theStageExcerpt, dtliExcerpt, bwwExcerpt, etc.) are
// frequently ROUNDUP blurbs that paraphrase or quote SEVERAL critics in one
// outlet's own words (e.g. "Dominic Cavendish labels it 'fiercely timely'") —
// legitimately about the right show and critic, but not a substring of that
// critic's own fullText elsewhere. Checking those too produced 45 false
// positives corpus-wide (ship-check on this fix, 2026-09-22) — restricting to
// westEndTheatreExcerpt, the field actually implicated in the Book of Mormon
// incident, keeps the signal clean.
const _AGGREGATOR_STAR_EXCERPT_FIELD = 'westEndTheatreExcerpt';

/**
 * Guard against aggregatorStars (a THIRD-PARTY-relayed rating — e.g.
 * WestEndTheatre.com reporting "Guardian: 2/5") being cross-attributed from a
 * DIFFERENT show's roundup entry that happens to share this file's outlet+critic
 * slot. Caught 2026-09-22 (Broadway Scorecard feedback form): a WestEndTheatre
 * roundup match wrote aggregatorStars="2/5" and westEndTheatreExcerpt onto
 * the-book-of-mormon-west-end-2024/guardian--arifa-akbar.json from Brigadoon's
 * roundup row, not Book of Mormon's — this file's own fullText was (and remained)
 * a correct, unanimous-ensemble Rave review, but the contaminated aggregatorStars
 * won P0.5 precedence over it and later drove a bad adjudicatedScore=40.
 *
 * When the file carries BOTH a full-length review body (fullText) and a
 * westEndTheatreExcerpt (the same WET sweep writes aggregatorStars alongside
 * it), the excerpt should describe the SAME review as fullText. A short
 * excerpt sharing essentially none of its distinctive words with a long,
 * unrelated fullText is the signature of this cross-attribution bug, not of
 * normal excerpting (a real WET excerpt is a verbatim slice of the review it's
 * paired with).
 *
 * Deliberately permissive: returns true (don't block) whenever there isn't
 * enough signal to judge — no fullText, no westEndTheatreExcerpt, or too few
 * distinctive words in the excerpt to trust a ratio. This is a targeted
 * contamination check, not a general content-quality gate.
 *
 * @param {object} data - a parsed review-text record
 * @returns {boolean} false only when westEndTheatreExcerpt looks like it
 *   belongs to a different review than fullText
 */
function aggregatorStarsCorroboratedByFullText(data) {
  if (!data || typeof data.fullText !== 'string' || data.fullText.length < 200) return true;

  const excerpts = [data[_AGGREGATOR_STAR_EXCERPT_FIELD]].filter((v) => typeof v === 'string' && v.length >= 40);
  if (excerpts.length === 0) return true;

  const fullTextLower = data.fullText.toLowerCase();
  let judged = false;
  for (const excerpt of excerpts) {
    const tokens = new Set((excerpt.toLowerCase().match(_DISTINCTIVE_TOKEN_RE) || []));
    if (tokens.size < 4) continue; // too short to judge — don't penalize
    judged = true;

    let matched = 0;
    for (const t of tokens) {
      if (fullTextLower.includes(t)) matched++;
    }
    // At least one excerpt corroborates fullText — good enough (a file can carry
    // several excerpt fields from different aggregators; only one needs to agree).
    if (matched / tokens.size >= 0.2) return true;
  }
  // true (don't block) when no excerpt had enough signal to judge; false only
  // when at least one judgeable excerpt failed to overlap with fullText.
  return !judged;
}

/**
 * Determine the best score for a review from all available sources.
 *
 * This is the core scoring priority logic used by rebuild-all-reviews.js.
 * It takes a review data object and returns { score, source } or null.
 *
 * @param {object} data - Review data with score fields
 * @param {object} [opts] - Options
 * @param {object} [opts.stats] - Stats object to increment counters on
 * @param {function} [opts.flagForHumanReview] - Callback for flagging reviews
 * @returns {{ score: number, source: string } | null}
 */
/**
 * Every `source` label getBestScore() can emit, in priority order. BRO-4204
 * S7-T11: rebuild-all-reviews.js initialises `_meta.stats.scoreSources` from
 * this list so a label that no review hits in a given rebuild still reports 0
 * (not absent — and, before S6-T5 made the counter safe, not `null`: the
 * three main sources 'llm-v6'/'anchored-v6'/'adjudicated' were missing from
 * the seed object, `undefined++` produced NaN and JSON serialised it as null).
 * tests/unit/rebuild-score-source-stats.test.mjs scans this function's source
 * so a new `source: '…'` literal without a matching entry here fails CI.
 */
const SCORE_SOURCE_LABELS = Object.freeze([
  'human-review',
  'adjudicated',
  'anchored-v6',
  'llm-v6',
  'originalScore-priority0',
  'aggregatorStars-relay',
  'llmScore-override-star-conflict',
  'originalScore-inline-recovery',
  'llmScore-override-inline-recovery-conflict',
  'llmScore',
  'originalScore-showscore-downgraded',
  'llmScore-lowconf',
  'llmScore-review',
  'assignedScore',
  'bucket',
  'bwwScore-fallback',
  'aggregatorStars-fallback',
  'thumb',
  'llmScore-thumb-validated',
  'llmScore-thumb-boosted',
]);

function getBestScore(data, opts = {}) {
  const stats = opts.stats || {};
  const flagForHumanReview = opts.flagForHumanReview || (() => {});
  const inc = (key) => { stats[key] = (stats[key] || 0) + 1; };

  // Skip if explicitly marked as TO_BE_CALCULATED
  if (data.scoreStatus === 'TO_BE_CALCULATED') {
    return null;
  }

  // P0: Human-reviewed score (manual override — always wins)
  // Semantic: humanReviewScoreProvisional === true means the operator wrote a
  // tentative score but wants the LLM to override once a real score lands.
  // Default (undefined / false) is LOCKED — humanReviewScore is the final word,
  // which is the Rocky Horror 2026-04-23 Helen Shaw case the brief codifies.
  if (data.humanReviewScore && data.humanReviewScore >= 1 && data.humanReviewScore <= 100) {
    if (data.humanReviewScoreProvisional !== true) {
      return { score: data.humanReviewScore, source: 'human-review' };
    }
    inc('humanReviewScoreProvisionalSkipped');
  }

  // P0a: Adjudicated score (LLM re-evaluation of flagged reviews — beats LLM but not human)
  // EXCEPTION: skip adjudication when the review has an outlet-verified originalScore
  // from a KNOWN star outlet. Star ratings are authoritative ground truth per
  // memory/feedback_star_score_cap.md — the adjudicator should not override them.
  // Stale adjudicatedScore values sitting on files with explicit stars are bugs.
  if (data.adjudicatedScore && data.adjudicatedScore >= 1 && data.adjudicatedScore <= 100) {
    const hasVerifiedStarScore = data.originalScore
      && OUTLET_VERIFIED_SOURCES.has(data.scoreSource)
      && OUTLET_STAR_AUTHORITATIVE.has(data.outletId);
    // Same rule for a star-anchored verdict (BRO-4287): anchored-v6 already
    // pins the score inside the critic's published-star band, so an
    // adjudication outside that band (±2, as the marker staleness guard below)
    // contradicts the star. Seen live: Six WE Lost in Theatreland, 5-star band
    // 91-100, shipped as 40 because the adjudicator invented a "2/5 stars".
    // Exception: an adjudication that read the text and explicitly sided with
    // the LLM against the star (Electra WE Daily Mail: a mis-extracted 5/5 on
    // a negative review) is a reasoned dispute of the star itself, so it stands.
    // Auto-accepts carry a stale LLM score and "sided with stars" verdicts that
    // land outside the star band contradict themselves; neither stands.
    const anchoredBand = data.scoreSource === 'anchored-v6' && data.llmScore && data.llmScore.band;
    const disputesStar = /^Auto-adjudicated \([^)]*sided with llm\)/i.test(data.adjudicationNote || '');
    const outsideAnchoredBand = !!(anchoredBand && typeof anchoredBand.floor === 'number' && !disputesStar
      && (data.adjudicatedScore < anchoredBand.floor - 2 || data.adjudicatedScore > anchoredBand.ceiling + 2));
    // BRO-4499: an adjudication that sided with the star is only as good as the
    // star. A generic-pattern "1/5" the ensemble contradicts turned a rave
    // Chicago Tribune review into a 40. The star is the same one P0.5 ignores
    // below (isUncorroboratedGenericStar), so the two paths stay consistent.
    const uncorroboratedStarBasis = adjudicationSidedWithStars(data)
      && typeof data.originalScoreNormalized === 'number'
      && isUncorroboratedGenericStar(data, data.originalScoreNormalized);
    // Same rule when the record's own trusted star contradicts the adjudication
    // that claims to follow it.
    const staleStarBasis = uncorroboratedStarBasis || adjudicationContradictsRecordStar(data)
      || adjudicationStarBasisGone(data);
    // BRO-4839: the guard above only covers files stamped anchored-v6. An adjudication that auto-accepted a stale LLM
    // score (or an invented basis) also landed outside the critic's band on llm-v6 / relabelled files: 39 published
    // reviews, a printed 2/5 shown as 91. The same star-band test, from the record's own HIGH-reliability rating.
    // Only the SELF-CONTRADICTING adjudications: an "Auto-accepted ..." that kept a stale LLM score, or a verdict that
    // says it sided with the star yet landed outside it. A reasoned text dispute of a rating (thumbs, "neither", an LLM
    // read of a pan whose "grade" the text never prints) is a different thing and stands.
    const selfContradicting = /^Auto-accepted/i.test(data.adjudicationNote || '') || adjudicationSidedWithStars(data);
    const outsideStarBand = !outsideAnchoredBand && !disputesStar && selfContradicting
      && !!publishedScoreViolation(data, data.adjudicatedScore, { unanimousTol: Infinity });
    if (!hasVerifiedStarScore && !outsideAnchoredBand && !outsideStarBand && !staleStarBasis) {
      return { score: data.adjudicatedScore, source: 'adjudicated' };
    }
    inc(outsideAnchoredBand || outsideStarBand ? 'adjudicationSkippedOutsideStarBand'
      : staleStarBasis ? 'adjudicationSkippedUncorroboratedStar'
        : 'adjudicationSkippedExplicitStars');
  }

  // P0.4: anchored-v6 / llm-v6 (Phase B Sprint 3, 2026-05-16)
  // When the file was scored with the anchored-bands path
  // (ANCHORED_BANDS_PILOT=1, see scripts/llm-scoring/ensemble-scorer.ts), the
  // llmScore.score has ALREADY been constrained to the critic's band. It is
  // the canonical answer — no need to fall through to P0.5 (originalScore)
  // or P1 (raw LLM). This precedence beats originalScore because the LLM was
  // deliberately given the critic's star/grade as a hard constraint and
  // produced a within-band score; the originalScore (linear star-flat) is
  // now superseded by the within-band LLM verdict.
  //
  // 'anchored-v6': high-reliability star/grade was detected → V6 prompt with band
  // 'llm-v6':       no star OR low-reliability extraction → V6 prompt no band
  //
  // humanReviewScore (P0) + adjudicatedScore (P0a) still override — manual
  // verdicts always win.
  //
  // EXCEPTION (2026-06-30): 'llm-v6' means "no usable star AT SCORING TIME". But
  // on opening nights the LLM scores the text immediately and the outlet's star
  // widget is scraped LATER, leaving scoreSource='llm-v6' alongside a now-present
  // high-reliability star this early return would ignore — so a published 2/5
  // showed as 62, a 3/5 as 77 (7 bucket-crossing live errors: care Time Out,
  // dark-of-the-moon WhatsOnStage/everything-theatre, an-ideal-husband Times,
  // mass, please-please-me). When an 'llm-v6' review now carries a parseable
  // originalScore, fall through to P0.5 so the published star (and its existing
  // reliability/LLM-conflict logic) decides. 'anchored-v6' already used the
  // star's band as a hard constraint — keep returning it as-is.
  // llmScore.band is only ever written by the anchored scorer, so its presence
  // proves this llmScore is a band-constrained (anchored) verdict — even when a
  // later star extraction overwrote scoreSource with its extraction label
  // (e.g. 'telegraph-svg-stars'), which used to knock the file out of this
  // early return and ship the flat star conversion via P0.5 (2026-07-11).
  const anchoredBand = data.llmScore && data.llmScore.band;
  let hasAnchoredBandMarker = !!(anchoredBand && typeof anchoredBand.floor === 'number');
  // Staleness guard (marker path only — a real 'anchored-v6'/'llm-v6' stamp is
  // handled by the existing logic below): the star can CHANGE after anchoring
  // (equus telegraph: anchored to an aggregator-relayed 5/5, the outlet's own
  // svg extraction later wrote 4/5). If the current originalScore parses to a
  // flat value outside the anchored band (±2 for boundary rounding), the
  // marker is stale — fall through so the current published star decides at
  // P0.5. Deliberately NOT re-flagged for re-anchor: band detection may keep
  // preferring the stale relay field, which would re-flag forever.
  if (hasAnchoredBandMarker
      && data.scoreSource !== 'anchored-v6' && data.scoreSource !== 'llm-v6'
      && data.originalScore) {
    const currentFlat = parseOriginalScore(data.originalScore, data.outletId);
    if (currentFlat !== null
        && (currentFlat < anchoredBand.floor - 2 || currentFlat > anchoredBand.ceiling + 2)) {
      hasAnchoredBandMarker = false;
    }
  }
  if ((data.scoreSource === 'anchored-v6' || data.scoreSource === 'llm-v6' || hasAnchoredBandMarker)
      && data.llmScore && typeof data.llmScore.score === 'number'
      && data.llmScore.score >= 0 && data.llmScore.score <= 100) {
    // Band marker present → the verdict is anchored regardless of the stamp.
    const effectiveV6Source = (data.scoreSource === 'anchored-v6' || hasAnchoredBandMarker)
      ? 'anchored-v6' : 'llm-v6';
    // Only HIGH-reliability late stars win — a low-reliability extraction
    // (numeric-stars/css-stars, often a false positive) must NOT override the
    // LLM, which is why llm-v6 kept the LLM in the first place.
    //
    // Reliability of the late star (2026-07-11 hardening):
    // - originalScoreSource present → trust its reliability class.
    // - originalScoreSource ABSENT → the raw value must be an unambiguous
    //   rating form ("5/5 stars", "★★★★", "A-"). A bare numeric with no
    //   extraction source is an aggregator's normalized 0-100 relay (e.g.
    //   Show Score writing originalScore=100), NOT a published star — it was
    //   knocking llm-v6 out of this early return and the raw aggregator
    //   number then shipped via P3b over the LLM's sentiment score (JCS
    //   london-theatre: LLM 94, site showed 100).
    const lateStarReliable = data.originalScoreSource
      ? !LOW_RELIABILITY_STAR_SOURCES.has(data.originalScoreSource)
      : isUnambiguousRatingString(data.originalScore);
    const llmV6HasLateStar = effectiveV6Source === 'llm-v6'
      && data.originalScore
      && lateStarReliable
      && parseOriginalScore(data.originalScore, data.outletId) !== null;
    if (!llmV6HasLateStar) {
      const v6Score = data.llmScore.score;
      // S6-T6 / BRO-4287: the aggregator editors' thumbs contradict the v6
      // verdict → emit the verdict unchanged but queue it for adjudication.
      const thumbCheck = aggregatorThumbCheck(data, v6Score, { anchored: effectiveV6Source === 'anchored-v6' });
      // Already adjudicated but P0a declined it (outside the star band):
      // re-queueing would re-adjudicate the same file every day.
      if (thumbCheck.flag && !data.adjudicatedScore) {
        inc(thumbCheck.flag.reason === 'both-thumbs-disagree-with-llm' ? 'bothThumbsOpposeV6Verdict' : 'aggregatorThumbFlagV6');
        flagForHumanReview(data, thumbCheck.flag.reason, `${effectiveV6Source} ${thumbCheck.flag.detail}`);
        return { score: v6Score, source: effectiveV6Source, needsAdjudication: true };
      }
      return { score: v6Score, source: effectiveV6Source };
    }
  }

  // P0.5: originalScore (aggregator-provided)
  // Downgrade aggregator-sourced ratings for WE ONLY when the aggregator is rating
  // the show independently (e.g., Show Score's own 1-100). Trust the rating when
  // a known star-rating outlet's score is relayed through an aggregator (e.g.,
  // WestEndTheatre.com reporting "Guardian: 4/5" — that IS the Guardian's real rating).
  const AGGREGATOR_SOURCES = new Set([
    'show-score', 'show-score-playwright', 'showscore-roundup',
    'theatre-reviews', 'theatre-reviews-roundup',
    'westendtheatre', 'stagedoor', 'theatre-record',
    'bww-roundup', 'bww-reviews', 'playbill-verdict',
    'lbo-roundup', 'lbo-individual', 'nyc-theatre',
  ]);
  // KNOWN_STAR_OUTLETS imported from score-extractors.js (single source of truth)
  const isAggregatorSource = AGGREGATOR_SOURCES.has(data.source);
  const isWestEnd = data._showCategory === 'west-end' || data._showCategory === 'off-west-end';
  const isOutletVerified = OUTLET_VERIFIED_SOURCES.has(data.scoreSource);
  const isKnownStarOutlet = KNOWN_STAR_OUTLETS.has(data.outletId);
  // First-party LBO byline reviews (Stuart King + Nicola Wright + Shehrazade
  // Zafar-Arif) come through source='lbo-individual'. These are LBO's own
  // editorial team — the bstarsN class on those pages IS the critic's
  // published rating, not a third-party aggregator score. Treat them like a
  // known-star-outlet to bypass downgrade. (Stuart King report 2026-04-26.)
  //
  // `source` is only the LAST writer to touch the file; the full provenance
  // lives in `sources[]`. 30 first-party LBO bylines carry 'lbo-individual'
  // in sources[] under a different primary source (12 of them 'lbo-roundup',
  // which IS in AGGREGATOR_SOURCES) — the original single-field predicate
  // missed every one, so the same Stuart King 3★/4★ reviews the 2026-04-26
  // fix was written for kept getting the WE-aggregator downgrade. Read the
  // array. (Aggregator/first-party split audit 2026-08-02.)
  //
  // `sources[]` is APPEND-ONLY merge history (review-file-writer.js preserves
  // every prior source on merge), so a token in it proves the file was touched
  // by that path once — not that the CURRENT payload is a byline review. The
  // URL is the content-identity check: LBO's own roundups live at
  // /news/post/review-round-up-* and isRoundupUrl matches them, so requiring a
  // non-roundup URL keeps a later-merged roundup from inheriting the exemption
  // and shipping a relayed headline star as a critic's own rating.
  const lboSources = Array.isArray(data.sources) ? data.sources : [];
  const { isRoundupUrl } = require('./review-guards');
  const isLBOFirstParty = data.outletId === 'london-box-office'
    && (data.source === 'lbo-individual' || lboSources.includes('lbo-individual'))
    && !isRoundupUrl(data.url || '').isRoundup;
  // Only downgrade if: aggregator source + WE + NOT outlet-verified + NOT a known star outlet + NOT LBO first-party
  const downgradeShowScore = isAggregatorSource && isWestEnd && !isOutletVerified && !isKnownStarOutlet && !isLBOFirstParty;

  // Skip P0 if score was deliberately cleared by audit (aggregator in wrong slot,
  // extraction with no evidence, outlet doesn't publish star ratings).
  // EXCEPTION: Tier 1.5 clearing ("extraction-no-evidence-in-text") was incorrect when:
  // (a) The outlet is a KNOWN_STAR_OUTLET — they DO publish star ratings
  // (b) The scoreSource is unicode-stars or word-stars — these are unambiguous formats
  //     that were correctly extracted but textContainsStarRating() couldn't find in fullText
  //     because the stars were in HTML structure, not the article body text.
  const isTier15Cleared = data.originalScoreCleared === true &&
    data.originalScoreClearedReason && data.originalScoreClearedReason.startsWith('extraction-no-evidence');
  const UNAMBIGUOUS_STAR_SOURCES = new Set(['unicode-stars', 'word-stars']);
  // Don't override for outlets explicitly marked as no-score (noScoreExtractor).
  // Their unicode-stars extractions came from aggregator page structure, not the outlet.
  const { OUTLET_EXTRACTORS } = require('./score-extractors');
  const outletExtractor = OUTLET_EXTRACTORS[data.outletId];
  const isNoScoreOutlet = outletExtractor && outletExtractor('', '')?.__skipGeneric;
  // Also override for outlets with real extractors (not noScoreExtractor) — they're
  // recognized star-rating outlets whose scores were incorrectly cleared.
  const hasRealExtractor = outletExtractor && !isNoScoreOutlet;
  const isTier15Override = isTier15Cleared && !isNoScoreOutlet &&
    (isKnownStarOutlet || UNAMBIGUOUS_STAR_SOURCES.has(data.scoreSource) || hasRealExtractor);
  const scoreCleared = data.originalScoreCleared === true && !isTier15Override;
  // Also skip if scoreSource is a known aggregator source — these should be in
  // aggregatorStars, not originalScore (prevents re-contamination even if
  // originalScore gets re-set by a CI process that hasn't been updated yet)
  const isAggregatorScoreSource = AGGREGATOR_SOURCES_SET && AGGREGATOR_SOURCES_SET.has(data.scoreSource);

  // Effective score: use originalScore, or for known star outlets, treat aggregatorStars
  // as the outlet's own published rating (aggregators relay "Guardian: 4/5" etc.)
  // When Tier 1.5 override is active, recover the original score:
  // 1. If originalScore still populated: use it (unless previousOriginalScore differs significantly,
  //    in which case prefer previousOriginalScore as ground truth from before clearing)
  // 2. If originalScore was nulled: use previousOriginalScore (saved by P0 script before clearing)
  let resolvedOriginalScore = data.originalScore;
  if (isTier15Override && !data.originalScore && data.previousOriginalScore) {
    // Score was nulled by P0 script — recover from previousOriginalScore
    resolvedOriginalScore = String(data.previousOriginalScore);
  }
  // aggregatorStars corroboration guard (2026-09-22, Book of Mormon West End
  // feedback report): only trust a third-party-relayed star rating when it
  // isn't contradicted by a mismatched excerpt riding along with it (see
  // aggregatorStarsCorroboratedByFullText docblock). resolvedOriginalScore is
  // NOT gated here — it comes from the outlet's own fetched page, a different,
  // lower-risk pipeline than the aggregator-roundup excerpt+star pairing this
  // guards against.
  const aggregatorStarsUsable = data.aggregatorStars && (isKnownStarOutlet || isLBOFirstParty)
    && aggregatorStarsCorroboratedByFullText(data);
  if (data.aggregatorStars && (isKnownStarOutlet || isLBOFirstParty) && !aggregatorStarsUsable) {
    inc('aggregatorStarsExcerptMismatch');
    flagForHumanReview(data, 'aggregatorStars-excerpt-mismatch',
      `aggregatorStars "${data.aggregatorStars}" ignored — its excerpt field doesn't overlap with fullText (likely cross-attributed from a different show's aggregator roundup row)`);
  }
  // S6-T5 (BRO-4204 audit): a bare NUMBER in originalScore (Show-Score's 75
  // relayed by a manual/web-search writer, a normalized value with no
  // extraction source) is NOT a published rating — the old code parsed it via
  // parseNumericRating and shipped it as 'originalScore-priority0' over the
  // ensemble LLM read. Require the unambiguous star/letter form, an
  // outlet-verified extraction source, or the star form riding alongside in
  // starRating (publishedRatingEvidence). An ambiguous originalScore falls
  // through — to a usable aggregatorStars relay here, else to P1+ — and is
  // counted as skippedAmbiguousOriginalScore.
  const originalCandidate = (!scoreCleared && !isAggregatorScoreSource && resolvedOriginalScore) || null;
  const originalEvidence = originalCandidate ? publishedRatingEvidence(originalCandidate, data) : null;
  if (originalCandidate && !originalEvidence) inc('skippedAmbiguousOriginalScore');
  const gatedOriginalScore = originalEvidence === 'starRating' ? data.starRating
    : originalEvidence ? originalCandidate : null;
  // When aggregatorStars drives the score the emitted record labels it
  // 'aggregatorStars-relay' (and rebuild-all-reviews.js displays the relayed
  // star as originalRating) instead of masquerading as the outlet's own
  // originalScore.
  const effectiveFromAggregatorStars = !gatedOriginalScore && !!aggregatorStarsUsable;
  const effectiveOriginalScore = gatedOriginalScore || (effectiveFromAggregatorStars ? data.aggregatorStars : null);
  const effectiveScoreLabel = effectiveFromAggregatorStars ? 'aggregatorStars (known star outlet)' : 'originalScore';
  const p05Source = effectiveFromAggregatorStars ? 'aggregatorStars-relay' : 'originalScore-priority0';

  if (effectiveOriginalScore && !downgradeShowScore) {
    if (data.scoreConfidence === 'low' || data.scoreSource === 'star-icon' || data.scoreSource === 'star-icon-cleared') {
      inc('skippedLowConfidenceOriginal');
    } else {
      // Pattern Card #7: prefer originalScoreNormalized (set at extraction time with the correct
      // star/letter/numeric scale) over re-parsing the raw string. Re-parsing "5" as a bare
      // integer returns 5/100 (pan) when it was extracted as "5 stars" (100/100 rave).
      // Fall back to parseOriginalScore() when normalizedValue is absent (older records).
      const normalizedFromExtraction = (typeof data.originalScoreNormalized === 'number' && data.originalScoreNormalized >= 0 && data.originalScoreNormalized <= 100)
        ? data.originalScoreNormalized : null;
      const reparsedOriginal = parseOriginalScore(effectiveOriginalScore, data.outletId);
      // Stale-normalized guard (2026-06-29): originalScoreNormalized is a stored
      // field that can go stale and silently override a correct grade. 11 corpus-
      // wide, e.g. the-piano-lesson-2022 EW "A" with stored normalized 20 → the
      // rebuild emitted assignedScore 20 (Pan) even though originalScore="A" and the
      // LLM agreed Rave. When the raw originalScore is an UNAMBIGUOUS letter/star
      // form (the re-parse is reliable — unlike a bare number where "5" could be 5
      // or 100, which is why Pattern Card #7 prefers the stored value) AND the
      // stored normalized disagrees with the canonical re-parse by >6, the stored
      // value is stale: trust the re-parse. Bare-number originalScores still defer
      // to the stored normalized.
      let parsed;
      if (reparsedOriginal !== null && normalizedFromExtraction !== null
          && isUnambiguousRatingString(effectiveOriginalScore)
          && Math.abs(reparsedOriginal - normalizedFromExtraction) > 6) {
        inc('staleNormalizedOverridden');
        parsed = reparsedOriginal;
      } else {
        parsed = normalizedFromExtraction ?? reparsedOriginal;
      }
      // BRO-4499: a generic free-text "X/5" match that the ensemble contradicts
      // across a bucket boundary is not a rating. Ignore it (like the ambiguous
      // originalScore above) and let P1+ score the review from its text.
      if (parsed !== null && isUncorroboratedGenericStar(data, parsed)) {
        inc('skippedUncorroboratedGenericStar');
        parsed = null;
      }
      if (parsed !== null) {
        const llm = data.llmScore && data.llmScore.score;
        const llmConf = data.llmScore && data.llmScore.confidence;
        // LOW reliability = automated CSS/generic extraction that often reads wrong elements.
        // LLM can override these. Everything else (json-ld, verified star images, letter
        // grades, unicode stars) is the critic's own published rating — never override.
        // Single source: module-scoped LOW_RELIABILITY_STAR_SOURCES (lbo-css-stars
        // promoted to HIGH reliability 2026-04-01: first bstarsN is always the
        // review rating, second is a sidebar related article; 33/33 matched).
        const LOW_RELIABILITY_EXTRACTION = LOW_RELIABILITY_STAR_SOURCES;
        // Outlet-level trust overrides generic scoreSource labels. Outlets in
        // OUTLET_STAR_AUTHORITATIVE have dedicated extractors (or well-understood
        // markup) and publish their own star ratings; a generic "css-stars" /
        // "numeric-stars" label from their dedicated path must not downgrade them
        // to LOW-reliability where a high-confidence LLM could overwrite them.
        const isHighReliability =
          !LOW_RELIABILITY_EXTRACTION.has(data.scoreSource) ||
          OUTLET_STAR_AUTHORITATIVE.has(data.outletId);
        // RAW-vs-RAW comparison: this 25-point bucket-jump guard decides whether
        // to TRUST the LLM over a low-reliability star extraction. The decision
        // must be made on the raw LLM score so the threshold semantics match
        // the historical behavior the guard was tuned for.
        if (llm && llmConf !== 'low' && Math.abs(parsed - llm) > 25) {
          const parsedBucket = parsed >= 70 ? 'positive' : parsed <= 40 ? 'negative' : 'mixed';
          const llmBucket = llm >= 70 ? 'positive' : llm <= 40 ? 'negative' : 'mixed';
          if (parsedBucket !== llmBucket) {
            flagForHumanReview(data, 'originalScore-llm-conflict',
              `${effectiveScoreLabel} "${effectiveOriginalScore}" (=${parsed}, bucket=${parsedBucket}) vs LLM ${llm} (bucket=${llmBucket}, conf=${llmConf})` +
              (isHighReliability ? ` [HIGH-reliability: ${data.scoreSource} — kept]` : ' [LOW-reliability — LLM override]'));
            // Only let LLM override LOW-reliability extractions (css-stars reading
            // wrong element, generic pattern matches). HIGH-reliability sources
            // (json-ld, verified star images, letter grades) are the critic's own
            // published rating and must be kept.
            if (llmConf === 'high' && !isHighReliability) {
              inc('originalScoreOverriddenByLLM');
              return { score: llm, source: 'llmScore-override-star-conflict' };
            }
          }
        }
        return { score: parsed, source: p05Source };
      }
    }
  }

  // P0.75: Inline star recovery at rebuild time
  // When originalScore is missing, try extracting from fullText. Two cases:
  // (a) Non-KNOWN outlets with Tier 1.5 clearing (KNOWN outlets are handled above by P0.5 override)
  // (b) KNOWN_STAR_OUTLETS that never had originalScore extracted (only fullText available)
  // Respects scoreConfidence === 'low' (skip unreliable extractions).
  //
  // SAFETY: Inline recovery is lower-reliability than explicit originalScore — the stars
  // may come from pull-quotes, ad copy, or unrelated content in fullText. So we apply
  // the same LLM-bucket-conflict guard as P0.5's LOW_RELIABILITY path: if the LLM
  // score disagrees strongly (>25pt delta AND different bucket) with high confidence,
  // trust the LLM and flag for human review.
  if (!effectiveOriginalScore && (isKnownStarOutlet || isTier15Cleared) && data.fullText && data.scoreConfidence !== 'low') {
    const recovered = extractScore('', data.fullText, data.outletId, data.showTitle);
    if (recovered && recovered.normalizedScore != null) {
      // Only trust unicode-stars and word-stars sources — these are unambiguous
      const TRUSTED_RECOVERY_SOURCES = new Set(['unicode-stars', 'unicode-stars-fallthrough', 'word-stars']);
      if (TRUSTED_RECOVERY_SOURCES.has(recovered.source)) {
        const recoveredScore = recovered.normalizedScore;
        const llm = data.llmScore && data.llmScore.score;
        const llmConf = data.llmScore && data.llmScore.confidence;
        if (llm && llmConf !== 'low' && Math.abs(recoveredScore - llm) > 25) {
          const recBucket = recoveredScore >= 70 ? 'positive' : recoveredScore <= 40 ? 'negative' : 'mixed';
          const llmBucket = llm >= 70 ? 'positive' : llm <= 40 ? 'negative' : 'mixed';
          if (recBucket !== llmBucket) {
            flagForHumanReview(data, 'inline-recovery-llm-conflict',
              `inline-recovery (${recovered.source}=${recoveredScore}, bucket=${recBucket}) vs LLM ${llm} (bucket=${llmBucket}, conf=${llmConf})` +
              ' [inline-recovery treated as LOW-reliability — LLM override on high conf]');
            if (llmConf === 'high') {
              inc('inlineRecoveryOverriddenByLLM');
              return { score: llm, source: 'llmScore-override-inline-recovery-conflict' };
            }
          }
        }
        inc('inlineStarRecovery');
        return { score: recoveredScore, source: 'originalScore-inline-recovery' };
      }
    }
  }

  // P1: LLM score (HIGH/MEDIUM confidence with ensemble)
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;

    const cvWrongArticle = isContentVerificationActive(data);
    const staleCvCleared = data.contentVerification?.wrongArticle && !cvWrongArticle;
    if (staleCvCleared) inc('staleContentVerificationCleared');

    const hasOriginalFullText = data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom && !cvWrongArticle;
    const effectiveConfidence = (!hasOriginalFullText && confidence !== 'low') ? 'low' : confidence;

    if (effectiveConfidence !== 'low' && !needsReview) {
      const hasEnsemble = !!data.ensembleData;
      if (!hasEnsemble) {
        inc('blockedSingleModel');
      } else {
        // BRO-4287: same thumb cross-check as the v6 path (was an inline
        // both-thumbs check in rebuild-all-reviews.js's wrapper).
        const thumbCheck = aggregatorThumbCheck(data, data.llmScore.score);
        if (thumbCheck.flag) {
          inc('aggregatorThumbFlagP1');
          flagForHumanReview(data, thumbCheck.flag.reason, `llmScore ${thumbCheck.flag.detail}`);
          return { score: data.llmScore.score, source: 'llmScore', needsAdjudication: true };
        }
        return { score: data.llmScore.score, source: 'llmScore' };
      }
    }
  }

  // P2: Thumb-validated LLM
  const hasLowConfLlm = data.llmScore?.score && !!data.ensembleData &&
    (data.llmScore.confidence === 'low' || data.ensembleData?.needsReview ||
     !(data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom));

  if (hasLowConfLlm) {
    const dtliThumbNorm = data.dtliThumb ? normalizeThumb(data.dtliThumb) : null;
    const bwwThumbNorm = data.bwwThumb ? normalizeThumb(data.bwwThumb) : null;
    const llmScore = data.llmScore.score;
    const llmBucket = scoreToBucket(llmScore);

    const thumbDirection = (thumb) => {
      if (thumb === 'Up') return 'positive';
      if (thumb === 'Down') return 'negative';
      return 'neutral';
    };
    const bucketDirection = (bucket) => {
      if (bucket === 'Rave' || bucket === 'Positive') return 'positive';
      if (bucket === 'Negative' || bucket === 'Pan') return 'negative';
      return 'neutral';
    };

    const llmDir = bucketDirection(llmBucket);
    const bwwScoreDir = data.bwwScore != null
      ? (data.bwwScore >= 7 ? 'positive' : data.bwwScore <= 3 ? 'negative' : 'neutral')
      : null;

    const thumbDirs = [];
    const dtliIsMeh = dtliThumbNorm === 'Flat';
    const bwwIsMeh = bwwThumbNorm === 'Flat';
    if (dtliThumbNorm && !dtliIsMeh) thumbDirs.push(thumbDirection(dtliThumbNorm));
    if (bwwThumbNorm && !bwwIsMeh) thumbDirs.push(thumbDirection(bwwThumbNorm));
    if (bwwScoreDir && bwwScoreDir !== 'neutral' && !bwwThumbNorm) thumbDirs.push(bwwScoreDir);
    const agreeing = thumbDirs.filter(d => d === llmDir).length;
    const disagreeing = thumbDirs.filter(d => d !== llmDir && d !== 'neutral').length;

    if (agreeing > 0 && disagreeing === 0) {
      inc('thumbValidatedLlm');
      return { score: llmScore, source: agreeing >= 2 ? 'llmScore-thumb-validated' : 'llmScore-thumb-boosted' };
    }

    if (disagreeing > 0 && agreeing === 0) {
      if (disagreeing >= 2) {
        flagForHumanReview(data, 'both-thumbs-disagree-with-llm',
          `LLM=${llmScore} (${llmBucket}), thumbs=${dtliThumbNorm || '-'}/${bwwThumbNorm || '-'}`);
      }
    }
  }

  // P3b: Downgraded ShowScore originalScore (WE only)
  if (downgradeShowScore && data.originalScore) {
    const parsed = parseOriginalScore(data.originalScore, data.outletId);
    if (parsed !== null) {
      inc('showScoreDowngradedFallback');
      return { score: parsed, source: 'originalScore-showscore-downgraded' };
    }
  }

  // P4: LLM score fallback (low conf / needs review / excerpt-only)
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;
    const isExcerptOnly = !(data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom);
    const hasEnsemble = !!data.ensembleData;

    if (!hasEnsemble) {
      inc('blockedSingleModel');
    } else if (confidence === 'low' || isExcerptOnly) {
      return { score: data.llmScore.score, source: 'llmScore-lowconf' };
    } else if (needsReview) {
      return { score: data.llmScore.score, source: 'llmScore-review' };
    }
  }

  // P4b: Existing assignedScore — score validation already happened, trust it.
  // Previously gated behind scoreSource/thumb checks, but assignedScore in 1-100
  // means the review was validated (manually or by pipeline). contentTier=invalid
  // should prevent re-scoring (via isScoreable) but not exclude from reviews.json.
  // BRO-4612: a bare placeholder 50 (no ensemble, no source, no original score) is
  // not validation; it skips this rung and the bucket rung that merely echoes it.
  const placeholderAssigned = isPlaceholderAssignedScore(data);
  if (!placeholderAssigned && data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100) {
    return { score: data.assignedScore, source: 'assignedScore' };
  }

  // P5: Bucket mapping
  if (data.bucket && BUCKET_SCORES[data.bucket] &&
      !(placeholderAssigned && BUCKET_SCORES[data.bucket] === data.assignedScore)) {
    return { score: BUCKET_SCORES[data.bucket], source: 'bucket' };
  }

  // P5.5: bwwScore fallback
  if (data.bwwScore != null && data.bwwScore >= 1 && data.bwwScore <= 10) {
    return { score: data.bwwScore * 10, source: 'bwwScore-fallback' };
  }

  // P5.7: aggregatorStars fallback — third-party star ratings from aggregator sites.
  // Only trust if the outlet actually publishes star ratings (KNOWN_STAR_OUTLETS)
  // and, same as P0.5 above, the rating isn't contradicted by a mismatched
  // excerpt riding along with it (aggregatorStarsCorroboratedByFullText).
  // Otherwise the aggregator may have invented the rating (e.g., London Theatre)
  // or cross-attributed it from a different show's roundup row.
  if (data.aggregatorStars && isKnownStarOutlet && aggregatorStarsCorroboratedByFullText(data)) {
    const parsed = parseOriginalScore(data.aggregatorStars, data.outletId);
    if (parsed !== null && !isUncorroboratedGenericStar(data, parsed)) {
      inc('aggregatorStarsFallback');
      return { score: parsed, source: 'aggregatorStars-fallback' };
    }
  }

  // P6: Thumb mappings
  if (data.dtliThumb && THUMB_SCORES[data.dtliThumb]) {
    return { score: THUMB_SCORES[data.dtliThumb], source: 'thumb' };
  }
  if (data.bwwThumb && THUMB_SCORES[data.bwwThumb]) {
    return { score: THUMB_SCORES[data.bwwThumb], source: 'thumb' };
  }
  if (data.thumb && THUMB_SCORES[data.thumb]) {
    return { score: THUMB_SCORES[data.thumb], source: 'thumb' };
  }

  return null;
}

// ===================================================
// URL DATE EXTRACTION
// ===================================================

// Show-title years that look like dates but aren't
const TITLE_YEARS = new Set(['1776', '1984', '1812', '1921', '1992', '1940', '2026']);

const MONTH_ABBR_TO_NUM = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function validateCalendarDate(year, month, day) {
  if (year < 1970 || year > 2027 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Extract a publish date from a review URL. Returns { date, dateSource } or null.
 * date is YYYY-MM-DD for full dates, YYYY-MM for month-only, or null.
 * yearOnly is set when only a year could be extracted (for wrong-production flagging).
 */
function extractDateFromUrl(url) {
  if (!url) return null;
  const pathOnly = url.split('?')[0].split('#')[0];

  // Pattern 1: /YYYY/MM/DD/ (WordPress-style, most reliable)
  const slashMatch = pathOnly.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (slashMatch && !TITLE_YEARS.has(slashMatch[1])) {
    const result = validateCalendarDate(parseInt(slashMatch[1]), parseInt(slashMatch[2]), parseInt(slashMatch[3]));
    if (result) return { date: result, source: 'url-ymd' };
  }

  // Pattern 2: /YYYY/mon/DD (Guardian-style: /2018/apr/22)
  const guardianMatch = pathOnly.match(/\/(20\d\d)\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})/i);
  if (guardianMatch) {
    const month = MONTH_ABBR_TO_NUM[guardianMatch[2].toLowerCase()];
    if (month) {
      const result = validateCalendarDate(parseInt(guardianMatch[1]), parseInt(month), parseInt(guardianMatch[3]));
      if (result) return { date: result, source: 'url-guardian' };
    }
  }

  // Pattern 3: YYYYMMDD at end of URL path (BWW-style: -20241010)
  const bwwMatch = pathOnly.match(/[^0-9](20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/);
  if (bwwMatch) {
    const result = validateCalendarDate(parseInt(bwwMatch[1]), parseInt(bwwMatch[2]), parseInt(bwwMatch[3]));
    if (result) return { date: result, source: 'url-compact' };
  }

  // Pattern 4: YYYY-MM-DD in path (Bloomberg, LA Times)
  const dashMatch = pathOnly.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dashMatch && !TITLE_YEARS.has(dashMatch[1])) {
    const y = parseInt(dashMatch[1]), m = parseInt(dashMatch[2]), d = parseInt(dashMatch[3]);
    // Reject if it doesn't look like a date (e.g., 1776-10-17 is a title year pattern)
    if (y >= 2000 && y <= 2027) {
      const result = validateCalendarDate(y, m, d);
      if (result) return { date: result, source: 'url-dash' };
    }
  }

  // Pattern 5: blogspot.com/YYYY/MM/ (year+month only)
  const blogspotMatch = pathOnly.match(/\.blogspot\.com\/(\d{4})\/(\d{2})\//);
  if (blogspotMatch) {
    const y = parseInt(blogspotMatch[1]), m = parseInt(blogspotMatch[2]);
    if (y >= 2000 && y <= 2027 && m >= 1 && m <= 12) {
      return { date: `${y}-${String(m).padStart(2, '0')}`, source: 'url-blogspot-ym' };
    }
  }

  // Pattern 6: Talkin' Broadway off-broadway section — /ob/MM_DD_YY.html or
  // /page/ob/MM_DD_YY.html, optional trailing letter for same-day multi-review
  // disambiguation (02_08_24b.html). Scoped to the domain since the shape is
  // generic. TB has been behind a Cloudflare managed challenge since ~2026-04
  // (fetchPage can't reach it — see collect-review-texts.js), so this URL-only
  // path is the only viable date source for TB off-broadway reviews.
  if (/talkinbroadway\.com/i.test(url)) {
    const tbMatch = pathOnly.match(/\/(?:page\/)?ob\/(\d{1,2})_(\d{1,2})_(\d{2})[a-z]?\.html/i);
    if (tbMatch) {
      const month = parseInt(tbMatch[1], 10);
      const day = parseInt(tbMatch[2], 10);
      const yy = parseInt(tbMatch[3], 10);
      const year = yy <= 30 ? 2000 + yy : 1900 + yy;
      const result = validateCalendarDate(year, month, day);
      if (result) return { date: result, source: 'url-tb-ob' };
    }
  }

  // Pattern 7: Year-only extraction (for wrong-production flagging, not display)
  // Look for /YYYY/ bounded by path separators
  const yearMatch = pathOnly.match(/\/(20\d\d)\//);
  if (yearMatch && !TITLE_YEARS.has(yearMatch[1])) {
    const y = parseInt(yearMatch[1]);
    if (y >= 2000 && y <= 2027) {
      return { date: null, yearOnly: y, source: 'url-year-only' };
    }
  }

  return null;
}

/**
 * Applies the two score-unlocking normalizations rebuild-all-reviews.js's main
 * loop performs on every file (aggregator-sourced originalScore→aggregatorStars
 * migration, garbageFullText→fullText recovery) — WITHOUT writing back to disk.
 * Mutates and returns `data` in place; the caller decides whether/how to persist.
 *
 * Single source of truth for both:
 *  - the dedup-priority sort prepass (rebuild-all-reviews.js's sortMeta build),
 *    which reads each file once, before the main loop's own pass
 *  - the main loop, which additionally writes the migrated fields back to disk
 *
 * Without this shared step, a file whose only path to a score is one of these
 * two migrations would sort as unscored in the prepass (computed against the
 * raw, pre-migration parse) even though it WILL score once the main loop's own
 * copy of this same migration runs on it moments later — reintroducing the
 * exact silent-drop failure mode task #1406 fixed for compareFilesForDedupPriority,
 * just gated on a different trigger (adversarial ship-check finding).
 *
 * @param {object} data - parsed review-text JSON (mutated in place)
 * @returns {{aggregatorMigrated: boolean, garbageRecovered: boolean}} which
 *   migrations actually fired, so a caller that also writes back to disk
 *   (rebuild-all-reviews.js's main loop) knows whether to persist + count it.
 */
function applyScoreRelevantMigrations(data) {
  const result = { aggregatorMigrated: false, garbageRecovered: false };
  if (!data) return result;
  if (data.originalScore && data.scoreSource && AGGREGATOR_SOURCES_SET.has(data.scoreSource)) {
    if (!data.aggregatorStars) data.aggregatorStars = data.originalScore;
    data.originalScore = null;
    if (data.originalScoreNormalized != null) data.originalScoreNormalized = null;
    if (data.originalScoreSource && AGGREGATOR_SOURCES_SET.has(data.originalScoreSource)) data.originalScoreSource = null;
    result.aggregatorMigrated = true;
  }
  const isErrorPage = data.garbageReason &&
    (/^Error\/404/i.test(data.garbageReason) || /page not found/i.test(data.garbageReason));
  if (!data.fullText && data.garbageFullText && data.garbageFullText.length > 200 && !isErrorPage) {
    const cleaned = cleanText(data.garbageFullText);
    if (cleaned && cleaned.length > 200) {
      data.fullText = cleaned;
      data.fullTextRecoveredFrom = 'garbageFullText';
      result.garbageRecovered = true;
    }
  }
  return result;
}

/**
 * Comparator deciding which of two same-show review-text files wins when the
 * rebuild's dedup collapses them (same outlet+critic, same URL, or same
 * content fingerprint) — first-in-sort-order file survives, the other is
 * skipped as a duplicate.
 *
 * `hasScore` is checked BEFORE `isUnknown` so a scored review is never
 * dropped in favor of an unscored named sibling at the same URL: task #1406
 * (how-the-other-half-loves-west-end-2026, 2026-08-13) found the prior
 * unknown-first ordering let an unscored named file (e.g.
 * guardian--mark-lawson.json, no assignedScore) win the dedup pick over its
 * scored "Unknown" twin (guardian--unknown.json, assignedScore 87) sharing
 * the same URL — silently dropping the only scoreable copy of the review.
 * Scored-but-Unknown files now survive dedup, and rebuild-all-reviews.js's
 * existing byline-recovery pass (scripts/lib/byline-recovery.js, added for
 * task #190/#1321) backfills the display name from the losing named sibling
 * afterward — so neither the score nor the byline is sacrificed for the
 * other.
 *
 * Priority (lower sorts first / wins): non-duplicate > scored > named (not
 * Unknown/unnamed) > non-outlet-as-critic > content-verified > ensemble-
 * scored > alphabetical by filename.
 *
 * Pure — no I/O. All flags are pre-computed by the caller from the file's
 * parsed JSON (see rebuild-all-reviews.js's sortMeta build; `hasScore` there
 * comes from the same getBestScore() core logic that determines scoreability
 * downstream, not a looser proxy, so a file that sorts as "scored" here is
 * guaranteed to actually produce a score later).
 *
 * @param {{file:string, isDupe?:boolean, hasScore?:boolean, isUnknown?:boolean, isOutletAsCritic?:boolean, isVerified?:boolean, hasEnsemble?:boolean}} a
 * @param {object} b - same shape as `a`
 * @returns {number}
 */
function compareFilesForDedupPriority(a, b) {
  const rank = (v) => (v ? 1 : 0);
  if (rank(a.isDupe) !== rank(b.isDupe)) return rank(a.isDupe) - rank(b.isDupe);
  if (rank(a.hasScore) !== rank(b.hasScore)) return rank(b.hasScore) - rank(a.hasScore);
  if (rank(a.isUnknown) !== rank(b.isUnknown)) return rank(a.isUnknown) - rank(b.isUnknown);
  if (rank(a.isOutletAsCritic) !== rank(b.isOutletAsCritic)) return rank(a.isOutletAsCritic) - rank(b.isOutletAsCritic);
  if (rank(a.isVerified) !== rank(b.isVerified)) return rank(a.isVerified) - rank(b.isVerified);
  if (rank(a.hasEnsemble) !== rank(b.hasEnsemble)) return rank(a.hasEnsemble) - rank(b.hasEnsemble);
  return String(a.file).localeCompare(String(b.file));
}

/**
 * BRO-4612: legacy placeholder. assignedScore 50 with no ensemble provenance
 * (ensembleData), no score source, no original score, and no model reading that
 * itself equals 50. Edwin Drood AP and Illinoise TB published at 50 on this alone
 * while the model read 76/78. Real ensemble 50s keep llmScore.score === 50.
 */
function isPlaceholderAssignedScore(data) {
  if (!data || data.assignedScore !== 50) return false;
  if (data.ensembleData || data.scoreSource || data.originalScore) return false;
  if (data.llmScore && data.llmScore.score === 50) return false;
  return true;
}

module.exports = {
  isPlaceholderAssignedScore,
  isOnStarLadder,
  isUnambiguousRatingString,
  publishedRatingEvidence,
  isPublishedRatingEvidence,
  bothThumbsOpposeVerdict,
  aggregatorThumbCheck,
  ONE_STEP_THUMB_MARGIN,
  // Text cleaning
  normalizeThumb,
  normalizePublishDate,
  fixMojibake,
  fixMissingPeriods,
  // Excerpt quality
  isJunkExcerpt,
  isGenericQuote,
  trimToCompleteSentence,
  normalizeQuoteWrapping,
  cleanExcerpt,
  // Scoring
  isContentVerificationActive,
  aggregatorStarsCorroboratedByFullText,
  getBestScore,
  SCORE_SOURCE_LABELS,
  // URL date extraction
  extractDateFromUrl,
  // Dedup tiebreaking
  compareFilesForDedupPriority,
  applyScoreRelevantMigrations,
  // Re-export from score-extractors for convenience
  scoreToBucket,
  scoreToThumb,
};
