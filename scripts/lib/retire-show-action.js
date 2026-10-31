/**
 * retire-show — the "delete one junk shows.json entry" action for
 * execute-approved-fix.js (BRO-4398).
 *
 * Cloud sessions cannot push the private core-data repo, and until now no
 * plan action could remove a row: the 2026-09-30 Off-West End promotion
 * wrote Kiln cinema screenings and a one-off concert that only a Mac session
 * could take out. A plan may now carry
 *   { type: 'retire-show', id, expectTitle, reason, blockTitleVenue?, duplicateOf? }
 * and CI applies it. Pure apart from the injected `retire` (default:
 * lib/retired-show-ids.js retireId, which appends the registry entry and
 * archives the full row in data/deleted-shows.json, so discovery, the
 * push-core-data reconciliation and validate-data all keep it out).
 *
 * Guardrails:
 *   - `expectTitle` must equal the row's title (compare-and-set: a wrong id
 *     in a plan refuses instead of deleting another show);
 *   - only a `provisional: true` row (an automated, not-yet-corroborated
 *     add; zero reviews, BRO-5897) can be retired this way, or a duplicate named with `duplicateOf`
 *     (same title, same house as the kept row, zero reviews; id-only; a
 *     differently-titled listing of the same run also needs `evidenceUrl`
 *     and the same closing date, BRO-5706), or a
 *     non-production named with `nonProduction` (BRO-4449/BRO-4505: a film
 *     screening, one-night concert or stand-up set minted before the dated
 *     venue readers existed): still announced/upcoming, never dated as
 *     opened, zero reviews, and `evidenceUrl` cites the venue listing;
 *   - `reason` is required (the registry breadcrumb);
 *   - `blockTitleVenue: true` for junk that must never return under any id;
 *     leave it off for a duplicate (the kept row shares title+venue).
 * The registry entry is written before the row is spliced out, so a failure
 * part-way leaves the row in place (validate-data warns) rather than a
 * deleted row the next push could resurrect.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const { normalizeVenueName } = require('./venue-classification');
const { normalizeTitle } = require('./title-match');
const { isStrictTitleSubset, findSharedTicketIdentityDupes } = require('./show-duplicate-detection');

// Same building: normalized names equal, or one is the other plus only a
// generic building/room word ("Barbican" / "Barbican Centre"). Never a
// different house that merely starts the same ("Lyric" / "Lyric Hammersmith",
// "Park" / "Park Avenue Armory").
const HOUSE_WORDS = new Set(['centre', 'center', 'theatre', 'theater', 'main', 'house', 'studio', 'stage', 'hall']);
// "Marjorie S. Deane Little Theater @ The West Side Y" names the building the room
// sits in, and a leading "the" is formatting (BRO-6481), as in show-duplicate-detection.
function houseKey(v) {
  return normalizeVenueName(String(v || '').replace(/\s*@.*$/, '').replace(/^\s*the\s+/i, ''));
}
function sameHouse(a, b) {
  const ka = houseKey(a);
  const kb = houseKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (!long.startsWith(`${short} `)) return false;
  // A single-letter room tail is a room of the same house ("59E59 Theaters Theater B").
  return long.slice(short.length).trim().split(/[\s-]+/).filter(Boolean).every(w => HOUSE_WORDS.has(w) || /^[a-z]$/.test(w));
}

const NON_PRODUCTION_STATUSES = new Set(['announced', 'upcoming']);

function isoOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// The duplicate's run sits inside the kept row's run: it starts no earlier
// than the kept run and the kept run has not closed before it starts. A
// later revival or return run at the same house fails this.
function sameRun(kept, row, ticketDup) {
  const keptStart = isoOrNull(kept.previewsStartDate) || isoOrNull(kept.openingDate);
  const keptEnd = isoOrNull(kept.closingDate);
  const rowStart = isoOrNull(row.previewsStartDate) || isoOrNull(row.openingDate);
  const rowEnd = isoOrNull(row.closingDate);
  // BRO-5797: an undated stub that resolves to the kept row's ticketing listing
  // (the daily shared-ticket-identity audit's pair) has no run of its own to
  // compare; it is inside the kept run when it does not outlast it.
  // Guards: both runs still live, the stub states a closing date, and it is not an announced return run.
  if (!rowStart && ticketDup && keptStart) {
    if (kept.status === 'closed' || row.status === 'closed' || row.status === 'announced' || row.status === 'upcoming') return false;
    return !!(keptEnd && rowEnd && rowEnd <= keptEnd);
  }
  if (!keptStart || !rowStart) return false;
  if (rowStart < keptStart) return false;
  if (keptEnd && rowStart > keptEnd) return false;
  if (keptEnd && rowEnd && rowEnd > keptEnd) return false;
  return true;
}

/**
 * Why `row` may NOT be retired as a duplicate of `duplicateOf`, or null when
 * it may: the kept row exists and is another row, the two share a title
 * (normalizeTitle, or one title is the other's strict subset, e.g. "860" vs
 * "Billy Crystal 860") at the same house and market, the retired row's run sits
 * inside the kept row's run, and the retired row has no reviews (scored or
 * collected review texts).
 */
