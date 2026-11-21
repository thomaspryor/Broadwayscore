'use strict';
/**
 * Held-out review queue (BRO-7999 R3).
 *
 * R0 measured it: a fresh random sample of reviews held off the site by an
 * automated rule found real reviews under cvWrongArticleHighConfidence (3 of 6),
 * wrongShow (1 of 6) and the nonReview classifier (two false positives, "died
 * aged" obituary and "first look at" preview patterns). This module picks the
 * held-out files worth a person's read: held by one of those rules, no human
 * ever ruled on them, and the stored text looks like a finished review of this
 * show (content tier complete, names the show's cast, carries a score), on a
 * show that opened recently.
 *
 * Pure (CLAUDE.md §15): the CLI walks the corpus and passes records in. Rows
 * carry ids, file names, rule names and counts only. Never review text.
 */

const QUEUE_RULES = Object.freeze([
  'cvWrongArticleHighConfidence', 'wrongShow', 'wrongProduction', 'nonReview', 'rejectionReason',
]);
// wrongAttribution is left out on purpose: R4/R5 cover it.

// Fields a person sets when they rule on a flag.
const HUMAN_MARKERS = Object.freeze([
  'wrongProductionManualClear', 'wrongShowManualClear', 'wrongProductionOverride', 'allowCrossMarket', 'allowEarlyDate', 'nonReviewManualClear', 'wrongArticleManualClear', 'isNotReviewManualClear', 'heldOutFlagStands',
]);
// Reason fields where a leading "manual" records a human verdict.
const HUMAN_REASON_FIELDS = Object.freeze(['rejectionReasoning', 'isNonReviewReason', 'wrongProductionReason', 'wrongShowReason']);

function humanRuled(data) {
  if (!data || typeof data !== 'object') return false;
  if (HUMAN_MARKERS.some((f) => data[f] === true) || data.humanReviewedWrongArticle === false) return true;
  return HUMAN_REASON_FIELDS.some((f) => typeof data[f] === 'string' && /^\s*manual/i.test(data[f]));
}

function hasScore(data) {
  for (const k of ['humanReviewScore', 'assignedScore', 'score', 'originalScore']) {
    const v = data[k];
    if (v !== undefined && v !== null && v !== '') return true;
  }
  const llm = data.llmScore;
  if (llm && typeof llm === 'object' && llm.score !== null && llm.score !== '' && Number.isFinite(Number(llm.score))) return true;
  return typeof llm === 'number' && Number.isFinite(llm);
}

/** True when the show opened within `recentDays` before `today` (or opens later). */
function isRecentShow(show, today, recentDays) {
  const t = Date.parse(show && show.openingDate);
  if (!Number.isFinite(t)) return false;
  const ageDays = (today.getTime() - t) / 86400000;
  return ageDays <= recentDays;
}

/**
 * @param {object} data  review file JSON
 * @param {object} show  shows.json entry
 * @param {string} filePath  path handed to explainExclusion
 * @param {{today?:Date, recentDays?:number, minSignals?:number, explain?:Function, ownShowEvidence?:Function}} [opts]
 * @returns {null | {rule:string, signals:string[], signalCount:number}}
 */
function queueCandidate(data, show, filePath, opts = {}) {
  const { today = new Date(), recentDays = 45, minSignals = 3 } = opts;
  const explain = opts.explain || require('./review-guards').explainExclusion;
  const evidence = opts.ownShowEvidence || require('./own-show-text-evidence').ownShowTextEvidence;
  if (!data || !show || humanRuled(data)) return null;
  if (!isRecentShow(show, today, recentDays)) return null;
  const rule = explain(data, show, filePath);
  if (!rule || !QUEUE_RULES.includes(rule)) return null;
  const signals = [];
  if (data.contentTier === 'complete') signals.push('contentTierComplete');
  if (evidence(data.fullText, show).strong) signals.push('ownShowTextEvidence');
  if (hasScore(data)) signals.push('scorePresent');
  if (signals.length < minSignals) return null;
  return { rule, signals, signalCount: signals.length };
}

const RULE_ORDER = QUEUE_RULES.reduce((m, r, i) => { m[r] = i; return m; }, {});

/** Highest-yield rules first (R0 measured them), then by show and file for a stable order. */
function sortQueue(rows) {
  return rows.slice().sort((a, b) => (RULE_ORDER[a.rule] - RULE_ORDER[b.rule])
    || a.showId.localeCompare(b.showId) || a.file.localeCompare(b.file));
}

module.exports = { QUEUE_RULES, HUMAN_MARKERS, HUMAN_REASON_FIELDS, humanRuled, hasScore, isRecentShow, queueCandidate, sortQueue };
