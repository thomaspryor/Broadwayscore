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
    'venue', 'theaterAddress', 'synopsis', 'runtime', 'intermissions', 'ageRecommendation',
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
    // BRO-5000: whole array, compare-and-set; human-approved plans only. A plan may set a
    // boolean inheritReviews on an existing entry (carry or stop carrying that earlier
    // run's reviews, lib/prior-run-sibling.js), and (BRO-5687) APPEND one new earlier run
    // within appendedPriorRunProblem's bounds. Existing windows are never re-dated or
    // removed: priorRuns windows are scoring inputs. Reach of one added run: a show's
    // first priorRuns entry also switches off three show-wide guards
    // (prior-run-republish-guard.js, date-guard.js x2) and lets the rebuild auto-clear
    // wrongProduction inside the window.
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
    'ourEstimateRangePct',
    'weeklyRunningCostBasis', 'commercialConversion',
    // capitalizationBasis: 'maximum' (a Form D offering maximum or an "up to"
    // figure, printed "up to $X"), 'sold' or 'reported' (BRO-5660; values in
    // public-source-text.js, checked by commercial-record-checks.js).
    'capitalizationBasis',
    // A cited cost supersedes the free-text estimate beside it (same linked
    // group in merge-commercial-data.js, BRO-5515).
    'weeklyRunningCostNote',
    // A nonprofit run with commercial co-producers is an 'enhancement' and
    // counts on /biz like a commercial one (hasNoInvestorsToRepay); research
    // that finds the credit must be able to record it (BRO-5520). Values and
    // the Tour Stop pairing are checked by commercial-record-checks.js.
    'productionType',
    // The dated cost anchors the model reads (cost-history.js). A plan
    // replaces the whole array (compare-and-set), so a mis-dated anchor can be
    // redated to the period it measured (BRO-6218, Cabaret's first seven
    // weeks). commercial-field-edit.js refuses any anchor anchorErrors flags.
    'costHistory',
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
// BRO-5163: the one way to drop a URL is an explicit per-URL `unreject` list on
// the action, [{url, reason}], so a plan can't silently unblock a bad source.
// Every dropped URL must be named with a substantive reason, and nothing may be
// named that isn't actually dropped. Returns an error string or null.
function rejectedUrlsValueProblem(newValue, oldValue, unreject) {
  if (!Array.isArray(newValue)) return 'rejectedImageUrls: newValue must be an array';
  for (const [i, u] of newValue.entries()) {
    if (typeof u !== 'string' || !/^(google-images:)?https?:\/\/\S+$/i.test(u)) return `rejectedImageUrls[${i}]: must be an http(s) URL (a Google Images page as recorded: google-images:https://...)`;
  }
  const kept = new Set(newValue);
  const lost = (Array.isArray(oldValue) ? oldValue : []).filter((u) => !kept.has(u));
  const named = unreject === undefined ? [] : unreject;
  if (!Array.isArray(named)) return 'rejectedImageUrls: unreject must be an array of {url, reason}';
  const approved = new Set();
  for (const [i, e] of named.entries()) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return `rejectedImageUrls: unreject[${i}] must be an object with url and reason`;
    if (typeof e.url !== 'string' || !e.url) return `rejectedImageUrls: unreject[${i}].url is required`;
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) return `rejectedImageUrls: unreject[${i}].reason is required (10+ chars) for ${e.url}`;
    approved.add(e.url);
  }
  for (const u of approved) {
    if (!lost.includes(u)) return `rejectedImageUrls: unreject names ${u}, which the plan does not drop`;
  }
  const unapproved = lost.find((u) => !approved.has(u));
  if (unapproved) return `rejectedImageUrls: a plan may only add URLs unless the action lists it in unreject with a reason (would drop ${unapproved})`;
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
// entries in the same order, differing only in a boolean inheritReviews. BRO-5687: a plan
// may also APPEND exactly one new earlier run, validated by appendedPriorRunProblem (it
// needs the show to bound the window). Returns an error string or null.
function priorRunsValueProblem(newValue, oldValue, show) {
  if (!Array.isArray(newValue)) return 'priorRuns: newValue must be an array';
  const old = Array.isArray(oldValue) ? oldValue : [];
  if (newValue.length === old.length + 1) {
    // Existing runs untouched and in order (a toggle in the same plan is not allowed:
    // one reviewed change per plan).
    for (const [i, o] of old.entries()) {
      if (JSON.stringify(newValue[i]) !== JSON.stringify(o)) return `priorRuns[${i}]: an existing run may not change in the same plan that appends one`;
    }
    return appendedPriorRunProblem(newValue[old.length], old, show);
  }
  if (newValue.length !== old.length) return 'priorRuns: a plan may append one new earlier run or set inheritReviews, but may not add or remove runs otherwise';
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

// A window a plan may add (BRO-5687, owner chose to count Angel's Bone's Manchester
// premiere). priorRuns windows are scoring inputs: they switch off the show-wide date and
// republish guards and let the rebuild auto-clear wrongProduction inside them, so the added
// run is bounded tightly. Same grace the autoclear gives reviews after a close
// (REVIEW_LAG_GRACE_DAYS in wrong-production-autoclear.js) must not reach the current run.
const PRIOR_RUN_PLAN_MAX_SPAN_DAYS = 400;
const PRIOR_RUN_PLAN_GRACE_DAYS = 7;
const PRIOR_RUN_PLAN_KEYS = ['openingDate', 'closingDate', 'venue', 'inheritReviews', 'source', 'note'];
function appendedPriorRunProblem(run, existing, show) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return 'priorRuns: the appended run must be an object';
  const extra = Object.keys(run).filter((k) => !PRIOR_RUN_PLAN_KEYS.includes(k));
  if (extra.length) return `priorRuns: appended run may only carry ${PRIOR_RUN_PLAN_KEYS.join(', ')} (got ${extra.join(', ')})`;
  if (!isIsoDay(run.openingDate) || !isIsoDay(run.closingDate)) return 'priorRuns: appended run needs real YYYY-MM-DD openingDate and closingDate';
  if (run.closingDate < run.openingDate) return 'priorRuns: appended run closingDate is before its openingDate';
  const DAY = 86400000;
  const day = (d) => Date.parse(`${d}T00:00:00Z`) / DAY;
  if (day(run.closingDate) - day(run.openingDate) > PRIOR_RUN_PLAN_MAX_SPAN_DAYS) return `priorRuns: appended run spans more than ${PRIOR_RUN_PLAN_MAX_SPAN_DAYS} days`;
  if (typeof run.venue !== 'string' || !run.venue.trim()) return 'priorRuns: appended run needs a venue';
  const { sanitizeVenueForWrite } = require('./venue-classification');
  if (sanitizeVenueForWrite(run.venue) !== run.venue) return `priorRuns: venue "${run.venue}" is a placeholder or not in its sanitised form`;
  if (run.inheritReviews !== undefined && typeof run.inheritReviews !== 'boolean') return 'priorRuns: inheritReviews must be a boolean';
  for (const k of ['source', 'note']) {
    if (run[k] !== undefined && (typeof run[k] !== 'string' || run[k].length > 300)) return `priorRuns: ${k} must be a string of at most 300 characters`;
  }
  const own = show && (show.previewsStartDate || show.openingDate);
  if (!own) return 'priorRuns: the show has no previewsStartDate/openingDate to bound the appended run';
  if (!(day(run.closingDate) + PRIOR_RUN_PLAN_GRACE_DAYS < day(String(own).slice(0, 10)))) {
    return `priorRuns: appended run must close more than ${PRIOR_RUN_PLAN_GRACE_DAYS} days before this show's own first performance (${own})`;
  }
  for (const e of existing) {
    // A run with only one valid date (abigails-party-west-end-2026 has a null openingDate)
    // still occupies that day: use it for both ends rather than skip the overlap check.
    const eOpen = e && (isIsoDay(e.openingDate) ? e.openingDate : (isIsoDay(e.closingDate) ? e.closingDate : null));
    if (!eOpen) continue;
    const eClose = isIsoDay(e.closingDate) ? e.closingDate : eOpen;
    if (day(run.openingDate) <= day(eClose) + PRIOR_RUN_PLAN_GRACE_DAYS && day(eOpen) <= day(run.closingDate) + PRIOR_RUN_PLAN_GRACE_DAYS) {
      return 'priorRuns: appended run overlaps an existing prior run';
    }
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
  appendedPriorRunProblem,
  officialUrlValueProblem,
  firstRunStartValueProblem,
  isIsoDay,
};
