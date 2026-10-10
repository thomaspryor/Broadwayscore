/**
 * add-show — the "create one shows.json entry" action for execute-approved-fix.js.
 *
 * Cloud sessions cannot push the private core-data repo (sessions never push
 * main), and data-edit only edits existing shows. A plan may now carry
 * { type: 'add-show', show: {...}, crossLinkFrom?: '<existing show id>' } and CI
 * applies it. Pure (no I/O): takes the shows array, mutates it, returns a result.
 *
 * Guardrails: id/slug shape, required fields, refuses an existing id or slug,
 * a fixed field allowlist, and stamps discoverySource so the entry is auditable
 * (validate-show-venue.js treats manual-user-request as provisional).
 */

const { sanitizeVenueForWrite } = require('./venue-classification');
const { MARKET_BEFORE_TOUR_RE } = require('./tour-family');

const REQUIRED = ['id', 'title', 'slug', 'venue', 'status', 'type', 'category', 'market'];
const ALLOWED = new Set([
  ...REQUIRED,
  'openingDate', 'closingDate', 'previewsStartDate', 'openingDateSource', 'isRevival',
  'tags', 'images', 'synopsis', 'theaterAddress', 'ticketLinks', 'cast', 'creativeTeam',
  'ibdbRevivalChecked', 'runtime', 'intermissions', 'ageRecommendation', 'discoverySource',
  'provisional', 'tourOf', 'tourScheduleSlug', 'tourLaunchEvidence', 'statusSource',
  'closingDateSource', 'closingDateUpdatedAt', 'discoveredAt',
]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const STATUSES = ['upcoming', 'announced', 'previews', 'open', 'closed'];
const CATEGORIES = ['off-broadway', 'broadway', 'west-end', 'off-west-end', 'regional', 'tour'];
const TOUR_ONLY = ['tourOf', 'tourScheduleSlug', 'tourLaunchEvidence'];

// regional/tour entries have their own shape (feedback_regional_show_add_runbook,
// tour-entry.js buildTourEntry); validate-data.js blocks the build on a broken
// one, so refuse it here before CI writes it.
function marketShapeProblem(shows, show) {
  if (show.category !== 'tour' && TOUR_ONLY.some(f => show[f] !== undefined)) {
    return `add-show: ${TOUR_ONLY.join('/')} only belong on category "tour"`;
  }
  if ((show.market === 'regional' || show.market === 'tour') && show.category !== show.market) {
    return `add-show: market "${show.market}" needs category "${show.market}"`;
  }
  if (show.category === 'regional') {
    if (show.market !== 'regional') return 'add-show: category "regional" needs market "regional"';
    if (!/-regional(-|$)/.test(show.id)) return 'add-show: regional id must contain "-regional"';
    // "Theater, City, ST" (US) or "Theater, Town" (UK feeder venues).
    if (!/^[^,]+,\s*[^,]+/.test(show.venue)) return `add-show: regional venue "${show.venue}" must read "Theater, City, ST"`;
  }
  if (show.category === 'tour') {
    if (show.market !== 'tour') return 'add-show: category "tour" needs market "tour"';
    if (!/-tour-\d{4}$/.test(show.id)) return 'add-show: tour id must end "-tour-<year>"';
    // The market belongs to the parent, not the tour: mexodus-off-broadway-2026
    // tours as mexodus-tour-2026 (review-guards.js isLikelyTourReview keys on
    // the plain shape).
    if (MARKET_BEFORE_TOUR_RE.test(show.id)) return 'add-show: tour id must not carry a market ("-off-broadway-tour-<year>"); use "<base>-tour-<year>"';
    if (show.venue !== 'North American Tour') return 'add-show: tour venue must be "North American Tour"';
    // tourOf is optional (BRO-4931): a tour of an Off-Broadway, regional or West
    // End show names it; a standalone touring show omits it (never null) and is
    // anchored by its Tours To You page instead.
    if (show.tourOf === null || show.tourOf === '') return 'add-show: omit tourOf for a standalone tour, never set it empty';
    if (show.tourOf === undefined) {
      if (!show.tourScheduleSlug) return 'add-show: a standalone tour (no tourOf) needs tourScheduleSlug';
    } else {
      const parent = shows.find(s => s.id === show.tourOf);
      if (!parent) return `add-show: tourOf "${show.tourOf}" not found`;
      if (parent.category === 'tour') return `add-show: tourOf "${show.tourOf}" is itself a tour; name the production it tours`;
    }
  }
  return null;
}

function applyAddShow(shows, action) {
  const show = action && action.show;
  if (!show || typeof show !== 'object') return { ok: false, reason: 'add-show: missing show object' };
  for (const f of REQUIRED) if (!show[f]) return { ok: false, reason: `add-show: missing required field "${f}"` };
  const extra = Object.keys(show).filter(k => !ALLOWED.has(k));
  if (extra.length) return { ok: false, reason: `add-show: fields not allowed: ${extra.join(', ')}` };
  if (!ID_RE.test(show.id) || !ID_RE.test(show.slug)) return { ok: false, reason: 'add-show: id/slug must be lowercase-kebab' };
  if (!STATUSES.includes(show.status)) return { ok: false, reason: `add-show: bad status "${show.status}"` };
  if (!CATEGORIES.includes(show.category)) return { ok: false, reason: `add-show: bad category "${show.category}"` };
  const shape = marketShapeProblem(shows, show);
  if (shape) return { ok: false, reason: shape };
  if (sanitizeVenueForWrite(show.venue) === null) return { ok: false, reason: `add-show: venue "${show.venue}" is a placeholder` };
  if (shows.some(s => s.id === show.id)) return { ok: false, reason: `add-show: id "${show.id}" already exists` };
  if (shows.some(s => s.slug === show.slug)) return { ok: false, reason: `add-show: slug "${show.slug}" already exists` };

  let from = null;
  if (action.crossLinkFrom) {
    from = shows.find(s => s.id === action.crossLinkFrom);
    if (!from) return { ok: false, reason: `add-show: crossLinkFrom "${action.crossLinkFrom}" not found` };
    if (!show.openingDate) return { ok: false, reason: 'add-show: crossLinkFrom needs show.openingDate' };
  }
  // priorRunOf: the reverse link, for a return engagement added after the
  // original run (lost-in-del-valle-return-off-broadway-2026 shape): the NEW
  // entry carries priorRuns pointing at the existing earlier run.
  let prior = null;
  if (action.priorRunOf) {
    prior = shows.find(s => s.id === action.priorRunOf);
    if (!prior) return { ok: false, reason: `add-show: priorRunOf "${action.priorRunOf}" not found` };
    // PriorRun.openingDate is required (src/types/show.ts); a null one is
    // silently skipped by findMatchingPriorRun, same reason crossLinkFrom
    // refuses a dateless show.
    if (!prior.openingDate) return { ok: false, reason: `add-show: priorRunOf "${action.priorRunOf}" has no openingDate` };
  }

  const added = { ...show, venue: sanitizeVenueForWrite(show.venue), discoverySource: show.discoverySource || 'manual-user-request' };
  if (prior) {
    const run = { id: prior.id, venue: sanitizeVenueForWrite(prior.venue), openingDate: prior.openingDate || null };
    if (prior.closingDate) run.closingDate = prior.closingDate;
    added.priorRuns = [run];
  }
  shows.push(added);
  if (from) {
    from.priorRuns = from.priorRuns || [];
    if (!from.priorRuns.some(r => r.id === show.id)) {
      const run = { id: show.id, openingDate: show.openingDate };
      if (show.closingDate) run.closingDate = show.closingDate;
      run.venue = sanitizeVenueForWrite(show.venue);
      from.priorRuns.push(run);
    }
  }
  return { ok: true, msg: `shows.json: added ${show.id}${from ? ` (priorRuns link on ${from.id})` : ''}${prior ? ` (priorRuns -> ${prior.id})` : ''}` };
}

module.exports = { applyAddShow };
