/**
 * Star-rating reliability classification.
 *
 * Mirrors the LOW_RELIABILITY_EXTRACTION set in scripts/lib/rebuild-helpers.js
 * so write-time anchored-band scoring (Sprint 3, scripts/llm-scoring/ensemble-scorer.ts)
 * uses the same reliability gate as read-time score precedence (rebuild-helpers).
 *
 * **Mirror, not source of truth (yet).** When Sprint 5 cleanup runs, the
 * rebuild-helpers local set should be replaced with `require(this file)` so
 * there's a single definition. Until then, keep both in sync manually — a
 * grep test in the unit suite would catch drift.
 */

'use strict';

const { OUTLET_STAR_AUTHORITATIVE } = require('./score-extractors');

// Star-extraction sources that produce false positives often enough to gate
// against (CSS class names with no schema, ad-hoc text patterns, etc.).
// Reviews extracted via these methods enter Sprint 3's UNANCHORED LLM path —
// the LLM scores prose without a band constraint.
const LOW_RELIABILITY_EXTRACTION = new Set([
  'css-stars', 'star-class', 'css-rating', 'star-rating',
  'text-pattern', 'og-description', 'wp-api-title',
  'numeric-stars', // generic "X/5" pattern — false positives from pagination, dates, URLs
]);

/**
 * @param {object} data - review-text JSON contents (must include scoreSource + outletId)
 * @returns {boolean} true if the originalScore was extracted via a trusted source.
 */
function isHighReliabilityStar(data) {
  if (!data) return false;
  // Outlet on the authoritative list bypasses the low-reliability gate —
  // these outlets have dedicated extractors with verified extraction patterns.
  // NOTE (BRO-4499): this bypass also covers generic text-pattern stars on
  // authoritative outlets. Tightening it flips ~280 files, many of them genuine
  // Time Out ratings, so the junk-star defence lives at READ time instead
  // (isUncorroboratedGenericStar, which needs the LLM score to corroborate).
  if (OUTLET_STAR_AUTHORITATIVE.has(data.outletId)) return true;
  // Otherwise the source string must not be in the low-rel set.
  return !LOW_RELIABILITY_EXTRACTION.has(data.scoreSource);
}

// Free-text regex star labels: no DOM/schema anchor, so pagination, dates and
// gallery counters ("1/5") match as ratings. Subset of LOW_RELIABILITY_EXTRACTION.
const GENERIC_PATTERN_STAR_SOURCES = new Set(['numeric-stars', 'text-pattern']);

/**
 * True when the star on this record came from a generic free-text pattern.
 * Checks originalScoreSource as well as scoreSource: a later sentiment pass can
 * overwrite scoreSource ('sentiment-strong-positive') while the star it left
 * behind is still the junk match (the Operation Mincemeat record).
 */
function isGenericPatternStar(data) {
  if (!data) return false;
  return GENERIC_PATTERN_STAR_SOURCES.has(data.originalScoreSource)
    || GENERIC_PATTERN_STAR_SOURCES.has(data.scoreSource);
}

/**
 * A generic-pattern star that the ensemble LLM contradicts across a bucket
 * boundary by more than 25 points is not corroborated by anything: ignore it
 * rather than let it outrank the model read. Same thresholds as the
 * originalScore-llm-conflict check in rebuild-helpers.js getBestScore().
 *
 * Live failure (BRO-4499, reader report 2026-10-01): Chicago Tribune / Chris
 * Jones on Operation Mincemeat, a rave ("a lot of fun and very clever to
 * boot", 2 of 3 models Positive), shipped as 40 (then 20) off a numeric-stars
 * "1/5" that nothing else supported.
 *
 * @param {object} data - review-text record
 * @param {number} starScore - the star normalized to 0-100
 * @returns {boolean}
 */
function isUncorroboratedGenericStar(data, starScore) {
  if (!isGenericPatternStar(data) || !Number.isFinite(starScore)) return false;
  const llm = data.llmScore && data.llmScore.score;
  const conf = data.llmScore && data.llmScore.confidence;
  if (!llm || conf === 'low' || Math.abs(starScore - llm) <= 25) return false;
  const bucket = (x) => (x >= 70 ? 'positive' : x <= 40 ? 'negative' : 'mixed');
  return bucket(starScore) !== bucket(llm);
}

// How far a star-sided adjudication may sit from the record's own trusted star
// before its stated basis is considered false. A star step is 20 points and a
// star band ~10 wide, so 12 tolerates in-band placement only.
const STAR_SIDED_TOLERANCE = 12;

/**
 * True when an adjudication says it sided with the star but the record's own
 * trusted star says something else (BRO-4499 cousins: a-dolls-house-part-2
 * Theater Life, record 4/5 = 80, adjudicated 40 on an invented "2/5").
 * Only trusted stars count (a low-reliability or generic-pattern star is the
 * other guard's job), and the adjudicated score must sit in a different bucket.
 */
