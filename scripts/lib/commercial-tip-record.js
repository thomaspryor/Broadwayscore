/**
 * Builds the commercial.json record process-commercial-tip.js would write for
 * a reader tip (BRO-4623). The tip's model may propose any field, and that
 * workflow commits without running validate-data, so the result is cleaned
 * like the other model-fed writers' output (sanitizeForPublicRecord) and then
 * refused if the commercial rules still reject it.
 *
 * Pure: never mutates `commercial`.
 *
 * @param {object} commercial - parsed commercial.json
 * @param {object[]} showList - shows.json `shows`
 * @param {string} slug - commercial.json key
 * @param {{ field: string, newValue: *, isEstimate?: boolean }[]} proposedChanges
 * @returns {{ record: object|null, refusedReason: string|null }}
 */
const { sanitizeForPublicRecord, commercialRecordErrors, commercialRecordWarnings } = require('./commercial-record-checks');

function buildTipRecord(commercial, showList, slug, proposedChanges) {
  const existing = commercial.shows && commercial.shows[slug];
  if (!existing) return { record: null, refusedReason: `no commercial record for "${slug}" yet` };
  const draft = { ...existing };
  if (existing.isEstimate) draft.isEstimate = { ...existing.isEstimate };
  for (const change of proposedChanges) {
    draft[change.field] = change.newValue;
    if (change.isEstimate && change.field !== 'designation') {
      draft.isEstimate = { ...(draft.isEstimate || {}), [change.field]: true };
    }
  }
  const show = (showList || []).find((s) => s && s.slug === slug);
  const { entry, holdReason } = sanitizeForPublicRecord(draft, show && show.status);
  if (holdReason) return { record: null, refusedReason: holdReason };
  const ctx = { showRecord: show, allRecords: commercial.shows };
  const problems = [...commercialRecordErrors(slug, entry, ctx), ...commercialRecordWarnings(slug, entry, ctx)];
  if (problems.length) return { record: null, refusedReason: problems[0] };
  return { record: entry, refusedReason: null };
}

module.exports = { buildTipRecord };
