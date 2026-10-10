// One approved data-edit on a commercial.json record, for
// execute-approved-fix.js.
//
// Stamps the record's lastUpdated. Without a base copy the push merge
// (merge-commercial-data.js) keeps whichever record has the newer
// lastUpdated, and a correction that left it unchanged tied with a
// concurrent writer's stale copy and lost (BRO-4657: Lucky Guy's approved
// fix was reverted by Commercial Friday Refresh on 2026-10-05).
function applyCommercialFieldEdit(commercial, slug, field, oldValue, newValue, now = new Date().toISOString()) {
  const record = commercial && commercial.shows && commercial.shows[slug];
  if (!record) return { ok: false, reason: `No commercial entry for "${slug}"` };

  const currentVal = record[field] ?? null;
  if (JSON.stringify(currentVal) !== JSON.stringify(oldValue)) {
    return { ok: false, reason: `commercial.json:${field}: value changed since plan` };
  }

  record[field] = newValue;
  if (field !== 'lastUpdated') record.lastUpdated = now;
  return { ok: true, msg: `commercial.json: ${field} updated for ${slug}` };
}

module.exports = { applyCommercialFieldEdit };