// BRO-5706: a stray listing of a run under a different title ("Angel Bones - English
// National Opera" vs "Angel's Bone"). Accepted only with an https evidenceUrl (the venue
// listing) and: undated announced/upcoming stray, kept row open and dated, identical
// closing date. House, market and zero reviews are checked by the caller.
// House and company words ("English National Opera", "Theatre", "Live") say where a
// show plays, not which show it is, so they never count as a shared title word.
const GENERIC_TITLE_WORDS = new Set(['opera', 'national', 'english', 'royal', 'theatre', 'theater', 'company', 'live', 'gala', 'concert', 'special', 'musical', 'show', 'london', 'west', 'broadway', 'with', 'from', 'that', 'this', 'tour']);

function titleStems(t) {
  return new Set(normalizeTitle(t).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !GENERIC_TITLE_WORDS.has(w)).map(w => w.replace(/s$/, '')));
}

function evidenceDuplicate(kept, row, evidenceUrl) {
  if (typeof evidenceUrl !== 'string' || !/^https:\/\/[^\s/]+\.[^\s]+$/.test(evidenceUrl)) return false;
  if (!NON_PRODUCTION_STATUSES.has(row.status) || isoOrNull(row.openingDate) || isoOrNull(row.previewsStartDate)) return false;
  if (kept.status !== 'open' || !isoOrNull(kept.openingDate)) return false;
  if (!isoOrNull(row.closingDate) || row.closingDate !== kept.closingDate) return false;
  // Rep houses close several productions on one date: the titles must still share a word.
  const kw = titleStems(kept.title);
  return [...titleStems(row.title)].some(w => kw.has(w));
}

function duplicateRefusal(row, duplicateOf, shows, reviewCount, evidenceUrl) {
  if (typeof duplicateOf !== 'string' || !ID_RE.test(duplicateOf) || duplicateOf === row.id) return 'duplicateOf must name another show id';
  const kept = shows.find(s => s && s.id === duplicateOf);
  if (!kept) return `duplicateOf "${duplicateOf}" is not in shows.json`;
  // A shared ticketing listing with agreeing titles ("AMAZE" vs "AMAZE Magic") is the
  // audit's own proof of one production, so a single-word prefix title is accepted too.
  const ticketDup = findSharedTicketIdentityDupes([kept, row]).length > 0;
  const evidenceDup = evidenceDuplicate(kept, row, evidenceUrl);
  if (normalizeTitle(kept.title) !== normalizeTitle(row.title) && !isStrictTitleSubset(kept, row) && !ticketDup && !evidenceDup) return `title "${row.title}" does not match "${kept.title}"`;
  if (!sameHouse(kept.venue, row.venue)) return `venue "${row.venue}" is not the same house as "${kept.venue}"`;
  if ((kept.market || null) !== (row.market || null)) return `market ${row.market} differs from ${kept.market}`;
  if (!evidenceDup && !sameRun(kept, row, ticketDup)) return `run dates do not fall inside ${duplicateOf}'s run (a revival or return run is not a duplicate)`;
  if (typeof reviewCount !== 'function') return 'review count unavailable';
  const n = reviewCount(row.id);
  if (n !== 0) return `${row.id} has ${n} review(s): move them before retiring`;
  return null;
}

/**
 * Why `row` may NOT be retired as a non-production, or null when it may. A
 * row that has opened or carries any review is a real run; those go through
 * a human Mac session, never a plan.
 */
function nonProductionRefusal(row, action, reviewCount, now) {
  if (action.duplicateOf !== undefined) return 'nonProduction and duplicateOf are exclusive';
  if (typeof action.evidenceUrl !== 'string' || !/^https:\/\/[^\s/]+\.[^\s]+$/.test(action.evidenceUrl)) return 'nonProduction needs evidenceUrl (https link to the venue listing that shows it is not a production)';
  if (!NON_PRODUCTION_STATUSES.has(row.status)) return `status is "${row.status}": only an announced/upcoming row can be retired as a non-production`;
  // `outOfTier: true` (BRO-6531): an out-of-tier listing (Off-Off-Broadway) carries a scheduled
  // opening date from its source. It may go while that date is still ahead; one that has
  // opened is a real run either way.
  const opening = isoOrNull(row.openingDate);
  if (opening) {
    const today = (now instanceof Date ? now : now ? new Date(now) : new Date()).toISOString().slice(0, 10);
    if (action.outOfTier !== true || opening <= today) return `openingDate ${row.openingDate} is set: a row dated as opened is a real run`;
  }
  if (action.outOfTier !== undefined && action.outOfTier !== true) return 'outOfTier must be true when present';
  if (typeof reviewCount !== 'function') return 'review count unavailable';
  const n = reviewCount(row.id);
  if (n !== 0) return `${row.id} has ${n} review(s): move them before retiring`;
  return null;
}

