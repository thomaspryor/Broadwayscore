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
    // BRO-5080: a date repair re-stamps where the date came from, so an
    // unconfirmed source can still be corrected by the daily date pass.
    'openingDateSource',
    // Whole images object, compare-and-set; human-approved plans only (BRO-4380:
    // clearing another show's art). execute-approved-fix refuses cross-show paths.
    'images',
    // Whole cast array, compare-and-set; human-approved plans only (BRO-4432:
    // a wrong-show IBDB match put The Century Girl's 1916 cast on a 2026 Globe
    // As You Like It). execute-approved-fix checks the {name, role} shape.
    'cast',
    // Whole array, compare-and-set; human-approved plans only (BRO-4996: a
    // wrong-production poster is nulled and its source rejected so no fetch
    // takes it again). Add-only: rejectedUrlsValueProblem refuses a plan that
    // drops a URL, so a wrongly added one is removed by a direct data commit.
    'rejectedImageUrls',
    // BRO-5022: {at, reason, key} or null. Marks a row whose art search found
    // nothing reliable, so the --missing sweep and the imageless self-heal
    // stop refilling it with the next wrong hit. execute-approved-fix checks
    // the shape and the key (lib/no-reliable-art.js).
    'noReliableArt',
    // BRO-5000: whole array, compare-and-set; human-approved plans only. The only
    // change a plan may make is a boolean inheritReviews on an existing entry (carry
    // or stop carrying that earlier run's reviews, lib/prior-run-sibling.js).
    // priorRunsValueProblem refuses any other difference: priorRuns windows are
    // scoring inputs and are not re-dated through a plan.
    'priorRuns',
    // BRO-5343: an https URL or null, human-approved plans only. A SERP
    // title match attached another production's site to two London rows;
    // officialUrlValueProblem refuses ticket/review/aggregator domains.
    'officialUrl',
    // BRO-4768: ISO date or null. First performance of an EARLIER run of the
    // same production when this row covers only a return engagement, so the
    // video-review date rule (lib/video-production-context.js) keeps reviews of
    // that run. firstRunStartValueProblem checks it.
    'firstRunStart',
  ],
  // recoupedDate/recoupedSource/sources: a recoupment correction needs all
  // three (validate-data.js requires recoupedDate when recouped=true). The
  // field was listed as "recoupmentSource", a name commercial.json has never
  // used, so a sourced recoupment fix was impossible (BRO-4623).
  // humanReviewedDesignation locks a hand-checked designation against
  // apply-commercial-pending.js's LLM auto-apply. nonprofitOrg pairs with a
  // Nonprofit designation (validate-data.js checks it against the venue).
  // isEstimate (whole object, compare-and-set; commercial-record-checks.js
  // checks the shape) marks a figure or recoupment as ours, not reported:
  // isEstimate.recouped prints "Not publicly announced" (BRO-4623).
  // weeklyRunningCostSource: /biz shows an uncited weekly cost as an estimate,
  // so citing a reported cost needs this field (BRO-4666). costMethodology
  // goes with it: a cost is printed as reported only under a reported
  // methodology (isCitedReportedWeeklyCost), and it also stops the Reddit
  // gap-fill replacing a cited figure (BRO-4985). Values are checked by
  // commercial-record-checks.js. needsLossEvidence is the stale-closure
  // classifier's "no cited loss source yet" flag (BRO-5020); a plan clears it
  // when a person sources or rules on the loss. designationBasis says what a
  // Fizzle/Flop rests on (owner policy B, BRO-5020; values in
  // commercial-designations.js, checked by commercial-record-checks.js).
  // estimatedRecoupmentPct/Source/Date: a reported "% returned" figure (the
  // backtest's reported-pct truth) with its citation and date (BRO-5073);
  // shape and range checked by commercial-record-checks.js.
  // weeklyRunningCostBasis: what the cited weekly cost figure is (running /
  // breakeven / all-in, BRO-5093; read by the costBasis shadow in
  // cost-split.js, values checked by commercial-record-checks.js).
  // commercialConversion: a nonprofit run's switch to a commercial run, whole
  // object { date, sourceUrl } (BRO-5508; commercial-conversion.js, checked by
  // commercial-record-checks.js together with the designation it requires).
  'commercial.json': [
    'designation', 'capitalization', 'weeklyRunningCost',
    'capitalizationSource', 'notes', 'recouped', 'recoupedDate',
    'recoupedSource', 'sources', 'humanReviewedDesignation', 'nonprofitOrg',
    'isEstimate', 'weeklyRunningCostSource', 'costMethodology',
    'needsLossEvidence', 'designationBasis',
    'estimatedRecoupmentPct', 'estimatedRecoupmentSource', 'estimatedRecoupmentDate',
    'weeklyRunningCostBasis', 'commercialConversion',
    // A cited cost supersedes the free-text estimate beside it (same linked
    // group in merge-commercial-data.js, BRO-5515).
    'weeklyRunningCostNote',
    // A nonprofit run with commercial co-producers is an 'enhancement' and
    // counts on /biz like a commercial one (hasNoInvestorsToRepay); research
    // that finds the credit must be able to record it (BRO-5520). Values and
    // the Tour Stop pairing are checked by commercial-record-checks.js.
    'productionType',
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
// creativeTeam) and unverifiable financial claims (recouped, recoupedSource
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
      snapshot[field] = (field === 'creativeTeam' || field === 'cast' || field === 'rejectedImageUrls' || field === 'priorRuns') ? [] : null;
    }
  }
  return snapshot;
}

