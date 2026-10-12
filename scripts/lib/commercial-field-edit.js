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
// A designationBasis says what a loss label rests on, so it only belongs on
// Flop/Fizzle (commercial-record-checks.js refuses it elsewhere). Moving a
// record off a loss label drops it, as sanitizeForPublicRecord does; without
// this an owner relabel of a policy-B Fizzle to Nonprofit failed validation
// and rolled back the whole plan (BRO-5092, torch-song-2018).
const { LOSS_DESIGNATIONS } = require('./commercial-record-checks');

function applyCommercialFieldEdit(commercial, slug, field, oldValue, newValue, now = new Date().toISOString()) {
  const record = commercial && commercial.shows && commercial.shows[slug];
  if (!record) return { ok: false, reason: `No commercial entry for "${slug}"` };

  const currentVal = record[field] ?? null;
  if (JSON.stringify(currentVal) !== JSON.stringify(oldValue)) {
    return { ok: false, reason: `commercial.json:${field}: value changed since plan` };
  }

  record[field] = newValue;
  if (field === 'designation' && !LOSS_DESIGNATIONS.includes(newValue)) delete record.designationBasis;
  if (field !== 'lastUpdated') record.lastUpdated = now;
  return { ok: true, msg: `commercial.json: ${field} updated for ${slug}` };
}

module.exports = { applyCommercialFieldEdit };
