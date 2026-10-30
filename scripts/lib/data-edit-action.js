'use strict';
/**
 * data-edit-action.js (BRO-5892): the `data-edit` action of a data/pending-fixes
 * plan, applied to an already-loaded core-data file. Moved out of
 * execute-approved-fix.js unchanged so preflight-review-fix-plan.js can replay a
 * plan's data-edits on in-memory copies and fail a stale oldValue before the
 * plan lands, instead of at apply time. The executor keeps loading and saving
 * (write guards) around it.
 *
 *   applyDataEdit(data, action, { root }) -> { ok, msg } | { ok: false, reason }
 *     data: the parsed file (shows.json / commercial.json / audience-buzz.json),
 *     mutated in place on success; the caller saves `data` itself.
 *     root: repo root, for the images existence check (public/...).
 */
const fs = require('fs');
const path = require('path');
const { pickEditableFields } = require('./feedback-pipeline-fields.js');

const ROOT = path.join(__dirname, '..', '..');

// awards.json excluded: applyDataEdit() has no handler for it.
const EDITABLE_DATA_FIELDS = pickEditableFields([
  'shows.json', 'commercial.json', 'audience-buzz.json',
]);
// Owner-set recoupment estimates are plan-only, never feedback/research output.
EDITABLE_DATA_FIELDS['commercial.json'] = [...EDITABLE_DATA_FIELDS['commercial.json'], 'ourRecoupEstimatePct', 'ourRecoupEstimateAsOf'];
// Plan-only (owner-approved) extras, not user-feedback fields (BRO-5975): the exemption a
// show earns when Playbill's page is a different production, which validate-show-venue.js
// honors only alongside a substantive statusBackfillSource.
EDITABLE_DATA_FIELDS['shows.json'] = [...EDITABLE_DATA_FIELDS['shows.json'], 'noPlaybillProductionPage', 'statusBackfillSource', 'ibdbRevivalChecked', 'ibdbUrl',
  // BRO-6515: metro slug for regional/tour city hubs (scripts/lib/venue-metro.js)
  'city',
  // BRO-6400: transfer links (a regional tryout, or a Broadway <-> West End
  // transfer). A plan sets both ends; validate-data checks they reciprocate.
  'transferOf', 'transferredTo'];

// BRO-6191: plan-only (owner-approved) commercial.json extras with value checks
// (cleared-field-guard.js planOnlyValueProblem); not offered to the feedback-plan LLM.
EDITABLE_DATA_FIELDS['commercial.json'] = [...EDITABLE_DATA_FIELDS['commercial.json'], ...require('./cleared-field-guard.js').PLAN_ONLY_COMMERCIAL_FIELDS];

/** null when the file and field are editable by a plan, else the refusal reason. */
function dataEditAllowProblem({ file, field }) {
  if (!EDITABLE_DATA_FIELDS[file]) return `File "${file}" not allowed for data-edit`;
  if (!EDITABLE_DATA_FIELDS[file].includes(field)) return `Field "${field}" not allowed in ${file}`;
  return null;
}

// Another fix already wrote this exact value: the edit is satisfied, so it is
// a no-op success ({ noop: true }), not a refusal (BRO-6489: one such edit
// turned a run red). commercial.json edits still refuse (applyCommercialFieldEdit).
function alreadyNewValue(currentVal, newValue) {
  return newValue !== undefined && JSON.stringify(currentVal) === JSON.stringify(newValue ?? null);
}

