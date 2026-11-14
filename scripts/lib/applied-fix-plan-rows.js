'use strict';
/**
 * BRO-6872: did an APPLIED fix plan actually make its review includable?
 *
 * An approved fix plan (data/pending-fixes/*.json) that clears an exclusion flag
 * — wrongProduction, wrongShow, isRoundupArticle, wrongAttribution set back to
 * false/null — exists for one reason: the review belongs on the site. The plan
 * runner marks the plan `applied` when it writes the review-text file, and
 * nothing afterwards ever checks that the row reached data/reviews.json. Five
 * pipeline steps between the file and the row fail silently and independently
 * (verify-review-recovery.js), so a cleared flag can sit in a file for months
 * while the show page still misses the review and the plan reads "applied".
 *
 * This module holds the decision; scripts/audit-applied-fix-plans.js is the CLI
 * and tests/unit/applied-fix-plan-rows.test.mjs the coverage (CLAUDE.md rule 15:
 * tests require the real function, never a copy of the logic).
 *
 * The judgement is deliberately narrow, so a report is always real work. It
 * NEVER re-implements the rebuild's inclusion rules: review-guards.js
 * explainExclusion owns those ~70 reasons (duplicates, syndication, cross-market,
 * previews/upcoming shows, rejectionReason, unvalidated outlet domains ...) and
 * the caller injects it as `explain`. A hand-written copy of three of them was
 * the first draft's defect: it reported 37 rows, most of them legitimately
 * excluded (reviewer finding, BRO-6872).
 *
 * Skipped, never reported:
 *   - the review file is gone;
 *   - a `partial` plan's own results say this action did not apply;
 *   - the plan ran after the reviews.json rebuild that would have picked it up;
 *   - a later pass re-set an exclusion flag (the clear was overruled);
 *   - explain() names any current rebuild exclusion rule.
 * Reported: a review the rebuild would include that has no row (the BRO-6872
 * defect), and separately one with no score at all, which needs scoring rather
 * than a rebuild.
 */

const EXCLUSION_FIELDS = Object.freeze(['wrongProduction', 'wrongShow', 'isRoundupArticle', 'wrongAttribution']);
// plan-status.js DONE_STATUSES also holds rejected/validation-failed: those never wrote the file, so they cannot be
// judged on the row. Only a plan that claims to have applied an edit is held to it.
const APPLIED_STATUSES = Object.freeze(['applied', 'partial']);
// A plan applied this close to the rebuild may not have been scanned yet; the next run reports it.
const REBUILD_GRACE_MS = 60 * 60 * 1000;

/** Same shape lane-shadow-grade uses: strip scheme, www, query, trailing slash. */
function canonicalReviewUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

const isCleared = (v) => v === false || v === null;
const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };

/**
 * Every action in one plan that cleared an exclusion flag on a review file.
 *
 * `applied` is false when the plan's own results row for this action says it did not apply: a
 * `partial` plan records per-action {ok} in plan.results, positionally aligned with the actions
 * (e.g. "current value doesn't match expected"). Those edits never happened, so the row was never
 * expected (reviewer finding, BRO-6872).
 *
 * @param {object} plan a parsed data/pending-fixes/*.json
 * @param {string} [planFile] file name, for the report
 * @returns {Array<{planFile:string, planId:string|null, status:string, showId:string, file:string,
 *                  field:string, index:number, applied:boolean, executedAt:number|null}>}
 */
function clearingActions(plan, planFile = '') {
  if (!plan || !APPLIED_STATUSES.includes(plan.status)) return [];
  // The actions live at plan.plan.actions (the stored plan object), not plan.actions. Both are read so a
  // hand-written plan in the older flat shape is not silently skipped.
  const actions = (plan.plan && Array.isArray(plan.plan.actions) ? plan.plan.actions : null) || (Array.isArray(plan.actions) ? plan.actions : []);
  const results = Array.isArray(plan.results) ? plan.results : [];
  const executedAt = ms(plan.executedAt || plan.appliedAt);
  const out = [];
  actions.forEach((a, index) => {
    if (!a || a.type !== 'review-field-edit') return;
    if (!EXCLUSION_FIELDS.includes(a.field)) return;
    if (!isCleared(a.newValue)) return;
    const rel = String(a.file || '');
    const slash = rel.indexOf('/');
    if (slash <= 0 || slash === rel.length - 1) return;
    // Positional alignment is only trusted when the lengths match AND this slot's recorded action
    // type is the same one (results[i].action is a type string). A mismatch means the plan's
    // results were written for a different action list (reviewer finding, BRO-6872).
    const slot = results.length === actions.length ? results[index] : null;
    const res = slot && (slot.action == null || slot.action === a.type) ? slot : null;
    out.push({
      planFile: planFile || String(plan.planId || ''),
      planId: plan.planId || null,
      status: plan.status,
      showId: rel.slice(0, slash),
      file: rel,
      field: a.field,
      index,
      applied: !(res && res.ok === false),
      executedAt,
    });
  });
  return out;
}