function adjudicationContradictsRecordStar(data) {
  if (!adjudicationSidedWithStars(data)) return false;
  const star = data.originalScoreNormalized;
  const adj = data.adjudicatedScore;
  if (typeof star !== 'number' || typeof adj !== 'number' || !(star > 0)) return false;
  const src = data.originalScoreSource || data.scoreSource;
  if (src && LOW_RELIABILITY_EXTRACTION.has(src)) return false;
  if (Math.abs(adj - star) <= STAR_SIDED_TOLERANCE) return false;
  const bucket = (x) => (x >= 70 ? 'positive' : x <= 40 ? 'negative' : 'mixed');
  return bucket(adj) !== bucket(star);
}

/**
 * True when an adjudication says it sided with the star but the record holds no
 * star at all now: no originalScore / normalized value / aggregatorStars /
 * starRating / originalRating / previousOriginalScore. The star it relied on was
 * invented by the adjudicator (BRO-4287 "invented a 2/5 stars") or was cleared
 * later as a false extraction, so the verdict has no basis left. Live:
 * take-me-out-2022 Theater Life, adjudicated 40 "sided with originalScore" with
 * every model at 82-87 and no rating anywhere on the record.
 */
function adjudicationStarBasisGone(data) {
  if (!adjudicationSidedWithStars(data)) return false;
  const has = (v) => v !== null && v !== undefined && v !== '' && v !== 0;
  // Older clearing runs nulled originalScore but left originalScoreNormalized behind.
  const cleared = data.originalScoreCleared === true;
  return !(has(data.originalScore) || (has(data.originalScoreNormalized) && !cleared) || has(data.aggregatorStars)
    || has(data.starRating) || has(data.originalRating)
    // previousOriginalScore is the audit copy a clearing script leaves behind
    // (fix-p0-score-corruption.js); on a record flagged originalScoreCleared the
    // star was judged false, so it is no basis (BRO-4596).
    || (has(data.previousOriginalScore) && data.originalScoreCleared !== true));
}

/**
 * True when an auto-adjudication says it sided with the star rating. Reads the
 * structured sidedWith on the last adjudicationHistory entry first, and falls
 * back to the note wording ('sided with originalScore' / 'sided with stars').
 */
function adjudicationSidedWithStars(data) {
  if (!data) return false;
  const hist = Array.isArray(data.adjudicationHistory) ? data.adjudicationHistory : [];
  const last = hist.length ? hist[hist.length - 1] : null;
  if (last && typeof last.sidedWith === 'string') {
    return /^(originalScore|stars?|aggregatorStars|original rating|rating|aggregator)$/i.test(last.sidedWith.trim());
  }
  return /^Auto-adjudicated \([^)]*sided with (originalScore|stars?|aggregatorStars|original rating|rating|aggregator)\)/i
    .test(data.adjudicationNote || '');
}

/**
 * Upstream half of the adjudication-basis guard (BRO-4596). The read-time
 * guards above ignore a star-sided adjudication whose star is gone, but a star
 * cleared by a script leaves previousOriginalScore behind, which the basis
 * check counts as a star, so the dependent adjudicatedScore kept publishing.
 * Scripts that DISCARD a record's star call this right after (relocations to aggregatorStars do not: that star can still be the basis).
 *
 * Drops adjudicatedScore only when the adjudication sided with the star (one
 * that sided with the models stays valid), keeps the dropped value in
 * adjudicatedScoreInvalidated for audit, and adds a history entry.
 * Mutates `data`; returns true when something was dropped.
 *
 * @param {object} data - review-text record, star already cleared by the caller
 * @param {string} reason - why the star was cleared (stored for audit)
 * @returns {boolean}
 */
function invalidateStarSidedAdjudication(data, reason) {
  if (!data || typeof data.adjudicatedScore !== 'number') return false;
  if (!adjudicationSidedWithStars(data)) return false;
  const at = new Date().toISOString();
  data.adjudicatedScoreInvalidated = {
    score: data.adjudicatedScore,
    reason: reason || 'star cleared',
    note: data.adjudicationNote || null,
    at,
  };
  data.adjudicatedScore = null;
  data.adjudicationNote = null;
  data.adjudicationHistory = [
    ...(Array.isArray(data.adjudicationHistory) ? data.adjudicationHistory : []),
    { timestamp: at, invalidated: true, reason: data.adjudicatedScoreInvalidated.reason },
  ];
  return true;
}

