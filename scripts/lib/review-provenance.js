'use strict';

/**
 * Who put a review file in the corpus: the pipeline on its own, or a person / Claude session (BRO-7082).
 *
 * One vocabulary for "hand vs auto" on review-text files. Moved here from
 * replay-slow-market-openings.js (BRO-6979), which re-imports it, so the replay,
 * the opening grade and the create-time stamp in review-write-guard.js agree.
 * Pure: no IO, never throws.
 */

// approvedFixes fields that decide whether a file can go live. A criticName
// fix is cosmetic: the review was live before and after it.
const GATING_FIX_FIELDS = new Set(['wrongShow', 'wrongProduction', 'combinedWith', 'duplicateOf',
  'contentTier', 'isRoundupArticle', 'publishDate', 'url', 'showId']);
// ingestSource values that are a person's decision (execute-approved-fix runs
// an owner-approved digest fix). Every other named caller is a pipeline.
const HAND_CALLERS = new Set(['execute-approved-fix', 'manual', 'owner']);
// `source` values a person or session triggers without naming a caller: the
// reader form, a hand dispatch of ingest-urls.yml, a manual entry. With no
// caller these say nothing about who decided to ingest, so they stay unknown.
const CALLER_DECIDES_SOURCES = new Set(['submit-review-form', 'ingest-urls', 'manual-entry', 'manual']);
const CALLER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ORIGINS = new Set(['automated', 'manual', 'unknown']);

/** A caller slug safe to store and to put in a commit subject, else null. */
function sanitizeCaller(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return CALLER_RE.test(s) ? s : null;
}

/** Steps a person took that a file needed before it could go live. */
function handSteps(file) {
  const gating = [];
  const cosmetic = [];
  const caller = file.ingestSource || null;
  if (caller && HAND_CALLERS.has(caller)) gating.push(`ingest:${caller}`);
  for (const fx of Array.isArray(file.approvedFixes) ? file.approvedFixes : []) {
    (GATING_FIX_FIELDS.has(fx && fx.field) ? gating : cosmetic).push(`approvedFix:${fx && fx.field}`);
  }
  if (file.wrongProductionManualClear) gating.push('wrongProductionManualClear');
  if (file.suspectedMisattributionClearedNote) cosmetic.push('misattributionCleared');
  if (file.humanReviewScore != null) gating.push('humanReviewScore');
  return { gating, cosmetic };
}

/** How the file was discovered: 'auto', 'hand' or 'caller-unknown'. */
function discoveryMode(file) {
  const sources = [...new Set([file.source, ...(file.sources || [])].filter(Boolean))];
  const auto = sources.filter((s) => s !== 'submit-review-form');
  if (auto.length) return { mode: 'auto', sources };
  const caller = file.ingestSource || null;
  if (!caller) return { mode: 'caller-unknown', sources };
  return { mode: HAND_CALLERS.has(caller) ? 'hand' : 'auto', sources: [...sources, `caller:${caller}`] };
}

/**
 * Origin of a file being CREATED: { origin: 'automated'|'manual'|'unknown', by }.
 * Order: an explicit data.ingestOrigin, env INGEST_ORIGIN, the named caller
 * (data.ingestSource or env INGEST_CALLER), then the collector `source`.
 * A guess is never made from where the process runs: unknown is the honest default.
 */
function originFor({ data = {}, env = {} } = {}) {
  try {
    if (ORIGINS.has(data.ingestOrigin)) return { origin: data.ingestOrigin, by: data.ingestOriginBy || 'explicit' };
    const envOrigin = String(env.INGEST_ORIGIN || '').trim();
    if (ORIGINS.has(envOrigin)) return { origin: envOrigin, by: sanitizeCaller(env.INGEST_CALLER) || 'env:INGEST_ORIGIN' };
    const caller = sanitizeCaller(data.ingestSource) || sanitizeCaller(env.INGEST_CALLER);
    if (caller) return { origin: HAND_CALLERS.has(caller) ? 'manual' : 'automated', by: caller };
    const sources = [...new Set([data.source, ...(Array.isArray(data.sources) ? data.sources : [])].filter((s) => typeof s === 'string' && s))];
    const pipeline = sources.filter((s) => !CALLER_DECIDES_SOURCES.has(s));
    if (pipeline.length) return { origin: 'automated', by: `source:${pipeline[0]}`.slice(0, 80) };
    return { origin: 'unknown', by: sources.length ? `source:${sources[0]}`.slice(0, 80) : null };
  } catch {
    return { origin: 'unknown', by: null };
  }
}

/**
 * Stamp ingestOrigin/ingestOriginBy on a record about to be created, in place.
 * No-op when already stamped or when REVIEW_ORIGIN_STAMP=off. Never throws.
 */
function stampIngestOrigin(data, env = process.env) {
  try {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (String(env.REVIEW_ORIGIN_STAMP || '').toLowerCase() === 'off') return false;
    if (ORIGINS.has(data.ingestOrigin) && data.ingestOriginBy !== undefined) return false;
    const { origin, by } = originFor({ data, env });
    data.ingestOrigin = origin;
    data.ingestOriginBy = by;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  GATING_FIX_FIELDS, HAND_CALLERS, CALLER_DECIDES_SOURCES,
  sanitizeCaller, handSteps, discoveryMode, originFor, stampIngestOrigin,
};
