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
 * @returns {{ record: object|null, changes: { field: string, oldValue: *, newValue: * }[], refusedReason: string|null }}
 *   `changes` is what the record actually gets, after cleaning (a proposed
 *   "Flop" on a running show is reported as the "TBD" written), for the
 *   changelog and the issue comment.
 */
const { sanitizeForPublicRecord, commercialRecordErrors, commercialRecordWarnings } = require('./commercial-record-checks');

function changedFields(before, after) {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields]
    .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
    .map((field) => ({ field, oldValue: before[field] ?? null, newValue: after[field] ?? null }));
}

function buildTipRecord(commercial, showList, slug, proposedChanges) {
  const refuse = (refusedReason) => ({ record: null, changes: [], refusedReason });
  const existing = commercial.shows && commercial.shows[slug];
  if (!existing) return refuse(`no commercial record for "${slug}" yet`);
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
  if (holdReason) return refuse(holdReason);
  const ctx = { showRecord: show, allRecords: commercial.shows };
  const problems = [...commercialRecordErrors(slug, entry, ctx), ...commercialRecordWarnings(slug, entry, ctx)];
  if (problems.length) return refuse(problems[0]);
  const changes = changedFields(existing, entry);
  if (!changes.length) return refuse('nothing to change: the tip matches what is already recorded');
  return { record: entry, changes, refusedReason: null };
}

module.exports = { buildTipRecord };