/**
 * Detect a star or letter-grade band from a review-text file.
 *
 * Returns:
 *   { band: ScoreBand-shape, starsRaw: string, kind: 'star'|'letter-grade', highReliability: boolean }
 * or null when no band could be extracted (no star/grade in any field).
 *
 * Caller decides whether to USE the band based on highReliability + their
 * own policy. Sprint 3 policy: high-rel → anchored (V6 with band);
 * low-rel → unanchored (V6 prompt, no band).
 *
 * @param {object} data - review-text JSON contents
 */
// How far the prose may move a printed percentage rating (80% -> 75-85).
const PERCENT_BAND_HALF_WIDTH = 5;

const LETTER_GRADE_BANDS = {
  'A+': [95, 100], 'A':  [89, 94], 'A-': [83, 88],
  'B+': [77, 82],  'B':  [71, 76], 'B-': [65, 70],
  'C+': [59, 64],  'C':  [53, 58], 'C-': [47, 52],
  'D+': [41, 46],  'D':  [35, 40], 'D-': [29, 34],
  'F':  [0,  28],
};

function detectBandFromReviewFile(data) {
  if (!data) return null;

  // Try star/grade fields in priority order. starRating + originalRating are
  // primary-source extractions; aggregatorStars is relayed (lower trust).
  // Some outlets (NY Post /4, EW letter grades) store the raw rating in
  // originalScore as a STRING (e.g. "1/4 stars", "C-") rather than as a
  // numeric 0-100. detectBandFromReviewFile needs to check that string form
  // as a fallback — otherwise high-rel ratings get silently skipped and the
  // anchored-mode path won't fire on real pilot data.
  const candidates = [
    { value: data.starRating, source: 'starRating' },
    { value: data.originalRating, source: 'originalRating' },
    // originalScore as a STRING is the raw rating ("3/5 stars", "C-", "80%").
    // As a NUMBER it is that rating already converted to 0-100 (older
    // extractors stored Guardian/Stage/WhatsOnStage/Time Out stars this way);
    // it is still the outlet's rating, and getBestScore serves it, so it
    // needs a band too (BRO-4838: 103 such reviews were served flat).
    // Checked BEFORE aggregatorStars: this is the outlet's own extraction
    // (dedicated extractor, json-ld, unicode-stars, …) — aggregatorStars is
    // a third-party relay (BRO-866: NYSR "Data" review had originalScore
    // "5/5 stars" from unicode-stars but aggregatorStars "4/5 stars" from
    // Show Score, and the old order let the relay win the anchoring band).
    { value: typeof data.originalScore === 'string' ? data.originalScore
      : (typeof data.originalScore === 'number' && Number.isFinite(data.originalScore) ? String(data.originalScore) : null),
      source: 'originalScore' },
    { value: data.aggregatorStars, source: 'aggregatorStars' },
  ];

  for (const { value, source } of candidates) {
    if (value === null || value === undefined || value === '') continue;
    const raw = String(value);

    // Numeric star pattern: "4/5", "3.5/4", "4 out of 5"
    const num = raw.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)/i);
    // A rating already on the 0-100 scale: "80%" (The Reviews Hub prints its
    // rating as a percentage) or, in originalScore only, a bare "60" left by
    // older normalizers. Without this none of them got a band, so 246 reviews
    // were never scored within their rating's band and the site served the
    // flat rating instead (BRO-4838: Affluenza, The Reviews Hub "80%").
    // A bare one-digit value is skipped: "4" may mean 4 of 5.
    // Only when getBestScore's own published-rating test accepts the value: a
    // bare number can also be a relayed Show-Score value or a stray normalized
    // field (an NYT review carries originalScore 82; the Times prints no
    // rating), and those must not pin a band.
    let pct = num ? null
      : (raw.match(/^\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/)
        || (source === 'originalScore' ? raw.match(/^\s*(\d{2,3}(?:\.\d+)?)\s*$/) : null));
    if (pct && source === 'originalScore') {
      // Lazy: rebuild-helpers requires this module at load time.
      const { publishedRatingEvidence } = require('./rebuild-helpers');
      if (!publishedRatingEvidence(data.originalScore, data)) pct = null;
    }
    // A letter grade an older extractor stored as its 0-100 value (EW "A" as
    // 90) keeps the grade's own band, not a star band (90 would be 91-100).
    if (pct && source === 'originalScore'
      && (data.scoreSource === 'letter-grade' || data.originalScoreSource === 'letter-grade')) {
      const v = parseFloat(pct[1]);
      const grade = Object.keys(LETTER_GRADE_BANDS).find(g => v >= LETTER_GRADE_BANDS[g][0] && v <= LETTER_GRADE_BANDS[g][1]);
      if (grade) {
        const [floor, ceiling] = LETTER_GRADE_BANDS[grade];
        return { band: { fraction: -1, floor, ceiling }, starsRaw: raw, kind: 'letter-grade', highReliability: isHighReliabilityStar(data) };
      }
      pct = null;
    }
    if (num || pct) {
      const stars = parseFloat(num ? num[1] : pct[1]);
      const max = num ? parseFloat(num[2]) : 100;
      if (Number.isFinite(stars) && Number.isFinite(max) && stars >= 0 && max > 0 && stars <= max) {
        const fraction = stars / max;
        let band;
        // A printed percentage is already a score: honor it, letting the prose
        // move it at most PERCENT_BAND_HALF_WIDTH either way (owner decision
        // 2026-10-07). A star-sized band would throw that precision away (an
        // 80% could land anywhere in 71-90; a 70% could not land at 70).
        if (pct && /%/.test(raw)) band = { floor: Math.max(0, Math.round(stars) - PERCENT_BAND_HALF_WIDTH), ceiling: Math.min(100, Math.round(stars) + PERCENT_BAND_HALF_WIDTH) };
        else if (fraction >= 0.9) band = { floor: 91, ceiling: 100 };
        else if (fraction >= 0.7) band = { floor: 71, ceiling: 90 };
        else if (fraction >= 0.5) band = { floor: 51, ceiling: 70 };
        else if (fraction >= 0.3) band = { floor: 31, ceiling: 50 };
        else band = { floor: 0, ceiling: 30 };
        return {
          band: { fraction, floor: band.floor, ceiling: band.ceiling },
          starsRaw: raw,
          kind: 'star',
          // BRO-4499: a generic-pattern star the existing LLM read contradicts
          // must not pin a rescore to its band (Mincemeat's junk "1/5" -> 0-30).
          highReliability: isHighReliabilityStar(data)
            && !isUncorroboratedGenericStar(data, fraction * 100),
        };
      }
    }

    // Letter grade: longest-alternation first (`A-` doesn't truncate to `A`).
    const lg = raw.match(/(A\+|A-|B\+|B-|C\+|C-|D\+|D-|A|B|C|D|F)(?:\b|$)/);
    if (lg) {
      const grade = lg[1].toUpperCase();
      const range = LETTER_GRADE_BANDS[grade];
      if (range) {
        // fraction:-1 is a sentinel meaning "letter grade, no percentage available".
        // buildAnchoredBandBlock in config.ts handles this by omitting the percentage clause.
        return {
          band: { fraction: -1, floor: range[0], ceiling: range[1] },
          starsRaw: raw,
          kind: 'letter-grade',
          highReliability: isHighReliabilityStar(data),
        };
      }
    }
  }

  return null;
}

