'use strict';
/**
 * phantom-text-star.js (BRO-5295): spot a stored star rating that the generic
 * text extractor invented from prose.
 *
 * Before the boundary fix in score-extractors.js, "(\d)\s*stars?" read the tail
 * of a number and the start of a word as a rating: "1992 starring Meryl Streep"
 * became 2/5, "(c) 2014 StarTribune" 4/5, "some 14 stars" 4/5. Those ratings
 * were stored (numeric-stars / text-pattern) and, on a rave, outranked the
 * review's own score (Her Campus, Death Becomes Her tour: served 40).
 *
 * A stored rating is a phantom candidate when (1) its source is one of the two
 * generic text sources, (2) the review text holds a loose "N star..." match in a
 * non-rating context (digit glued to a longer number, or "star" glued to a
 * following letter) that reads as exactly the stored rating, and (3) the current
 * extractor no longer reproduces that rating from the same text.
 *
 * Pure: the extractor is injected so the audit and the test use the real one.
 */

const GENERIC_TEXT_SOURCES = new Set(['numeric-stars', 'text-pattern']);

// Same shape the legacy extractor used: no boundaries at all.
const LOOSE_STAR = /(\d(?:\.\d)?)\s*stars?/gi;

/** "4/5", "4.5/5", "4 stars", "4/5 stars" -> "4/5" style key, or null. */
function ratingKey(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/^\s*(\d(?:\.\d)?)\s*(?:\/\s*5)?\s*(?:stars?)?\s*$/i);
  return m ? `${parseFloat(m[1])}/5` : null;
}

/** Ratings the loose pattern reads from non-rating prose in `text`. */
function phantomRatings(text) {
  const out = [];
  const t = String(text || '');
  for (const m of t.matchAll(LOOSE_STAR)) {
    const before = t.slice(Math.max(0, m.index - 12), m.index);
    const after = t.charAt(m.index + m[0].length);
    const glued = /\d$/.test(before) || /\d\.$/.test(before);          // 1992 starring / 14 stars
    // starring / StarTribune. "4 starsMegan" (m[0] ends in s) is scraped text glued at a tag
    // boundary, a real rating the extractor no longer reads: not a phantom.
    const word = /[A-Za-z]/.test(after) && !/s$/i.test(m[0]) && !/(?:out\s+of|\/)\s*$/i.test(before);
    if (!glued && !word) continue;
    const value = parseFloat(m[1]);
    if (value >= 1 && value <= 5) out.push(`${value}/5`);
  }
  return out;
}

/**
 * @param {object} data review-text record
 * @param {(html:string,text:string,outletId:string)=>({originalScore:string}|null)} extractScore
 * @returns {{stored:string, phantoms:string[]}|null}
 */
function findPhantomTextStar(data, extractScore) {
  // originalScoreCleared is deliberately NOT a skip: a star back on a cleared record is the Her Campus failure itself.
  if (!data) return null;
  if (!GENERIC_TEXT_SOURCES.has(data.originalScoreSource)) return null;
  const stored = ratingKey(data.originalScore);
  const text = data.fullText;
  if (!stored || typeof text !== 'string' || text.length < 100) return null;
  const phantoms = phantomRatings(text);
  if (!phantoms.includes(stored)) return null;
  const now = extractScore('', text, String(data.outletId || '').toLowerCase());
  if (ratingKey(now && now.originalScore) === stored) return null; // a real rating says the same thing
  return { stored, phantoms };
}

/**
 * A "human" score that is really a generic text star: humanReviewScore equals the
 * normalized value of a numeric-stars / text-pattern rating, with nothing a person
 * leaves behind (manualEntry, humanReviewNote) and not marked provisional. humanReviewScore
 * outranks every other score, so a machine-made one pins the review (Her Campus: 40 on a
 * rave, 2026-10-13; the writer was not identified in the CI log, so this catches the result).
 * Corpus on 2026-10-13: exactly 1 hit.
 */
function findMachinePinnedHumanScore(data) {
  if (!data || typeof data.humanReviewScore !== 'number') return null;
  if (!GENERIC_TEXT_SOURCES.has(data.originalScoreSource)) return null;
  if (data.manualEntry === true || data.humanReviewNote || data.humanReviewScoreProvisional === true) return null;
  if (data.humanReviewScore !== data.originalScoreNormalized) return null;
  return { humanReviewScore: data.humanReviewScore, source: data.originalScoreSource };
}

module.exports = { findPhantomTextStar, findMachinePinnedHumanScore, phantomRatings, ratingKey, GENERIC_TEXT_SOURCES };
