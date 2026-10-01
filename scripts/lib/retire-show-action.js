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
 *     add) can be retired this way, or a duplicate named with `duplicateOf`
 *     (same title, same house as the kept row, zero reviews; id-only);
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

// Same building: normalized names equal, or one is the other plus only a
// generic building/room word ("Barbican" / "Barbican Centre"). Never a
// different house that merely starts the same ("Lyric" / "Lyric Hammersmith",
// "Park" / "Park Avenue Armory").
const HOUSE_WORDS = new Set(['centre', 'center', 'theatre', 'theater', 'main', 'house', 'studio', 'stage', 'hall']);
function sameHouse(a, b) {
  const ka = normalizeVenueName(a);
  const kb = normalizeVenueName(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (!long.startsWith(`${short} `)) return false;
  return long.slice(short.length).trim().split(/[\s-]+/).filter(Boolean).every(w => HOUSE_WORDS.has(w));
}

function isoOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// The duplicate's run sits inside the kept row's run: it starts no earlier
// than the kept run and the kept run has not closed before it starts. A
// later revival or return run at the same house fails this.
function sameRun(kept, row) {
  const keptStart = isoOrNull(kept.previewsStartDate) || isoOrNull(kept.openingDate);
  const keptEnd = isoOrNull(kept.closingDate);
  const rowStart = isoOrNull(row.previewsStartDate) || isoOrNull(row.openingDate);
  const rowEnd = isoOrNull(row.closingDate);
  if (!keptStart || !rowStart) return false;
  if (rowStart < keptStart) return false;
  if (keptEnd && rowStart > keptEnd) return false;
  if (keptEnd && rowEnd && rowEnd > keptEnd) return false;
  return true;
}

/**
 * Why `row` may NOT be retired as a duplicate of `duplicateOf`, or null when
 * it may: the kept row exists and is another row, the two share a title
 * (normalizeTitle) at the same house and market, the retired row's run sits
 * inside the kept row's run, and the retired row has no reviews (scored or
 * collected review texts).
 */
function duplicateRefusal(row, duplicateOf, shows, reviewCount) {
  if (typeof duplicateOf !== 'string' || !ID_RE.test(duplicateOf) || duplicateOf === row.id) return 'duplicateOf must name another show id';
  const kept = shows.find(s => s && s.id === duplicateOf);
  if (!kept) return `duplicateOf "${duplicateOf}" is not in shows.json`;
  if (normalizeTitle(kept.title) !== normalizeTitle(row.title)) return `title "${row.title}" does not match "${kept.title}"`;
  if (!sameHouse(kept.venue, row.venue)) return `venue "${row.venue}" is not the same house as "${kept.venue}"`;
  if ((kept.market || null) !== (row.market || null)) return `market ${row.market} differs from ${kept.market}`;
  if (!sameRun(kept, row)) return `run dates do not fall inside ${duplicateOf}'s run (a revival or return run is not a duplicate)`;
  if (typeof reviewCount !== 'function') return 'review count unavailable';
  const n = reviewCount(row.id);
  if (n !== 0) return `${row.id} has ${n} review(s): move them before retiring`;
  return null;
}

function applyRetireShow(shows, action, { retire, now, reviewCount } = {}) {
  const a = action || {};
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return { ok: false, reason: 'retire-show: id must be a lowercase-kebab show id' };
  if (typeof a.reason !== 'string' || !a.reason.trim()) return { ok: false, reason: `retire-show ${a.id}: a reason is required` };
  if (typeof a.expectTitle !== 'string' || !a.expectTitle) return { ok: false, reason: `retire-show ${a.id}: expectTitle is required (compare-and-set)` };
  if (a.blockTitleVenue !== undefined && typeof a.blockTitleVenue !== 'boolean') return { ok: false, reason: `retire-show ${a.id}: blockTitleVenue must be a boolean` };
  const idx = shows.findIndex(s => s && s.id === a.id);
  if (idx === -1) return { ok: false, reason: `retire-show: no show with id "${a.id}"` };
  const row = shows[idx];
  if (row.title !== a.expectTitle) return { ok: false, reason: `retire-show ${a.id}: title is "${row.title}", plan expected "${a.expectTitle}" — refused` };
  if (a.duplicateOf !== undefined) {
    // A non-automated row may go when it duplicates another row (same title,
    // same house) and has no reviews; it is retired id-only, never with a
    // title+venue block, since the kept row shares both.
    if (a.blockTitleVenue === true) return { ok: false, reason: `retire-show ${a.id}: a duplicate is retired id-only (blockTitleVenue would refuse the kept show's own listing)` };
    const why = duplicateRefusal(row, a.duplicateOf, shows, reviewCount);
    if (why) return { ok: false, reason: `retire-show ${a.id}: ${why}` };
  } else if (row.provisional !== true) {
    return { ok: false, reason: `retire-show ${a.id}: only provisional (automated, uncorroborated) rows can be retired by a plan, or a duplicate named with duplicateOf` };
  }
  const doRetire = typeof retire === 'function' ? retire : require('./retired-show-ids').retireId;
  try {
    doRetire(a.id, { reason: a.reason.trim(), archivedRow: row, blockTitleVenue: a.blockTitleVenue === true, ...(now ? { now } : {}) });
  } catch (e) {
    return { ok: false, reason: `retire-show ${a.id}: ${e.message}` };
  }
  shows.splice(idx, 1);
  return { ok: true, msg: `retired ${a.id} ("${row.title}" @ ${row.venue})${a.blockTitleVenue ? ' — title+venue blocked' : ''}` };
}

module.exports = { applyRetireShow };