// shows.json cast value check for the human-approved data-edit path
// (BRO-4432): an array of {name, role?} with non-empty string names. [] clears
// a wrong cast. Returns an error string or null.
function castValueProblem(v) {
  if (!Array.isArray(v)) return 'cast: newValue must be an array';
  for (const [i, m] of v.entries()) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return `cast[${i}]: must be an object`;
    if (typeof m.name !== 'string' || !m.name.trim()) return `cast[${i}].name: must be a non-empty string`;
    if (m.role != null && typeof m.role !== 'string') return `cast[${i}].role: must be a string`;
  }
  return null;
}

// shows.json rejectedImageUrls check for the human-approved data-edit path
// (BRO-4996): an array of http(s) URLs that keeps every URL already there.
// Returns an error string or null.
function rejectedUrlsValueProblem(newValue, oldValue) {
  if (!Array.isArray(newValue)) return 'rejectedImageUrls: newValue must be an array';
  for (const [i, u] of newValue.entries()) {
    if (typeof u !== 'string' || !/^(google-images:)?https?:\/\/\S+$/i.test(u)) return `rejectedImageUrls[${i}]: must be an http(s) URL (a Google Images page as recorded: google-images:https://...)`;
  }
  const kept = new Set(newValue);
  const lost = (Array.isArray(oldValue) ? oldValue : []).filter((u) => !kept.has(u));
  if (lost.length) return `rejectedImageUrls: a plan may only add URLs (would drop ${lost[0]})`;
  return null;
}

// shows.json officialUrl check for the human-approved data-edit path (BRO-5343):
// null (clear) or an https URL on a dedicated site, never a ticket, review or
// listing domain (the discovery blocklist). Returns an error string or null.
function officialUrlValueProblem(newValue) {
  if (newValue === null) return null;
  if (typeof newValue !== 'string' || !/^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/i.test(newValue)) return 'officialUrl: newValue must be null or an https URL';
  const { isBlockedDomain } = require('./official-url-discovery.js');
  if (isBlockedDomain(newValue)) return 'officialUrl: ticket, review and listing sites are not official sites';
  return null;
}

// shows.json priorRuns check for the human-approved data-edit path (BRO-5000): same
// entries in the same order, differing only in a boolean inheritReviews.
// Returns an error string or null.
function priorRunsValueProblem(newValue, oldValue) {
  if (!Array.isArray(newValue)) return 'priorRuns: newValue must be an array';
  const old = Array.isArray(oldValue) ? oldValue : [];
  if (newValue.length !== old.length) return 'priorRuns: a plan may not add or remove runs, only set inheritReviews';
  for (const [i, n] of newValue.entries()) {
    const o = old[i];
    if (!n || typeof n !== 'object' || Array.isArray(n) || !o || typeof o !== 'object' || Array.isArray(o)) {
      return `priorRuns[${i}]: must be an existing run object`;
    }
    if (n.inheritReviews !== undefined && typeof n.inheritReviews !== 'boolean') return `priorRuns[${i}].inheritReviews: must be a boolean`;
    const strip = (r) => { const { inheritReviews, ...rest } = r; return JSON.stringify(rest); };
    if (strip(n) !== strip(o)) return `priorRuns[${i}]: only inheritReviews may change`;
  }
  return null;
}

// shows.json firstRunStart check for the human-approved data-edit path
// (BRO-4768): null, or a real YYYY-MM-DD day strictly before the row's own
// first performance (previewsStartDate, else openingDate) and not in the
// future. Returns an error string or null.
function firstRunStartValueProblem(newValue, show, today = new Date().toISOString().slice(0, 10)) {
  if (newValue === null) return null;
  if (!isIsoDay(newValue)) return 'firstRunStart: must be null or a real YYYY-MM-DD date';
  const own = (show && (show.previewsStartDate || show.openingDate)) || null;
  if (!own) return 'firstRunStart: the show has no previewsStartDate/openingDate to precede';
  if (!(newValue < String(own).slice(0, 10))) return `firstRunStart: ${newValue} must be before this row's own first performance (${own})`;
  if (newValue > today) return `firstRunStart: ${newValue} is in the future`;
  return null;
}

function isIsoDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

module.exports = {
  FEEDBACK_EDITABLE_FIELDS,
  AUTO_FIX_EDITABLE_FIELDS,
  SHOW_IDENTITY_FIELDS,
  pickEditableFields,
  buildShowSnapshot,
  castValueProblem,
  rejectedUrlsValueProblem,
  priorRunsValueProblem,
  officialUrlValueProblem,
  firstRunStartValueProblem,
  isIsoDay,
};
