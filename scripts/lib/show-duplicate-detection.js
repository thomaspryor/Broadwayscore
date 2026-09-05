/**
 * show-duplicate-detection.js — detect TITLE-FRAGMENT duplicate show entries.
 *
 * This is the gap left by scripts/audit-duplicate-shows.js: that audit groups
 * candidates by `normalizeTitle|year`, so it can only compare shows that already
 * share a normalized title. Title-fragment dupes have DIFFERENT normalized titles
 * — one entry's title is a fragment of another's — so they never land in the same
 * group and slip through. Examples that shipped (2026-06 audit, handoff #3):
 *   - "Godot's To-Do List" inside a "Krapp's Last Tape / Godot's To-Do List" entry
 *   - "Hito no Chikara" inside the full "Yamato — The Drummers of Japan…" entry
 *
 * Rule: two entries at the SAME canonical venue with OVERLAPPING run dates where
 * one title's significant words are a STRICT SUBSET of the other's (on RAW tokens,
 * not normalized).
 *
 * FALSE-POSITIVE GUARDS (verified 0 hits on the live catalog):
 *   - Revivals share a title but differ in year ⇒ non-overlapping dates ⇒ excluded.
 *   - Repertory trilogies / multi-programme seasons (The Norman Conquests = 3
 *     plays; Alvin Ailey "New Works" vs "Legacy") are SIBLINGS — neither raw title
 *     is a subset of the other ⇒ excluded by the strict-subset test. (We compare
 *     RAW tokens, not normalizeTitle, which strips the distinguishing subtitle and
 *     would collapse the siblings together.)
 */

'use strict';

const { foldDiacritics } = require('./title-match');

