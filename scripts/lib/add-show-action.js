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

const REQUIRED = ['id', 'title', 'slug', 'venue', 'status', 'type', 'category', 'market'];
const ALLOWED = new Set([
  ...REQUIRED,
  'openingDate', 'closingDate', 'previewsStartDate', 'openingDateSource', 'isRevival',
  'tags', 'images', 'synopsis', 'theaterAddress', 'ticketLinks', 'cast', 'creativeTeam',
  'ibdbRevivalChecked', 'runtime', 'intermissions', 'ageRecommendation', 'discoverySource',
]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const STATUSES = ['upcoming', 'announced', 'previews', 'open', 'closed'];
const CATEGORIES = ['off-broadway', 'broadway', 'west-end', 'off-west-end'];

function applyAddShow(shows, action) {
  const show = action && action.show;
  if (!show || typeof show !== 'object') return { ok: false, reason: 'add-show: missing show object' };
  for (const f of REQUIRED) if (!show[f]) return { ok: false, reason: `add-show: missing required field "${f}"` };
  const extra = Object.keys(show).filter(k => !ALLOWED.has(k));
  if (extra.length) return { ok: false, reason: `add-show: fields not allowed: ${extra.join(', ')}` };
  if (!ID_RE.test(show.id) || !ID_RE.test(show.slug)) return { ok: false, reason: 'add-show: id/slug must be lowercase-kebab' };
  if (!STATUSES.includes(show.status)) return { ok: false, reason: `add-show: bad status "${show.status}"` };
  if (!CATEGORIES.includes(show.category)) return { ok: false, reason: `add-show: bad category "${show.category}"` };
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
  }

  const added = { ...show, venue: sanitizeVenueForWrite(show.venue), discoverySource: show.discoverySource || 'manual-user-request' };
  if (prior) {
    const run = { id: prior.id, venue: prior.venue, openingDate: prior.openingDate || null };
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
