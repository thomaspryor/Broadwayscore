/**
 * Canonical "what can the feedback auto-fix pipeline read/write" allowlist.
 *
 * Previously hand-declared 4x independently (auto-fix-feedback-bug.js,
 * diagnose-feedback-bug.js, generate-remediation-plan.js,
 * execute-approved-fix.js), which let a field become editable-but-invisible
 * to diagnosis (diagnosis LLM hallucinates instead of seeing the real field)
 * or visible-but-unexecutable (a typo in one copy silently rejects a
 * generated plan at execution). See card #1482.
 */

// The FULL editable set: used to build the diagnosis snapshot (every field
// the pipeline can EVER touch must be visible to the diagnosis LLM, issue
// #582) and by the two human-approved-fix scripts (generate-remediation-plan.js
// proposes, execute-approved-fix.js applies only after Tom clicks Approve).
const FEEDBACK_EDITABLE_FIELDS = {
  'shows.json': [
    'venue', 'synopsis', 'runtime', 'intermissions', 'ageRecommendation',
    'type', 'isRevival', 'status', 'closingDate', 'openingDate',
    'previewsStartDate', 'creativeTeam',
  ],
  'commercial.json': [
    'designation', 'capitalization', 'weeklyRunningCost',
    'capitalizationSource', 'notes', 'recouped', 'recoupmentSource',
  ],
  'audience-buzz.json': ['title'],
  // Only auto-fix-feedback-bug.js's append-winner path handles this file —
  // generate-remediation-plan.js / execute-approved-fix.js have no
  // executeDataEdit() branch for it, so it's excluded from the field set
  // those two expose (see pickEditableFields below).
  'awards.json': ['winnerNames'],
};

// Deliberately narrower subset for auto-fix-feedback-bug.js — the ONLY
// consumer that writes without a human approval step (fixType=data +
// confidence=high triggers it straight from a Claude Sonnet call). Excludes
// show lifecycle fields (status/openingDate/closingDate/previewsStartDate/
// creativeTeam) and unverifiable financial claims (recouped, recoupmentSource
// — CLAUDE.md: "Never mark recouped: true without citation"). Those stay
// reachable only via the human-approved generate-remediation-plan.js ->
// execute-approved-fix.js path, which uses FEEDBACK_EDITABLE_FIELDS above.
const AUTO_FIX_EDITABLE_FIELDS = {
  'shows.json': [
    'venue', 'synopsis', 'runtime', 'intermissions', 'ageRecommendation',
    'type', 'isRevival',
  ],
  'commercial.json': [
    'designation', 'capitalization', 'weeklyRunningCost',
    'capitalizationSource', 'notes',
  ],
  'audience-buzz.json': ['title'],
  'awards.json': ['winnerNames'],
};

// Identity fields every show snapshot needs alongside the editable set —
// never themselves editable through this pipeline.
const SHOW_IDENTITY_FIELDS = ['id', 'title', 'slug'];

/**
 * Returns the subset of `sourceMap` (defaults to FEEDBACK_EDITABLE_FIELDS)
 * for the given files, in the same {file: [fields]} shape. Use this instead
 * of referencing a field map directly when a consumer doesn't implement
 * every file (e.g. execute-approved-fix.js has no awards.json write path) —
 * that keeps a script's "allowed" list matched to what it can actually
 * execute. Pass AUTO_FIX_EDITABLE_FIELDS as sourceMap for the unattended
 * auto-fix path.
 */
function pickEditableFields(files, sourceMap = FEEDBACK_EDITABLE_FIELDS) {
  const out = {};
  for (const file of files) {
    if (sourceMap[file]) out[file] = sourceMap[file];
  }
  return out;
}

/**
 * Builds the show snapshot the diagnosis/auto-fix LLMs see: identity fields
 * plus every field the pipeline is allowed to edit (the FULL set, not just
 * the auto-fix subset — diagnosis must be able to name a field even when
 * only the human-approved path can actually change it). A missing value is
 * normalized to null (or [] for creativeTeam) rather than left undefined, so
 * JSON.stringify() always emits the key — 55/2904 shows have no
 * `creativeTeam` key at all, and an absent key (vs. an explicit null) is
 * exactly the "editable-but-invisible-to-diagnosis" failure mode issue #582
 * exists to prevent.
 */
function buildShowSnapshot(show) {
  const snapshot = {};
  for (const field of SHOW_IDENTITY_FIELDS) {
    snapshot[field] = show[field] === undefined ? null : show[field];
  }
  for (const field of FEEDBACK_EDITABLE_FIELDS['shows.json']) {
    const value = show[field];
    if (value !== undefined) {
      snapshot[field] = value;
    } else {
      snapshot[field] = field === 'creativeTeam' ? [] : null;
    }
  }
  return snapshot;
}

module.exports = {
  FEEDBACK_EDITABLE_FIELDS,
  AUTO_FIX_EDITABLE_FIELDS,
  SHOW_IDENTITY_FIELDS,
  pickEditableFields,
  buildShowSnapshot,
};
