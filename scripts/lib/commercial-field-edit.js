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
//
// A capitalization or capitalizationSource edit re-derives
// capitalizationBasis from the source wording, as the apply gate does
// (retagCapitalizationBasis, BRO-5660): a basis set for the old figure
// would otherwise keep printing "up to" on a sold amount, or drop it from a
// new Form D maximum. A plan that also sets capitalizationBasis lists it
// after; when the re-derived value is already there it counts as the
// planned oldValue.
//
// A costHistory edit must be an array of anchors that pass anchorErrors.
const { canonicalDesignation } = require('./commercial-designations');
const { stampDesignationBasis } = require('./commercial-apply-gate');
const { capitalizationBasisFromText, isBareCapitalizationSource, retagCapitalizationBasis } = require('./public-source-text');

// A redated anchor's own dates must agree (BRO-6218): asOf inside the period it
// measured, and no later than the report (the cost-anchor ledger's rule).
function anchorPeriodErrors(a) {
  const errs = [];
  if (!a || typeof a !== 'object') return errs;
  if (a.periodStart && a.periodEnd && a.periodStart > a.periodEnd) errs.push('periodStart is after periodEnd');
  if (a.periodStart && a.asOf < a.periodStart) errs.push('asOf is before periodStart');
  if (a.periodEnd && a.asOf > a.periodEnd) errs.push('asOf is after periodEnd');
  if (a.reportedAt && a.asOf > a.reportedAt) errs.push('asOf is later than reportedAt');
  return errs;
}

function applyCommercialFieldEdit(commercial, slug, field, oldValue, newValue, now = new Date().toISOString()) {
  const record = commercial && commercial.shows && commercial.shows[slug];
  if (!record) return { ok: false, reason: `No commercial entry for "${slug}"` };

  const currentVal = record[field] ?? null;
  const impliedDrop = field === 'designationBasis' && newValue == null && currentVal === null;
  const impliedRetag = field === 'capitalizationBasis' && currentVal === capitalizationBasisFromText(record.capitalizationSource);
  if (!impliedDrop && !impliedRetag && JSON.stringify(currentVal) !== JSON.stringify(oldValue)) {
    return { ok: false, reason: `commercial.json:${field}: value changed since plan` };
  }

  // BRO-5815: a new capitalizationSource must quote the figure's sentence, give
  // a URL, or state its basis; a bare outlet name leaves the basis a guess.
  if (field === 'capitalizationSource' && isBareCapitalizationSource(newValue)) {
    return { ok: false, reason: `commercial.json:capitalizationSource for "${slug}" names an outlet but quotes nothing; quote the sentence, give a URL, or state "up to"/"sold" wording` };
  }

  // BRO-6218: the model silently drops a malformed anchor, so a plan that
  // writes one would lose the figure without a word; refuse it instead.
  if (field === 'costHistory') {
    if (!Array.isArray(newValue)) return { ok: false, reason: `commercial.json:costHistory for "${slug}" must be an array` };
    const { anchorErrors } = require('./cost-history');
    const bad = newValue.map((a, i) => [i, [...anchorErrors(a), ...anchorPeriodErrors(a)]]).find(([, errs]) => errs.length);
    if (bad) return { ok: false, reason: `commercial.json:costHistory[${bad[0]}] for "${slug}": ${bad[1].join('; ')}` };
  }

  if (field === 'designation') {
    record.designation = canonicalDesignation(newValue) || newValue;
    stampDesignationBasis(record, { designationBasis: record.designationBasis }, null);
  } else {
    record[field] = newValue;
    if (field === 'capitalization' || field === 'capitalizationSource') retagCapitalizationBasis(record);
  }
  if (field !== 'lastUpdated') record.lastUpdated = now;
  return { ok: true, msg: `commercial.json: ${field} updated for ${slug}` };
}

module.exports = { applyCommercialFieldEdit };
