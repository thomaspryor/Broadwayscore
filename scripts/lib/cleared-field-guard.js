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
 * refill it: a source string beside the figure, or a verified figureEvidence
 * hit (the apply gate's own definition of cited).
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

/** A non-empty source string beside the figure (<field>Source). */
const hasSourceText = (answer, field) => {
  const s = answer && answer[`${field}Source`];
  return typeof s === 'string' && s.trim().length > 0;
};

/**
 * Should the proposed <field> value be refused? True when the field is
 * cleared on the record, the answer proposes a value and offers no citation.
 * `evidence` is figureEvidence[field] when the apply gate has verified one.
 */
function refuseClearedField(existing, answer, field, evidence) {
  if (!answer || isNullish(answer[field])) return false;
  if (!isFieldCleared(existing, field)) return false;
  return !(hasVerifiedEvidence(evidence) || hasSourceText(answer, field));
}

module.exports = { isFieldCleared, refuseClearedField, clearedFlagName, hasVerifiedEvidence };