function canonicalVenue(show) {
  return (show.venue || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ') // drop parentheticals e.g. "(Over 18s Only)"
    .replace(/\s+/g, ' ')
    .trim();
}

function runStart(show) {
  return show.previewsStartDate || show.openingDate || null;
}

function datesOverlap(a, b) {
  const as = runStart(a);
  const bs = runStart(b);
  if (!as || !bs) return false;
  const ae = a.closingDate || as;
  const be = b.closingDate || bs;
  return as <= be && bs <= ae;
}

function rawTitleTokens(show) {
  return new Set(
    foldDiacritics(show.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2),
  );
}

// True when one show's significant raw-title tokens are a STRICT subset of the
// other's (fragment relationship), not merely overlapping (siblings).
function isStrictTitleSubset(a, b) {
  const ta = rawTitleTokens(a);
  const tb = rawTitleTokens(b);
  if (ta.size < 2 || tb.size < 2 || ta.size === tb.size) return false;
  const [smaller, larger] = ta.size < tb.size ? [ta, tb] : [tb, ta];
  for (const t of smaller) if (!larger.has(t)) return false;
  return true;
}

/**
 * @param {Array<object>} shows - shows.json entries.
 * @returns {Array<{a:string, b:string, venue:string, reason:string}>}
 */
function findTitleFragmentDupes(shows) {
  const dupes = [];
  if (!Array.isArray(shows)) return dupes;
  for (let i = 0; i < shows.length; i++) {
    for (let j = i + 1; j < shows.length; j++) {
      const a = shows[i];
      const b = shows[j];
      const v = canonicalVenue(a);
      if (!v || v === 'tba' || v !== canonicalVenue(b)) continue;
      if (!datesOverlap(a, b)) continue;
      if (isStrictTitleSubset(a, b)) {
        dupes.push({
          a: a.id,
          b: b.id,
          venue: v,
          reason: `"${a.id}" and "${b.id}" share a venue + overlapping dates and one title is a fragment of the other`,
        });
      }
    }
  }
  return dupes;
}

/**
 * TICKETING-IDENTITY duplicate detection — the gap left by BOTH passes above.
 *
 * WHY THIS EXISTS. `amaze-off-broadway-2026` ("AMAZE") and
 * `amaze-magic-off-broadway-2025` ("AMAZE Magic") are the same Jamie Allan
 * production: same New World Stages venue, same closingDate 2027-01-31, same
 * 2h runtime, and the SAME TodayTix listing
 * (https://www.todaytix.com/nyc/shows/44453-amaze-magic). The duplicate split
 * the production's reviews across two pages — 7 of the 8 review-text files the
 * wrongProduction guard flagged under the 2026 entry are the same
 * critic+outlet pairs already sitting correctly under the 2025 entry.
 *
 * Every existing guard missed it, each for its own reason:
 *   - audit-duplicate-shows.js groups by `normalizeTitle|year`, and the 2026
 *     entry has NEITHER openingDate NOR previewsStartDate, so showYear() is
 *     null and the show is skipped before grouping. 191 of 528 non-closed
 *     shows (36%) are invisible to that audit for the same reason, and a
 *     dateless stub is precisely the shape most likely to BE a duplicate.
 *   - Even had it been grouped, normalizeTitle("AMAZE") is "amaze" and
 *     normalizeTitle("AMAZE Magic") is "amaze magic" — different keys.
 *   - findTitleFragmentDupes needs identical canonical venues ("new world
 *     stages" vs "new world stages – stage 5"), overlapping run dates (the
 *     2026 entry has no runStart at all) and >=2 raw title tokens on both
 *     sides ("AMAZE" has one). All three independently reject the pair.
 *
 * So this pass keys on something none of them use: the TICKETING PROVIDER'S
 * OWN SHOW ID. Two catalog entries pointing at one TodayTix listing are one
 * production — that identity comes from the ticket seller, not from our
 * inference over titles, venues and dates, which is exactly why it survives
 * where title/venue/date heuristics fail.
 *
 * PRECISION, measured on the live catalog 2026-09-05: 633 shows carry a
 * TodayTix identity and exactly ONE key is shared by two entries — the AMAZE
 * pair. Zero false positives, one true positive.
 *
 * FALSE-POSITIVE GUARD. A transfer pair (tryout -> commercial run, declared
 * with transferOf/transferredTo) is a deliberate TWO-entry relationship and
 * could legitimately reuse one ticketing listing, so explicitly cross-linked
 * pairs are excluded. No live pair needs this today — the 7 transferOf entries
 * share no ticket id — but the exclusion has to exist before one does, because
 * the alternative is an audit that fails on correct data.
 */

// Accepts both the numeric `todaytixId` field and an id embedded in any
// ticketLinks[].url / todaytixUrl, because the two are populated by different
// enrichment paths and a duplicate stub often carries only the URL: the AMAZE
// 2026 entry has NO todaytixId at all, only the ticketLinks URL. Reading one
// field alone would have missed the very pair this exists to catch.
const TODAYTIX_URL_ID = /todaytix\.com\/[^/]+\/shows\/(\d+)/i;

function ticketIdentityKeys(show) {
  const keys = new Set();
  if (!show || typeof show !== 'object') return keys;
  const id = show.todaytixId;
  if (id !== undefined && id !== null && String(id).trim() !== '') {
    keys.add(`todaytix:${String(id).trim()}`);
  }
  const urls = [show.todaytixUrl, ...(Array.isArray(show.ticketLinks) ? show.ticketLinks.map((t) => t && t.url) : [])];
  for (const u of urls) {
    if (!u) continue;
    const m = String(u).match(TODAYTIX_URL_ID);
    if (m) keys.add(`todaytix:${m[1]}`);
  }
  return keys;
}

// A declared transfer is a deliberate two-entry relationship, in either
// direction and from either side.
function isDeclaredTransferPair(a, b) {
  return a.transferOf === b.id || b.transferOf === a.id
    || a.transferredTo === b.id || b.transferredTo === a.id;
}

/**
 * @param {Array<object>} shows - shows.json entries.
 * @returns {Array<{a:string, b:string, key:string, reason:string}>}
 */
function findSharedTicketIdentityDupes(shows) {
  const dupes = [];
  if (!Array.isArray(shows)) return dupes;
  const byKey = new Map();
  for (const s of shows) {
    if (!s || !s.id) continue;
    for (const k of ticketIdentityKeys(s)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(s);
    }
  }
  // One pair per (unordered show pair), even when two entries share more than
  // one key — a duplicate that carries BOTH todaytixId and the same URL would
  // otherwise be reported twice, and the audit's baseline is keyed on the
  // unordered id pair, so a double report would also double-count as "new".
  const seen = new Set();
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (a.id === b.id) continue;
        if (isDeclaredTransferPair(a, b)) continue;
        const pairKey = [a.id, b.id].sort().join(' ');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        dupes.push({
          a: a.id,
          b: b.id,
          key,
          reason: `"${a.id}" and "${b.id}" resolve to the same ticketing listing (${key})`,
        });
      }
    }
  }
  return dupes;
}

module.exports = {
  findTitleFragmentDupes,
  findSharedTicketIdentityDupes,
  ticketIdentityKeys,
  canonicalVenue,
  isStrictTitleSubset,
  datesOverlap,
};
