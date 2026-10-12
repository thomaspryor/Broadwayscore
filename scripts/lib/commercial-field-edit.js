// One approved data-edit on a commercial.json record, for
// execute-approved-fix.js.
//
// Stamps the record's lastUpdated. Without a base copy the push merge
// (merge-commercial-data.js) keeps whichever record has the newer
// lastUpdated, and a correction that left it unchanged tied with a
// concurrent writer's stale copy and lost (BRO-4657: Lucky Guy's approved
// fix was reverted by Commercial Friday Refresh on 2026-10-05). The write
// guard now stamps every content change (commercial-record-stamp.js,
// BRO-5005); this explicit stamp stays for callers that save another way.
//
// A designation edit also settles designationBasis the way the apply gate
// does (stampDesignationBasis): a Flop/Fizzle keeps the record's valid basis
// or gets 'no-recoupment-announced', any other label drops it, since
// commercial-record-checks.js refuses a basis off a loss label and warns on a
// loss label without one, and either fails the plan's validation. Without
// this an owner relabel of a policy-B Fizzle to Nonprofit rolled back the
// whole plan (BRO-5092, torch-song-2018). A plan that also edits
// designationBasis should list that edit first; listed after, a planned drop
// that already happened counts as done.
const { canonicalDesignation } = require('./commercial-designations');
const { stampDesignationBasis } = require('./commercial-apply-gate');

function applyCommercialFieldEdit(commercial, slug, field, oldValue, newValue, now = new Date().toISOString()) {
  const record = commercial && commercial.shows && commercial.shows[slug];
  if (!record) return { ok: false, reason: `No commercial entry for "${slug}"` };

  const currentVal = record[field] ?? null;
  const impliedDrop = field === 'designationBasis' && newValue == null && currentVal === null;
  if (!impliedDrop && JSON.stringify(currentVal) !== JSON.stringify(oldValue)) {
    return { ok: false, reason: `commercial.json:${field}: value changed since plan` };
  }

  if (field === 'designation') {
    record.designation = canonicalDesignation(newValue) || newValue;
    stampDesignationBasis(record, { designationBasis: record.designationBasis }, null);
  } else {
    record[field] = newValue;
  }
  if (field !== 'lastUpdated') record.lastUpdated = now;
  return { ok: true, msg: `commercial.json: ${field} updated for ${slug}` };
}

module.exports = { applyCommercialFieldEdit };
