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
const { stampDesignationBasis } = require('./commercial-apply-gate');
const { methodologyForCostSource } = require('./waltz-cost-gap-fill');
const { isLossDesignation, lossDesignationFor, returnedEstimatePct } = require('./commercial-designations');

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
  // A cost the tip adds to a record with no method gets the one its source
  // reads as (BRO-6297: a cited cost with no method splits site from model).
  if (proposedChanges.some((c) => c.field === 'weeklyRunningCost') && draft.weeklyRunningCost > 0 && !draft.costMethodology) {
    draft.costMethodology = methodologyForCostSource(draft.weeklyRunningCostSource);
  }
  // A loss label the tip names takes the size the record's evidence supports
  // (owner 2026-10-18, BRO-5636): an estimate the tip adds counts. A label a
  // person locked stays as they set it.
  if (proposedChanges.some((c) => c.field === 'designation') && isLossDesignation(draft.designation) && existing.humanReviewedDesignation !== true) {
    draft.designation = lossDesignationFor(returnedEstimatePct(draft));
  }
  // Every loss label carries a basis (owner policy B, BRO-5020): the tip's
  // own, else the unchanged label's, else the cautious silence basis.
  const proposedBasis = proposedChanges.find((c) => c.field === 'designationBasis');
  stampDesignationBasis(draft, { designationBasis: proposedBasis && proposedBasis.newValue }, existing);
  const show = (showList || []).find((s) => s && s.slug === slug);
  const { entry, holdReason } = sanitizeForPublicRecord(draft, show);
  if (holdReason) return refuse(holdReason);
  const ctx = { showRecord: show, allRecords: commercial.shows, priorRecord: existing };
  const problems = [...commercialRecordErrors(slug, entry, ctx), ...commercialRecordWarnings(slug, entry, ctx)];
  if (problems.length) return refuse(problems[0]);
  const changes = changedFields(existing, entry);
  if (!changes.length) return refuse('nothing to change: the tip matches what is already recorded');
  return { record: entry, changes, refusedReason: null };
}

/**
 * Queues a tip's cleaned changes in data/commercial-pending-review.json as a
 * human-review row (BRO-6398). A reader tip is public, unauthenticated text
 * judged by a model, so it never writes commercial.json itself: the daily
 * apply pass (scripts/apply-commercial-pending.js) holds rows carrying
 * `requiresHumanReview` until a person releases them, and the Linear sync
 * puts the row in front of the owner.
 *
 * Pure: never mutates `pending`.
 *
 * @param {{ generatedAt?: string|null, shows?: object }} pending - parsed commercial-pending-review.json
 * @param {{ slug: string, title: string, changes: { field: string, newValue: * }[], confidence: string,
 *           source?: string|null, issueNumber: string|number, reasoning?: string|null, now?: string }} tip
 * @returns {object} the next pending file contents
 */
const STALE_REVIEW_STAMPS = ['ownerDigestSentAt', 'autoApplyBlocked', 'autoApplyBlockedAt', 'truthReview', 'sourceVerifyAttempts'];

/**
 * Reads commercial-pending-review.json. A missing file is an empty queue; any
 * other failure (unreadable, malformed JSON) throws, because defaulting there
 * would let the next write replace every queued row with an empty file.
 */
function readPendingFile(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return { generatedAt: null, shows: {} };
    throw e;
  }
}

function queueTipForReview(pending, { slug, title, changes, confidence, source, issueNumber, reasoning, now }) {
  const at = now || new Date().toISOString();
  const proposed = Object.fromEntries((changes || []).map((c) => [c.field, c.newValue]));
  const entry = {
    title,
    slug,
    ...proposed,
    // `reason` keeps the tip's provenance on the row for the worker who settles it.
    reason: `Reader tip via GitHub issue #${issueNumber}${reasoning ? `: ${reasoning}` : ''}`,
    confidence,
    sources: source ? [{ type: 'tip', url: source, date: at.slice(0, 10) }] : [],
    detectedBy: 'github-tip',
    tipIssue: issueNumber,
    tipIssues: [...(((pending && pending.shows && pending.shows[slug]) || {}).tipIssues || []), issueNumber],
    tipReasoning: reasoning || null,
    requiresHumanReview: true,
    researchedAt: at,
  };
  // A research row already queued for the show keeps its fields and sources;
  // the tip's fields win and the hold stays (deep-research merges the same way
  // through carryHumanReviewHold rather than replacing the row).
  const prior = (pending && pending.shows && pending.shows[slug]) || null;
  const merged = prior
    ? { ...prior, ...entry, sources: [...(Array.isArray(prior.sources) ? prior.sources : []), ...entry.sources] }
    : entry;
  // Stamps from the prior row's own review cycle must not carry over: a stale
  // truthReview / autoApplyBlocked verdict would block the tip's release for
  // reasons that predate it (ownerDigestSentAt is a leftover of the digest
  // BRO-6471 retired).
  for (const k of STALE_REVIEW_STAMPS) delete merged[k];
  return { ...(pending || {}), generatedAt: at, shows: { ...((pending && pending.shows) || {}), [slug]: merged } };
}

module.exports = { buildTipRecord, queueTipForReview, readPendingFile, STALE_REVIEW_STAMPS };
