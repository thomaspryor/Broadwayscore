'use strict';

/**
 * multi-verdict-sections (BRO-4490): one article, several reviews, one star
 * verdict per review.
 *
 * The FT's theatre column often reviews two or three shows in one piece. Each
 * review ends with its own star line ("... kindness. ★★★★★ To January 21,
 * barbican.org.uk"), and the stored fullText carries all of them. Neither the
 * deterministic extractor (first/last star group) nor the LLM extractor knows
 * which run is this show's: my-neighbour-totoro FT stored 3/5 although its
 * own section ends ★★★★★, and the review was anchored to the wrong band.
 *
 * Deterministic and conservative, like venue-box-sections.ts (BRO-5294): split
 * the text at each section-ending 5-glyph star run, count this show's title in
 * each section, and pick the one section that names it most. No mention, or a
 * tie, is 'ambiguous' and callers must not guess a star.
 *
 * Scope: MULTI_VERDICT_OUTLETS only. Other outlets' extra star runs are mostly
 * page chrome (related-review teasers), which the score extractor already
 * handles (isForeignStarGroup), not a review structure.
 */

const { normSectionText, sectionTitleVariants } = require('./multi-show-section-extract');

const MULTI_VERDICT_OUTLETS = new Set(['financialtimes']);

// A verdict run: exactly five star glyphs, after the end of a sentence.
const VERDICT_RUN_RE = /[★☆]{5}(?![★☆])/g;
const SENTENCE_END_BEFORE_RE = /[.!?…”"’)]\s*$/;

/** Section-ending verdict runs: [{ index, end, filled }]. */
function findVerdictRuns(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  VERDICT_RUN_RE.lastIndex = 0;
  let m;
  while ((m = VERDICT_RUN_RE.exec(text)) !== null) {
    if (m.index > 0 && !SENTENCE_END_BEFORE_RE.test(text.slice(Math.max(0, m.index - 4), m.index))) continue;
    out.push({ index: m.index, end: m.index + m[0].length, filled: (m[0].match(/★/g) || []).length });
  }
  return out;
}

/**
 * Split a multi-review article into its reviews, or null when the text has
 * fewer than two section-ending verdict runs (a single review).
 * Text after the last run (the shared booking trailer) belongs to no section.
 * @returns {Array<{ start: number, end: number, text: string, filled: number }> | null}
 */
function splitVerdictSections(text) {
  const runs = findVerdictRuns(text);
  if (runs.length < 2) return null;
  let start = 0;
  return runs.map((r) => {
    const s = { start, end: r.index, text: text.slice(start, r.index), filled: r.filled };
    start = r.end;
    return s;
  });
}

function countMentions(hay, variant) {
  if (!variant) return 0;
  const re = new RegExp(`(?<![a-z0-9])${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'g');
  return (hay.match(re) || []).length;
}

/**
 * This show's verdict in a multi-review article.
 * @param {string} text  the article's fullText
 * @param {string} showTitle
 * @returns {{ status: 'single' } |
 *   { status: 'ambiguous', sections: number, mentions: number[] } |
 *   { status: 'matched', sections: number, index: number, filled: number,
 *     originalScore: string, mentions: number[] }}
 */
function pickShowVerdict(text, showTitle) {
  const sections = splitVerdictSections(text);
  if (!sections) return { status: 'single' };
  const variants = showTitle ? sectionTitleVariants(showTitle) : [];
  const mentions = sections.map((s) => {
    const hay = normSectionText(s.text);
    return variants.reduce((n, v) => Math.max(n, countMentions(hay, v)), 0);
  });
  const max = Math.max(...mentions);
  const winners = mentions.filter((n) => n === max).length;
  if (max === 0 || winners !== 1) return { status: 'ambiguous', sections: sections.length, mentions };
  const index = mentions.indexOf(max);
  const filled = sections[index].filled;
  return {
    status: 'matched', sections: sections.length, index, filled, mentions,
    originalScore: `${filled}/5 stars`,
  };
}

/**
 * The score both star extractors (score-extractors extractScore and
 * llm-score-extractor extractExplicitScore) take for a multi-review column, so
 * neither reads a page-level rating or another show's run (BRO-4490).
 * @returns {undefined|null|{originalScore: string, normalizedScore: number, source: string, raw: string}}
 *   undefined: not a multi-review article here, extract as usual.
 *   null: multi-review and this show's section can't be told apart; extract nothing.
 */
function multiVerdictScore(text, outletId, showTitle) {
  if (!text || !isMultiVerdictOutlet(outletId)) return undefined;
  const verdict = pickShowVerdict(text, showTitle);
  if (verdict.status === 'single') return undefined;
  if (verdict.status === 'ambiguous') return null;
  return {
    originalScore: verdict.originalScore,
    normalizedScore: Math.round((verdict.filled / 5) * 100),
    source: 'unicode-stars',
    raw: verdict.originalScore,
  };
}

/** True when this outlet publishes multi-review columns this module splits. */
function isMultiVerdictOutlet(outletId) {
  return MULTI_VERDICT_OUTLETS.has(String(outletId || '').toLowerCase());
}

/**
 * Audit decision for one stored review (audit-multi-verdict-stars.js).
 *  'single'     not a multi-review article (or not a multi-verdict outlet)
 *  'ok'         the stored star is this show's section star
 *  'mismatch'   the stored star is another section's: `want` is the right one
 *  'ambiguous'  multi-review, section unknown: the stored star is unverifiable
 *  'verified'   a human already checked the stored rating (manual-verified)
 * @returns {{ kind: string, want?: string, stored?: string|null, verdict?: object }}
 */
function multiVerdictStarStatus(data, showTitle) {
  if (!data || !isMultiVerdictOutlet(data.outletId) || !data.fullText) return { kind: 'single' };
  const verdict = pickShowVerdict(data.fullText, showTitle || data.showTitle);
  if (verdict.status === 'single') return { kind: 'single' };
  const stored = data.originalScore == null || data.originalScore === '' ? null : String(data.originalScore);
  if (data.originalScoreSource === 'manual-verified') return { kind: 'verified', stored, verdict };
  if (verdict.status === 'ambiguous') return { kind: 'ambiguous', stored, verdict };
  const { parseOriginalScore } = require('./score-parsers');
  const storedFlat = stored ? parseOriginalScore(stored, data.outletId) : null;
  if (storedFlat === parseOriginalScore(verdict.originalScore, data.outletId)) return { kind: 'ok', stored, verdict };
  return { kind: 'mismatch', stored, want: verdict.originalScore, verdict };
}

module.exports = { MULTI_VERDICT_OUTLETS, findVerdictRuns, splitVerdictSections, pickShowVerdict, isMultiVerdictOutlet, multiVerdictStarStatus, multiVerdictScore };