function applyDataEdit(data, action, { root = ROOT } = {}) {
  const { file, showId, field, oldValue, newValue, unreject } = action;
  const notAllowed = dataEditAllowProblem(action);
  if (notAllowed) return { ok: false, reason: notAllowed };

  if (file === 'shows.json') {
    const shows = data.shows || data;
    const idx = shows.findIndex(s => s.id === showId);
    if (idx === -1) return { ok: false, reason: `Show "${showId}" not found in shows.json` };

    // JSON plans cannot say `undefined`: an absent field is written as
    // oldValue null, so compare it as null (BRO-4623).
    const currentVal = shows[idx][field] ?? null;
    // An already-written value still goes through the checks and the write below,
    // so the human pin / provenance / revival tags are applied (an enricher may
    // have written the same value without them).
    const already = JSON.stringify(currentVal) !== JSON.stringify(oldValue) && alreadyNewValue(currentVal, newValue);
    if (JSON.stringify(currentVal) !== JSON.stringify(oldValue) && !already) {
      return { ok: false, reason: `${field}: current value doesn't match expected (data changed since plan was created)` };
    }
    // Validators that diff against the old value see what is stored, not the stale plan value.
    const prevValue = already ? currentVal : oldValue;
    if (field === 'images') {
      const { crossShowImageProblems } = require('./cross-show-images.js');
      if (!newValue || typeof newValue !== 'object' || Array.isArray(newValue)) {
        return { ok: false, reason: 'images: newValue must be an object' };
      }
      for (const [k, v] of Object.entries(newValue)) {
        if (!['thumbnail', 'poster', 'hero'].includes(k)) return { ok: false, reason: `images: unexpected key "${k}"` };
        // Only values the plan changes are checked: a plan that fixes one key
        // must not be refused over an untouched (e.g. already missing) path.
        if (prevValue && typeof prevValue === 'object' && JSON.stringify(prevValue[k]) === JSON.stringify(v)) continue;
        if (v !== null && typeof v !== 'string') return { ok: false, reason: `images.${k}: must be a string or null` };
        if (typeof v === 'string' && !v.startsWith('/images/shows/')) return { ok: false, reason: `images.${k}: only local /images/shows/ paths or null` };
        if (typeof v === 'string' && !fs.existsSync(path.join(root, 'public', v))) return { ok: false, reason: `images.${k}: ${v} does not exist` };
      }
      const cross = crossShowImageProblems({ id: showId, images: newValue }, shows);
      if (cross.length) {
        return { ok: false, reason: `images: ${cross.map(c => `${c.key} -> ${c.owner}`).join(', ')} is another show's art (BRO-4380)` };
      }
    }

    if (field === 'cast') {
      const { castValueProblem } = require('./feedback-pipeline-fields.js');
      const castProblem = castValueProblem(newValue);
      if (castProblem) return { ok: false, reason: castProblem };
    }

    if (field === 'noPlaybillProductionPage' || field === 'ibdbRevivalChecked') {
      if (newValue !== true) return { ok: false, reason: `${field}: plans may only set true` };
    }
    // Read as a boolean by the site and syncRevivalTags; "true" would pass every other guard.
    if (field === 'isRevival' && typeof newValue !== 'boolean') {
      return { ok: false, reason: `isRevival: must be true or false, got ${JSON.stringify(newValue)}` };
    }
    // BRO-6279: a wrong-production IBDB link (e.g. the 1964 page on a 2020 revival) is
    // fixed by plan; only a bare IBDB production URL is accepted, or null to clear it.
    if (field === 'ibdbUrl' && newValue !== null
        && !(typeof newValue === 'string' && /^https:\/\/www\.ibdb\.com\/broadway-production\/[a-z0-9-]+-\d+$/.test(newValue))) {
      return { ok: false, reason: `ibdbUrl: must be https://www.ibdb.com/broadway-production/<slug>-<id> or null, got ${JSON.stringify(newValue)}` };
    }
    if (field === 'statusBackfillSource') {
      if (typeof newValue !== 'string' || newValue.length <= 50) return { ok: false, reason: 'statusBackfillSource: needs a substantive (51+ char) source string' };
    }

    if (field === 'rejectedImageUrls') {
      const { rejectedUrlsValueProblem } = require('./feedback-pipeline-fields.js');
      const problem = rejectedUrlsValueProblem(newValue, prevValue, unreject);
      if (problem) return { ok: false, reason: problem };
    }

    if (field === 'officialUrl') {
      const { officialUrlValueProblem } = require('./feedback-pipeline-fields.js');
      const problem = officialUrlValueProblem(newValue);
      if (problem) return { ok: false, reason: problem };
    }

    if (field === 'firstRunStart') {
      const { firstRunStartValueProblem } = require('./feedback-pipeline-fields.js');
      const problem = firstRunStartValueProblem(newValue, shows[idx]);
      if (problem) return { ok: false, reason: problem };
    }

    if (field === 'priorRuns') {
      const { priorRunsValueProblem } = require('./feedback-pipeline-fields.js');
      const problem = priorRunsValueProblem(newValue, prevValue, shows[idx]);
      if (problem) return { ok: false, reason: problem };
    }

    // BRO-6400: an existing other show's id (or null), in a pair
    // transfer-link-rules.js allows. Reciprocity spans two actions, so
    // validate-data checks it after the plan applies.
    if (field === 'transferOf' || field === 'transferredTo') {
      if (newValue !== null) {
        if (typeof newValue !== 'string' || !newValue) return { ok: false, reason: `${field}: must be a show id string or null, got ${JSON.stringify(newValue)}` };
        if (newValue === showId) return { ok: false, reason: `${field}: a show cannot link to itself` };
        const target = shows.find(s => s.id === newValue);
        if (!target) return { ok: false, reason: `${field}: no show "${newValue}" in shows.json` };
        const { transferLinkCategoryError } = require('./transfer-link-rules.js');
        const problem = transferLinkCategoryError(shows[idx], field, target);
        if (problem) return { ok: false, reason: problem };
      }
    }

    if (field === 'noReliableArt') {
      const { validateNoReliableArtValue } = require('./no-reliable-art.js');
      const problem = validateNoReliableArtValue(newValue, shows[idx]);
      if (problem) return { ok: false, reason: problem };
    }

    // An absent field that is already null stays absent (no new null key).
    if (!(already && shows[idx][field] === undefined)) shows[idx][field] = newValue;
    // A person-approved synopsis is manual provenance (BRO-4856).
    if (field === 'synopsis') require('./synopsis-source.js').setSynopsis(shows[idx], newValue, 'manual');
    // An approved plan is a person's correction: pin it so the date enrichers
    // cannot put the old value back (BRO-4911; closingDate cousin).
    if (field === 'openingDate') require('./opening-date-guard.js').stampHumanCorrectedOpeningDate(shows[idx], newValue);
    if (field === 'closingDate' && newValue) shows[idx].humanCorrectedClosingDate = true;
    // The site also reads tags:'revival', so the flag alone can't clear it (BRO-4436).
    if (field === 'isRevival') require('./revival-tags.js').syncRevivalTags(shows[idx]);
    // `shows` was mutated in place and (for the object-root shape) IS
    // `data.shows`: the caller saves `data` itself, never a rebuilt copy, so
    // shows-write-guard's object-identity snapshot lookup still matches.
    const tagNote = field === 'isRevival' ? ` (tags: ${JSON.stringify(shows[idx].tags)})` : '';
    const verb = already ? `already ${JSON.stringify(currentVal)}, pins refreshed` : 'updated';
    return { ok: true, msg: `shows.json: ${field} ${verb} for ${showId}${tagNote}`, ...(already && { noop: true }) };

  } else if (file === 'commercial.json') {
    const { isPlanOnlyField, planOnlyValueProblem } = require('./cleared-field-guard.js');
    if (isPlanOnlyField(field)) {
      const bad = planOnlyValueProblem(field, oldValue, newValue);
      if (bad) return { ok: false, reason: bad };
    }
    const { applyCommercialFieldEdit } = require('./commercial-field-edit.js');
    return applyCommercialFieldEdit(data, action.showSlug || showId, field, oldValue, newValue);

  } else if (file === 'audience-buzz.json') {
    if (!data.shows?.[showId]) return { ok: false, reason: `No audience-buzz entry for "${showId}"` };

    const currentVal = data.shows[showId][field] ?? null;
    if (JSON.stringify(currentVal) !== JSON.stringify(oldValue)) {
      if (alreadyNewValue(currentVal, newValue)) {
        return { ok: true, noop: true, msg: `audience-buzz.json: ${field} already ${JSON.stringify(currentVal)} for ${showId}, nothing to change` };
      }
      return { ok: false, reason: `audience-buzz.json:${field}: value changed since plan` };
    }

    data.shows[showId][field] = newValue;
    return { ok: true, msg: `audience-buzz.json: ${field} updated for ${showId}` };
  }

  return { ok: false, reason: `Unhandled file: ${file}` };
}

module.exports = { applyDataEdit, dataEditAllowProblem, EDITABLE_DATA_FIELDS };