/**
 * Decide whether a review should be scored via the V6 anchored-bands path.
 *
 * Rollout policy (Phase B):
 *   - Markets in ANCHORED_MARKETS (src/config/scoring.ts) → always anchored.
 *     2026-05-17: West End + Off-West-End.
 *     2026-07-20: Broadway + Off-Broadway added (NYC rollout).
 *   - All other markets → anchored only when ANCHORED_BANDS_PILOT=1 env flag.
 *
 * Deny-list safety (per memory/feedback_shows_json_category_at_schedule.md):
 *   - category === null / undefined / '' → REFUSED even with envFlag, because
 *     shows.json drift around schedule-time has left categories null in the
 *     past and we don't want a new show with null category to silently pick
 *     up anchored scoring.
 *
 * @param {{category: string|null|undefined, envFlag: boolean}} opts
 * @returns {boolean} true → use anchored V6 path
 */
// Module-level (not function-local) so tests/unit/anchored-markets-consistency.test.mjs
// can assert this mirror stays in sync with src/config/scoring.ts's
// ANCHORED_MARKETS instead of drifting silently (the same drift class
// tier-config-consistency.test.ts already guards for TIER_WEIGHTS).
// This module has zero TS-side imports by design — src/config/scoring.ts
// ANCHORED_MARKETS is the human-edited source of truth; we mirror it here.
// 2026-07-20: broadway + off-broadway added (NYC rollout).
const ANCHORED_MARKETS = new Set(['west-end', 'off-west-end', 'broadway', 'off-broadway']);

function shouldUseAnchoredMode({ category, envFlag }) {
  // Deny-list: missing category never auto-anchors, regardless of envFlag.
  if (category === null || category === undefined || category === '') {
    return false;
  }

  if (ANCHORED_MARKETS.has(category)) {
    return true;
  }

  // Outside ANCHORED_MARKETS, fall through to env flag.
  return envFlag === true;
}

module.exports = {
  LOW_RELIABILITY_EXTRACTION,
  ANCHORED_MARKETS,
  GENERIC_PATTERN_STAR_SOURCES,
  isHighReliabilityStar,
  isGenericPatternStar,
  isUncorroboratedGenericStar,
  adjudicationSidedWithStars,
  adjudicationContradictsRecordStar,
  adjudicationStarBasisGone,
  invalidateStarSidedAdjudication,
  detectBandFromReviewFile,
  shouldUseAnchoredMode,
};