/**
 * A row the rebuild cannot score is dropped for its score, not for the cleared flag.
 *
 * Mirrors the rebuild's own precedence (rebuild-all-reviews.js: humanReviewScore first, then the
 * stored score fields, then the ensemble's llmScore.score). Two reviewer findings, BRO-6872:
 * humanReviewScore was missing entirely (a human-scored file read as NO-SCORE), and any non-null
 * llmScore object counted, so `{ score: null }` read as scored and landed in the loud class.
 */
function hasScore(rec) {
  if (!rec) return false;
  for (const k of ['humanReviewScore', 'assignedScore', 'score', 'originalScore']) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return true;
  }
  const llm = rec.llmScore;
  if (llm && typeof llm === 'object' && Number.isFinite(Number(llm.score)) && llm.score !== null && llm.score !== '') return true;
  if (typeof llm === 'number' && Number.isFinite(llm)) return true;
  return false;
}

/**
 * Judge one cleared action against the current review file and reviews.json.
 *
 * @param {object} action from clearingActions
 * @param {object|null} textRecord the parsed data/review-texts/<file>, or null when it is gone
 * @param {object} ctx
 * @param {(action:object, rec:object) => (object|null)} ctx.findRow the reviews.json row, or null
 * @param {(action:object, rec:object) => (string|null)} ctx.explain review-guards explainExclusion,
 *        bound to this show (and the rebuild's own per-show exclusion list where it exists). A
 *        non-null rule means the rebuild drops the row for a reason that is not this plan's doing.
 * @param {number|null} [ctx.rebuiltAt] reviews.json _meta.lastUpdated, epoch ms
 * @returns {{ok:boolean, skipped:boolean, reason:string, url?:string}}
 *   skipped: nothing to answer for. ok:false: report it.
 */
function judgeClearedAction(action, textRecord, ctx) {
  const { findRow, explain, rebuiltAt = null } = ctx || {};
  if (!textRecord) return { ok: true, skipped: true, reason: 'review-file-gone' };
  if (action.applied === false) return { ok: true, skipped: true, reason: 'action-not-applied' };
  if (rebuiltAt != null && action.executedAt != null && action.executedAt > rebuiltAt - REBUILD_GRACE_MS) {
    return { ok: true, skipped: true, reason: 'applied-after-last-rebuild' };
  }
  // A later pass re-flagged it (the clear was reverted or overruled): not this plan's failure any more.
  for (const f of EXCLUSION_FIELDS) if (textRecord[f] === true) return { ok: true, skipped: true, reason: `re-flagged:${f}` };
  const rule = explain ? explain(action, textRecord) : null;
  // `unknown-*` means the caller could not answer the question (e.g. this run has no rebuild
  // exclusion list for the show, so a dedup/no-score drop is invisible). Never reported.
  if (rule) return { ok: true, skipped: true, reason: rule.startsWith('unknown-') ? rule : `excluded:${rule}` };
  const url = canonicalReviewUrl(textRecord.url);
  if (findRow(action, textRecord)) return { ok: true, skipped: false, reason: 'includable', url };
  // No row. Scoring and the rebuild are different repairs, so they are reported apart.
  if (!hasScore(textRecord)) return { ok: false, skipped: false, reason: 'no-score', url };
  return { ok: false, skipped: false, reason: 'includable-but-absent', url };
}

module.exports = {
  EXCLUSION_FIELDS,
  APPLIED_STATUSES,
  REBUILD_GRACE_MS,
  canonicalReviewUrl,
  hasScore,
  clearingActions,
  judgeClearedAction,
};