function applyRetireShow(shows, action, { retire, now, reviewCount, isRetired } = {}) {
  const a = action || {};
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return { ok: false, reason: 'retire-show: id must be a lowercase-kebab show id' };
  if (typeof a.reason !== 'string' || !a.reason.trim()) return { ok: false, reason: `retire-show ${a.id}: a reason is required` };
  if (typeof a.expectTitle !== 'string' || !a.expectTitle) return { ok: false, reason: `retire-show ${a.id}: expectTitle is required (compare-and-set)` };
  if (a.blockTitleVenue !== undefined && typeof a.blockTitleVenue !== 'boolean') return { ok: false, reason: `retire-show ${a.id}: blockTitleVenue must be a boolean` };
  const idx = shows.findIndex(s => s && s.id === a.id);
  if (idx === -1) return { ok: false, reason: `retire-show: no show with id "${a.id}"` };
  const row = shows[idx];
  if (row.title !== a.expectTitle) return { ok: false, reason: `retire-show ${a.id}: title is "${row.title}", plan expected "${a.expectTitle}" — refused` };
  if (a.nonProduction !== undefined && a.nonProduction !== true) return { ok: false, reason: `retire-show ${a.id}: nonProduction must be true when present` };
  if (a.nonProduction === true) {
    const why = nonProductionRefusal(row, a, reviewCount, now);
    if (why) return { ok: false, reason: `retire-show ${a.id}: ${why}` };
  } else if (a.duplicateOf !== undefined) {
    // A non-automated row may go when it duplicates another row (same title,
    // same house) and has no reviews; it is retired id-only, never with a
    // title+venue block, since the kept row shares both.
    if (a.blockTitleVenue === true) return { ok: false, reason: `retire-show ${a.id}: a duplicate is retired id-only (blockTitleVenue would refuse the kept show's own listing)` };
    const why = duplicateRefusal(row, a.duplicateOf, shows, reviewCount, a.evidenceUrl);
    if (why) return { ok: false, reason: `retire-show ${a.id}: ${why}` };
  } else if (row.provisional !== true) {
    return { ok: false, reason: `retire-show ${a.id}: only provisional (automated, uncorroborated) rows can be retired by a plan, a duplicate named with duplicateOf, or a non-production named with nonProduction + evidenceUrl` };
  } else {
    // BRO-5897: a provisional row's collected reviews were stranded in a retired folder (ANON's
    // NYT + Vulture sat 5 days off every show page), so this path counts them like the others.
    if (typeof reviewCount !== 'function') return { ok: false, reason: `retire-show ${a.id}: review count unavailable` };
    const n = reviewCount(row.id);
    if (n !== 0) return { ok: false, reason: `retire-show ${a.id}: ${row.id} has ${n} review(s): move or delete them (review-file-op, then a rebuild if they were scored) before retiring` };
  }
  // A row whose id the registry already holds was re-minted after its retirement (the
  // venue-page promoter ignored the registry until BRO-5557). `reMinted: true` removes just
  // the row; the registry entry and archive from the first retirement stay as they are.
  if (a.reMinted !== undefined && a.reMinted !== true) return { ok: false, reason: `retire-show ${a.id}: reMinted must be true when present` };
  if (a.reMinted === true) {
    if (a.blockTitleVenue === true) return { ok: false, reason: `retire-show ${a.id}: reMinted removes only the row; blockTitleVenue needs a fresh retirement` };
    const registry = require('./retired-show-ids');
    const held = typeof isRetired === 'function' ? isRetired(a.id) : registry.isRetiredId(a.id);
    if (!held) return { ok: false, reason: `retire-show ${a.id}: reMinted names an id the retired registry does not hold` };
    shows.splice(idx, 1);
    return { ok: true, msg: `removed re-minted ${a.id} ("${row.title}" @ ${row.venue}); the registry already held the id` };
  }
  const doRetire = typeof retire === 'function' ? retire : require('./retired-show-ids').retireId;
  try {
    doRetire(a.id, { reason: (a.nonProduction === true || (a.duplicateOf !== undefined && a.evidenceUrl)) ? `${a.reason.trim()} (evidence: ${a.evidenceUrl})` : a.reason.trim(), archivedRow: row, blockTitleVenue: a.blockTitleVenue === true, ...(now ? { now } : {}) });
  } catch (e) {
    return { ok: false, reason: `retire-show ${a.id}: ${e.message}` };
  }
  shows.splice(idx, 1);
  // A merged duplicate keeps its old URLs reachable: build-slug-redirects.js turns the
  // kept row's `aliases` into permanent redirects to its slug (BRO-5797).
  if (a.duplicateOf !== undefined) {
    const kept = shows.find(s => s && s.id === a.duplicateOf);
    const add = [row.id, row.slug].filter(x => x && x !== kept.id && x !== kept.slug);
    if (add.length) kept.aliases = [...new Set([...(Array.isArray(kept.aliases) ? kept.aliases : []), ...add])];
  }
  return { ok: true, msg: `retired ${a.id} ("${row.title}" @ ${row.venue})${a.blockTitleVenue ? ' — title+venue blocked' : ''}` };
}

module.exports = { applyRetireShow };
