/**
 * Merge a pending-review entry onto an existing commercial.json entry.
 *
 * The legacy behaviour in apply-commercial-pending.js built a fresh entry
 * from only the fields present in the pending record, then assigned it to
 * commercial.shows[showId] — which silently dropped any existing field the
 * LLM didn't echo (estimatedRecoupmentPct, modelRecoupmentPct, recoupedWeeks,
 * weeklyGross, …). Re-researching a show could clobber known-true data.
 *
 * This merge is conservative: existing values are preserved unless the
 * pending entry has an explicit non-null override. Sources, when supplied,
 * replace the existing list (the LLM is asked to return the citation set
 * for the figures it just produced).
 */

const PENDING_OVERRIDABLE_STRINGS = ['designation', 'capitalizationSource', 'costMethodology', 'recoupedSource', 'notes'];
const PENDING_OVERRIDABLE_NUMBERS = ['capitalization', 'weeklyRunningCost'];

function buildMergedEntry({ existing, pending, normalizeSources, now = () => new Date().toISOString() }) {
  // Start from existing entry so unrelated fields (modelRecoupmentPct,
  // estimatedRecoupmentPct, recoupedWeeks, weeklyGross, etc.) survive.
  const merged = existing ? { ...existing } : {};

  for (const key of PENDING_OVERRIDABLE_STRINGS) {
    if (pending[key]) merged[key] = pending[key];
  }
  for (const key of PENDING_OVERRIDABLE_NUMBERS) {
    if (pending[key] != null) merged[key] = pending[key];
  }
  // recouped is a boolean — only `null`/`undefined` should be a no-op.
  // `false` is a meaningful update (LLM determined the show did NOT recoup).
  if (pending.recouped != null) merged.recouped = pending.recouped;
  if (pending.recoupedDate) merged.recoupedDate = pending.recoupedDate;

  if (Array.isArray(pending.sources) && pending.sources.length > 0) {
    const normalized = normalizeSources ? normalizeSources(pending.sources) : pending.sources;
    if (normalized.length > 0) merged.sources = normalized;
  }

  merged.lastUpdated = now();
  merged.firstAdded = existing?.firstAdded || now();

  // Research tracking metadata is owned by the research pipeline, not by
  // pending-review; preserve whatever existing had even if a stale clone
  // arrives in the spread.
  if (existing) {
    if (existing.researchAttempts != null) merged.researchAttempts = existing.researchAttempts;
    if (existing.lastResearchedAt != null) merged.lastResearchedAt = existing.lastResearchedAt;
    if (existing.researchTrigger != null) merged.researchTrigger = existing.researchTrigger;
  }

  return merged;
}

module.exports = { buildMergedEntry };
