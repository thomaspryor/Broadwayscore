/**
 * add-commercial-entry — the "create one commercial.json entry" action for
 * execute-approved-fix.js (BRO-4623).
 *
 * data-edit only edits fields of an EXISTING commercial.json entry, so a
 * Broadway production with no entry at all (Gutenberg!, John Proctor is the
 * Villain, ...) could not be added from a cloud session. A plan may now carry
 * { type: 'add-commercial-entry', slug: '<shows.json slug>', entry: {...} }.
 * Pure (no I/O): takes the commercial data object and the shows array,
 * mutates commercial.shows, returns a result.
 *
 * Guardrails:
 * - keyed by the shows.json SLUG, never the id (feedback_commercial_slug_keys:
 *   ID keys made 17 shows' data invisible and later broke the weekly publish)
 * - refuses an existing key, and an id-shaped key whose show has a slug
 * - Broadway shows only (the scorecard covers Broadway)
 * - canonical designation; field allowlist
 * - win/loss designations follow validate-data.js's citation policy: a win
 *   needs recouped=true with recoupedDate + recoupedSource + a sourced URL; a
 *   loss needs recouped=false with a sourced URL
 * - stamps humanReviewedDesignation on a final (non-TBD) outcome so
 *   apply-commercial-pending.js does not overwrite it with an LLM guess
 * - runs the shared per-record rules (commercial-record-checks.js) that
 *   validate-data.js enforces, so it cannot create a record the build rejects
 */

const { canonicalDesignation } = require('./commercial-designations');
const { VALID_SOURCE_TYPES } = require('./commercial-sources');
const { isCommercialScope } = require('./commercial-scope');
const { commercialRecordErrors, commercialRecordWarnings } = require('./commercial-record-checks');

const ALLOWED = new Set([
  'designation', 'recouped', 'recoupedDate', 'recoupedSource',
  'capitalization', 'capitalizationSource', 'weeklyRunningCost',
  'weeklyRunningCostSource', 'costMethodology', 'notes', 'sources',
  'nonprofitOrg', 'productionType',
]);
const WIN = new Set(['Miracle', 'Windfall', 'Easy Winner', 'Trickle']);
const LOSS = new Set(['Fizzle', 'Flop']);
const RECOUPED_DATE_RE = /^\d{4}(-\d{2})?$/;
const SOURCE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sourcesProblem(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return 'sources must be a non-empty array';
  for (const [i, s] of sources.entries()) {
    if (!s || typeof s !== 'object') return `sources[${i}] must be an object`;
    if (typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) return `sources[${i}].url must be an https URL`;
    if (!VALID_SOURCE_TYPES.includes(s.type)) return `sources[${i}].type must be one of ${VALID_SOURCE_TYPES.join(', ')}`;
    if (s.date != null && !SOURCE_DATE_RE.test(s.date)) return `sources[${i}].date must be YYYY-MM-DD or null`;
  }
  return null;
}

function applyAddCommercialEntry(commercial, shows, action, now = new Date().toISOString()) {
  const slug = action && action.slug;
  const entry = action && action.entry;
  if (!slug || typeof slug !== 'string') return { ok: false, reason: 'add-commercial-entry: missing slug' };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'add-commercial-entry: missing entry object' };
  if (!commercial || !commercial.shows) return { ok: false, reason: 'add-commercial-entry: commercial.json has no shows map' };

  const show = shows.find(s => s.slug === slug) || shows.find(s => s.id === slug);
  if (!show) return { ok: false, reason: `add-commercial-entry: "${slug}" is not a shows.json slug or id` };
  if (show.slug && show.slug !== slug) {
    return { ok: false, reason: `add-commercial-entry: "${slug}" is a show id; key by its slug "${show.slug}"` };
  }
  if (!isCommercialScope(show)) return { ok: false, reason: `add-commercial-entry: "${slug}" is ${show.category}, outside the Broadway commercial scope` };
  if (commercial.shows[slug] || commercial.shows[show.id]) {
    return { ok: false, reason: `add-commercial-entry: "${slug}" already has a commercial entry (use data-edit)` };
  }

  for (const k of Object.keys(entry)) {
    if (!ALLOWED.has(k)) return { ok: false, reason: `add-commercial-entry: field "${k}" not allowed` };
  }
  const designation = canonicalDesignation(entry.designation);
  if (!designation) return { ok: false, reason: `add-commercial-entry: unknown designation "${entry.designation}"` };

  const srcProblem = sourcesProblem(entry.sources);
  if (srcProblem) return { ok: false, reason: `add-commercial-entry: ${srcProblem}` };
  if (entry.recoupedDate != null && !RECOUPED_DATE_RE.test(entry.recoupedDate)) {
    return { ok: false, reason: 'add-commercial-entry: recoupedDate must be YYYY-MM or YYYY' };
  }
  if (WIN.has(designation)) {
    if (entry.recouped !== true || !entry.recoupedDate || !entry.recoupedSource) {
      return { ok: false, reason: `add-commercial-entry: "${designation}" needs recouped=true, recoupedDate and recoupedSource` };
    }
  }
  if (LOSS.has(designation) && entry.recouped !== false) {
    return { ok: false, reason: `add-commercial-entry: "${designation}" needs recouped=false` };
  }
  if (entry.recouped === true && (!entry.recoupedDate || !entry.recoupedSource)) {
    return { ok: false, reason: 'add-commercial-entry: recouped=true needs recoupedDate and recoupedSource' };
  }
  for (const k of ['capitalization', 'weeklyRunningCost']) {
    if (entry[k] != null && !(Number.isFinite(entry[k]) && entry[k] > 0)) {
      return { ok: false, reason: `add-commercial-entry: ${k} must be a positive number or null` };
    }
  }

  const record = {
    ...entry,
    designation,
    // Lock only a final, hand-checked outcome. humanReviewedDesignation makes
    // apply-commercial-pending.js skip the whole entry (including a later
    // trusted recoupment) and classify-stale-closure.js leave it alone, so a
    // TBD entry stays unlocked for the automation to finish.
    ...(designation === 'TBD' ? {} : { humanReviewedDesignation: true }),
    firstAdded: now,
    lastUpdated: now,
  };
  const ctx = { showRecord: show, allRecords: commercial.shows };
  const problems = [...commercialRecordErrors(slug, record, ctx), ...commercialRecordWarnings(slug, record, ctx)];
  if (problems.length) return { ok: false, reason: `add-commercial-entry: ${problems[0]}` };
  commercial.shows[slug] = record;
  return { ok: true, msg: `commercial.json: added ${slug} (${designation})` };
}

module.exports = { applyAddCommercialEntry, ALLOWED_ENTRY_FIELDS: ALLOWED };
