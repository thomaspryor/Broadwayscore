'use strict';
/**
 * Pure helpers for scripts/audit-live-show-art.js (BRO-5744).
 * Kept separate so the selection and classification rules are unit-tested
 * against the real functions (CLAUDE.md section 15).
 */

const { applyStrictVerdict } = require('./verify-image');

const LIVE_STATUSES = ['open', 'previews', 'upcoming', 'announced'];
const LIVE_ART_ALERT_KEY = 'live-show-art:wrong-work';

// verifyImage issue categories that mean the art shows another work or no work.
const WRONG_WORK_ISSUES = {
  wrong_show: 'wrong_show',
  wrong_production: 'wrong_show',
  non_theatre_work: 'non_theatre_work',
  generic_image: 'generic_image',
  placeholder: 'generic_image',
  social_media_logo: 'generic_image',
  seating_chart: 'generic_image',
  ticket_listing: 'generic_image',
};

/** Live shows that carry a thumbnail path, in shows.json order. */
function selectLiveShows(shows, { statuses = LIVE_STATUSES, showId = null } = {}) {
  return (Array.isArray(shows) ? shows : []).filter(s =>
    s && statuses.includes(s.status)
    && s.images && typeof s.images.thumbnail === 'string' && s.images.thumbnail
    && (!showId || s.id === showId));
}

/**
 * Map a verifyImage result to an audit row kind, or null when the art is fine.
 * Verifier errors use the verifier's own predicate (applyStrictVerdict). A
 * production_still / headshot_cast rejection is only dropped when it names no
 * wrong-work issue: a press still of ANOTHER show still carries wrong_show.
 * Low-confidence rejections are dropped; medium and high are kept.
 * @returns {{kind: string, errored: boolean}|null}
 */
function classifyResult(result) {
  const r = result || {};
  if (applyStrictVerdict(r, { strict: true }).errored) return { kind: 'error', errored: true };
  if (r.match !== false || r.confidence === 'low') return null;
  const issues = Array.isArray(r.issues) ? r.issues : [];
  for (const i of issues) {
    if (WRONG_WORK_ISSUES[i]) return { kind: WRONG_WORK_ISSUES[i], errored: false };
  }
  return null;
}

/** Report written to tmp/live-art-audit.json. */
function buildReport(rows, { generatedAt, totalChecked, statuses = LIVE_STATUSES } = {}) {
  const flagged = rows.filter(r => !r.errored);
  const errors = rows.filter(r => r.errored);
  const byKind = {};
  for (const r of flagged) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  return {
    generatedAt: generatedAt || new Date().toISOString(),
    advisory: true,
    statuses,
    totalChecked,
    flaggedCount: flagged.length,
    errorCount: errors.length,
    byKind,
    flagged,
    errors: errors.map(e => ({ id: e.id, title: e.title, description: e.description })),
  };
}

/** One rollup alert for the run's flagged rows, or null when none. */
function buildLiveArtAlert(flagged) {
  const { buildRollupAlert } = require('./rollup-alert');
  return buildRollupAlert({
    key: LIVE_ART_ALERT_KEY,
    items: flagged,
    itemId: (r) => r.id,
    itemBlock: (r) => `- ${r.title || r.id} (${r.id}) [${r.kind}]: ${String(r.description || '').slice(0, 140)}`,
    title: (xs) => `${xs.length} live show(s) carry art of another work`,
    intro: (xs) => `The weekly vision sweep of served thumbnails flagged ${xs.length} live show(s). Check each on its show page; fix with an approved-fix plan (null the field AND git rm the file, or the orphan auto-fix re-attaches it).`,
    hint: () => 'node scripts/audit-live-show-art.js --show=<id> --no-write --no-alert   # re-check one show',
    severity: 'warn',
    cooldownHours: 144,
  });
}

module.exports = { LIVE_STATUSES, LIVE_ART_ALERT_KEY, selectLiveShows, classifyResult, buildReport, buildLiveArtAlert };
