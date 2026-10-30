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

const { sanitizeVenueForWrite, isBroadwayCategory } = require('./venue-classification');
const { MARKET_BEFORE_TOUR_RE } = require('./tour-family');
const { marketSuffixMismatch } = require('./show-id-market-suffix');

const REQUIRED = ['id', 'title', 'slug', 'venue', 'status', 'type', 'category', 'market'];
const ALLOWED = new Set([
  ...REQUIRED,
  'openingDate', 'closingDate', 'previewsStartDate', 'openingDateSource', 'isRevival',
  'tags', 'images', 'synopsis', 'theaterAddress', 'ticketLinks', 'cast', 'creativeTeam',
  'ibdbRevivalChecked', 'runtime', 'intermissions', 'ageRecommendation', 'discoverySource',
  'provisional', 'tourOf', 'tourScheduleSlug', 'tourLaunchEvidence', 'statusSource',
  'closingDateSource', 'closingDateUpdatedAt', 'discoveredAt', 'season', 'evidenceUrls',
  // BRO-4768: an earlier run of the same production (return engagement)
  'firstRunStart',
  // BRO-6515: metro slug from data/venue-metros.json (scripts/lib/venue-metro.js)
  'city',
  // BRO-6518: local (non-transfer) show, see scripts/lib/local-market.js
  'localOnly',
]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const STATUSES = ['upcoming', 'announced', 'previews', 'open', 'closed'];
const CATEGORIES = ['off-broadway', 'broadway', 'west-end', 'off-west-end', 'regional', 'tour'];
const TOUR_ONLY = ['tourOf', 'tourScheduleSlug', 'tourLaunchEvidence'];

// regional/tour entries have their own shape (feedback_regional_show_add_runbook,
// tour-entry.js buildTourEntry); validate-data.js blocks the build on a broken
// one, so refuse it here before CI writes it.
function marketShapeProblem(shows, show) {
  // The id is a live URL minted once: its market suffix must agree with the
  // category at write time, or tests/unit/show-id-market-suffix.test.mjs turns
  // main red after the row lands (BRO-6114, yentl-west-end-2026 as off-west-end).
  const idMismatch = marketSuffixMismatch(show);
  if (idMismatch) return `add-show: id "${show.id}" disagrees with category "${show.category}" (${idMismatch.reason})`;
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

const { findTitleFragmentDupes, findSharedTicketIdentityDupes } = require('./show-duplicate-detection');
const { findDuplicateShows, rowsSharingKey } = require('./shows-duplicate-rule');

const titleWords = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);

// The detectors are O(n^2); only rows sharing a title word or a ticket id with
// the new row can pair with it, so test that small neighbourhood.
function newRowDuplicate(shows, show, distinctFrom, { ticketOnly = false } = {}) {
  const ok = new Set(Array.isArray(distinctFrom) ? distinctFrom : []);
  const words = new Set(titleWords(show.title));
  const near = shows.filter(s => titleWords(s.title).some(w => words.has(w)));
  const pool = [{ ...show }, ...near];
  const hits = [...(ticketOnly ? [] : findTitleFragmentDupes(pool)), ...findSharedTicketIdentityDupes(pool)];
  for (const h of hits) {
    const other = h.a === show.id ? h.b : h.b === show.id ? h.a : null;
    if (other && !ok.has(other)) return { other, reason: h.reason || 'title-fragment' };
  }
  if (ticketOnly) return null;
  // The prebuild gate's rule (BRO-6578): the fragment detector skips an
  // identical title at the same venue, which the build then fails on. Declared
  // ids leave the pool first so they cannot mask an undeclared match.
  const rule = findDuplicateShows([...rowsSharingKey(shows.filter(s => !ok.has(s.id) && s.id !== show.id), show), { ...show }]);
  const f = rule.find(x => x.show.id === show.id);
  if (f) return { other: f.existing.id, reason: f.reason };
  return null;
}

function applyAddShow(shows, action, { isRetired } = {}) {
  const show = action && action.show;
  if (!show || typeof show !== 'object') return { ok: false, reason: 'add-show: missing show object' };
  // A Broadway production announced before its theater is booked has no venue yet
  // (dreamgirls, private-lives exist this way); every other shape needs one.
  const venueTbd = show.venue === null && show.status === 'announced' && isBroadwayCategory(show);
  for (const f of REQUIRED) if (!show[f] && !(f === 'venue' && venueTbd)) return { ok: false, reason: `add-show: missing required field "${f}"` };
  const extra = Object.keys(show).filter(k => !ALLOWED.has(k));
  if (extra.length) return { ok: false, reason: `add-show: fields not allowed: ${extra.join(', ')}` };
  if (!ID_RE.test(show.id) || !ID_RE.test(show.slug)) return { ok: false, reason: 'add-show: id/slug must be lowercase-kebab' };
  if (show.city != null && !ID_RE.test(show.city)) return { ok: false, reason: `add-show: city "${show.city}" must be a metro slug (scripts/lib/venue-metro.js)` };
  if (!STATUSES.includes(show.status)) return { ok: false, reason: `add-show: bad status "${show.status}"` };
  if (!CATEGORIES.includes(show.category)) return { ok: false, reason: `add-show: bad category "${show.category}"` };
  const shape = marketShapeProblem(shows, show);
  if (shape) return { ok: false, reason: shape };
  if (!venueTbd && sanitizeVenueForWrite(show.venue) === null) return { ok: false, reason: `add-show: venue "${show.venue}" is a placeholder` };
  if (shows.some(s => s.id === show.id)) return { ok: false, reason: `add-show: id "${show.id}" already exists` };
  // A retired id comes back only after an explicit unretire (BRO-5557: promoters re-minted retired rows).
  const retired = typeof isRetired === 'function' ? isRetired(show.id) : require('./retired-show-ids').isRetiredId(show.id);
  if (retired) return { ok: false, reason: `add-show: id "${show.id}" is in the retired-show registry (data/retired-show-ids.json); unretire it first if this is a deliberate re-add` };
  if (shows.some(s => s.slug === show.slug)) return { ok: false, reason: `add-show: slug "${show.slug}" already exists` };

  // Write-time duplicate gate (BRO-5789): audit-duplicate-shows.js found these
  // pairs only after the row shipped. Same detectors, run for the new row only.
  // An owner-confirmed distinct production lists the other id in
  // action.distinctFrom.
  // A declared priorRunOf / crossLinkFrom link is an explicit statement that the
  // other row is a related but separate run, so those ids are exempt too.
  const declared = [].concat(action.distinctFrom || [], action.priorRunOf || [], action.crossLinkFrom || []);
  const dup = newRowDuplicate(shows, show, declared);
  if (dup) return { ok: false, reason: `add-show: "${show.id}" duplicates existing "${dup.other}" (${dup.reason}); if it is a genuinely distinct production list "${dup.other}" in the action's distinctFrom` };

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

  const added = { ...show, venue: venueTbd ? null : sanitizeVenueForWrite(show.venue), discoverySource: show.discoverySource || 'manual-user-request' };
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
      run.venue = venueTbd ? null : sanitizeVenueForWrite(show.venue);
      from.priorRuns.push(run);
    }
  }
  return { ok: true, msg: `shows.json: added ${show.id}${from ? ` (priorRuns link on ${from.id})` : ''}${prior ? ` (priorRuns -> ${prior.id})` : ''}` };
}

module.exports = { applyAddShow, newRowDuplicate };
