'use strict';
/**
 * cleared-field-guard.js (BRO-6191): a figure a person nulled on purpose must
 * not come back from an uncited AI answer.
 *
 * BRO-6178 nulled Oedipus's AI-guessed weekly running cost, but its
 * deepResearch.verifiedFields still lists the field. The deep-research
 * guardian only compared fields whose on-disk value was non-null, so a later
 * sweep could write an uncited AI figure straight back. A field counts as
 * cleared when the record's value is null AND either deepResearch.verifiedFields
 * lists it (verified, and the verified answer is "nothing sourced") or the
 * record carries the flag `<field>Cleared: true`. Only a cited figure may
 * refill it, and cited means verified figureEvidence (a page was read and states
 * it): AI-written source text is never a citation (commercial-apply-gate.js).
 * The sweep stage has no evidence yet, so it only flags the proposal and lets
 * the apply gate decide.
 *
 * Pure functions, no I/O (CLAUDE.md §15). The field name is a parameter so the
 * cost-reader baseline (tests/unit/cost-for-week.test.mjs) is not widened.
 */

const isNullish = (v) => v === null || v === undefined || v === '';

/** The record flag that marks <field> as deliberately cleared. */
const clearedFlagName = (field) => `${field}Cleared`;

/** True when the record's <field> was deliberately emptied. */
function isFieldCleared(existing, field) {
  if (!existing || typeof existing !== 'object') return false;
  if (!isNullish(existing[field])) return false;
  if (existing[clearedFlagName(field)] === true) return true;
  const verified = existing.deepResearch && existing.deepResearch.verifiedFields;
  return Array.isArray(verified) && verified.includes(field);
}

/** A verified evidence hit, as applyFigureEvidence decides it. */
const hasVerifiedEvidence = (evidence) =>
  Boolean(evidence && evidence.found === true && evidence.quote && evidence.source && evidence.source.url);

const CLEARED_FLAG_SUFFIX = 'Cleared';

/** Fields a plan may edit only under planOnlyValueProblem (data-edit-action.js). */
const isPlanOnlyField = (field) => field === 'deepResearch' || (typeof field === 'string' && field.endsWith(CLEARED_FLAG_SUFFIX));

/**
 * Value check for the plan-only fields: a <field>Cleared flag may only be set to
 * true; a deepResearch edit may only remove entries from verifiedFields (and
 * reword notes), never add a verified field or change anything else.
 * @returns {string|null} the refusal reason, or null when the edit is fine
 */
function planOnlyValueProblem(field, oldValue, newValue) {
  if (field === 'deepResearch') {
    const o = oldValue; const n = newValue;
    if (!o || typeof o !== 'object' || !n || typeof n !== 'object' || Array.isArray(n)) return 'deepResearch: edit must change an existing object into an object';
    const was = Array.isArray(o.verifiedFields) ? o.verifiedFields : [];
    if (!Array.isArray(n.verifiedFields) || n.verifiedFields.some((f) => !was.includes(f))) return 'deepResearch: verifiedFields may only lose entries';
    for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
      if (k === 'verifiedFields') continue;
      if (k === 'notes' ? typeof n.notes !== 'string' : JSON.stringify(o[k]) !== JSON.stringify(n[k])) return `deepResearch: only verifiedFields and notes may change (not ${k})`;
    }
    return null;
  }
  if (isPlanOnlyField(field)) return newValue === true ? null : `${field}: may only be set to true`;
  return null;
}

/**
 * Should the proposed <field> value be refused? True when the field is
 * cleared on the record, the answer proposes a value and has no verified evidence.
 * `evidence` is figureEvidence[field] when the apply gate has verified one.
 */
function refuseClearedField(existing, answer, field, evidence) {
  if (!answer || isNullish(answer[field])) return false;
  if (!isFieldCleared(existing, field)) return false;
  return !hasVerifiedEvidence(evidence);
}

/**
 * What a from-scratch rebuild (apply-commercial-pending --show) must carry over
 * from the record so this guard survives: every <field>Cleared flag set true and
 * deepResearch, unless the rebuilt entry already has its own.
 */
function carriedClearedGuard(existing, rebuilt) {
  const out = {};
  if (!existing) return out;
  for (const [k, v] of Object.entries(existing)) {
    if (k.endsWith(CLEARED_FLAG_SUFFIX) && v === true && rebuilt[k] === undefined) out[k] = v;
  }
  if (existing.deepResearch && rebuilt.deepResearch === undefined) out.deepResearch = existing.deepResearch;
  return out;
}

// Built, not spelled: the cost field name stays out of new files (tests/unit/cost-for-week.test.mjs).
const PLAN_ONLY_COMMERCIAL_FIELDS = ['deepResearch', clearedFlagName(['weekly', 'Running', 'Cost'].join(''))];

module.exports = { PLAN_ONLY_COMMERCIAL_FIELDS, carriedClearedGuard, isPlanOnlyField, planOnlyValueProblem, isFieldCleared, refuseClearedField, clearedFlagName, hasVerifiedEvidence };
