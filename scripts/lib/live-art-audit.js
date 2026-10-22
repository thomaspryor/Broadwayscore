'use strict';
/**
 * Pure helpers for scripts/audit-live-show-art.js (BRO-5744).
 * Kept separate so the selection and classification rules are unit-tested
 * against the real functions (CLAUDE.md section 15).
 */

const LIVE_STATUSES = ['open', 'previews', 'upcoming', 'announced'];

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

const ERROR_ISSUES = ['api_error', 'download_error', 'parse_error', 'invalid_input'];

/** Live shows that carry a thumbnail path, in shows.json order. */
function selectLiveShows(shows, { statuses = LIVE_STATUSES, showId = null } = {}) {
  return (Array.isArray(shows) ? shows : []).filter(s =>
    s && statuses.includes(s.status)
    && s.images && typeof s.images.thumbnail === 'string' && s.images.thumbnail
    && (!showId || s.id === showId));
}

/**
 * Map a verifyImage result to an audit row kind, or null when the art is fine.
 * production_still / headshot_cast rejections are not wrong-work art (press
 * stills are common off-West End), so they are dropped, as in the BRO-5739
 * sweep. Low-confidence rejections are dropped to keep the report short.
 * @returns {{kind: string, errored: boolean}|null}
 */
function classifyResult(result) {
  const r = result || {};
  const issues = Array.isArray(r.issues) ? r.issues : [];
  if (r.skipped || issues.some(i => ERROR_ISSUES.includes(i))) {
    return { kind: 'error', errored: true };
  }
  if (r.match !== false) return null;
  if (r.confidence === 'low') return null;
  if (r.imageType === 'production_still' || r.imageType === 'headshot_cast') return null;
  for (const i of issues) {
    if (WRONG_WORK_ISSUES[i]) return { kind: WRONG_WORK_ISSUES[i], errored: false };
  }
  return null;
}

/** Report written to data/audit/live-art-audit.json. */
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

module.exports = { LIVE_STATUSES, selectLiveShows, classifyResult, buildReport };
