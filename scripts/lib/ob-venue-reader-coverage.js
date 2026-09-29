'use strict';

/**
 * Off-Broadway venue reader coverage (BRO-4396).
 *
 * Owner question 2026-09-29: "Can't we do it based on venues? There is a
 * finite number." data/off-broadway-venues.json knew 163 venues while
 * OB_VENUE_CONFIGS read 12 of them, and nothing said so: every show BRO-4377
 * had to add by hand played a venue with no listings reader. This measures
 * it per venue and names the ACTIVE ones (an Off-Broadway show in the last
 * 12 months) that have no reader, so a new busy venue surfaces on its own
 * instead of through missing shows.
 *
 * Pure: callers pass shows + reader configs. check-off-broadway-source-
 * coverage.js runs it daily (update-show-status.yml) and alerts on newly
 * uncovered venues.
 */

const { normalizeVenueName, isKnownOffBroadwayVenue } = require('./venue-classification');
const { foldDiacritics } = require('./title-match');
// venue-write-guard-ok: report rows and an alert ledger, never a shows.json write.

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_DAYS = 365;
const LIVE_STATUSES = new Set(['open', 'previews', 'upcoming']);

// Venues read by something other than OB_VENUE_CONFIGS.
const OTHER_VENUE_READERS = [
  { key: 'metropolitan opera house', reader: 'scripts/discover-opera-shows.js' },
];

// Active venues checked on 2026-09-29 (BRO-4396) that no reader can read
// today, with why. Reported, not alerted: the alert is for venues nobody has
// looked at yet. Keyed by a whole-word fragment of the venue key.
const NO_READER_REASONS = [
  ['shed', 'queue-it bot wall on theshed.org/program; needs a real browser'],
  ['amt', 'sells through Ludus behind a Cloudflare JS challenge; the Wix site lists shows as free text'],
  ['555', 'Wix pages are image-only; tickets are a VenueTix single-page app'],
  ['urban stages', 'site lists readings and a music festival, no production listing'],
  ['cell', 'Tickettailor listing says "Multiple dates"; run dates only on per-event pages'],
  ['culture club', 'no public listing found'],
  ['peter jay sharp', 'name shared by Playwrights Horizons (read) and Symphony Space'],
  ['tiny baby blackbox', 'Wix events widget returns only the next ~8 dates'],
  ["st luke s", 'stlukestheatre.com says the venue closed in January 2021'],
  ['theaterlab', 'site returns an empty page to a plain fetch'],
];

function noReaderReason(key) {
  const hit = NO_READER_REASONS.find(([frag]) => ` ${key} `.includes(` ${frag} `));
  return hit ? hit[1] : null;
}

// Words too generic to identify a venue on their own ("the center").
const GENERIC_WORDS = new Set(['theater', 'theatre', 'theaters', 'theatres', 'center', 'centre', 'stage', 'studio', 'hall', 'nyc', 'new', 'york', 'the', 'at', 'space', 'room']);

function venueKey(name) {
  return foldDiacritics(normalizeVenueName(String(name || '')))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDistinctive(key) {
  return key.split(' ').some(w => w && !GENERIC_WORDS.has(w));
}

/**
 * Keys a reader config covers: its own name plus any `coversVenues` aliases
 * (a company's other rooms, e.g. Signature → Pershing Square Signature
 * Center).
 */
function readerKeys(configs) {
  const keys = [];
  for (const c of configs || []) {
    // coverageExact: a reader that reads only some rooms of a house (Theatre
    // Row's NYTG pages cover Theatres Three and Four) lists them, and only
    // those exact venue strings count as covered.
    if (Array.isArray(c.coverageExact)) {
      for (const n of c.coverageExact) {
        const k = venueKey(n);
        if (k) keys.push({ key: k, reader: c.name, exactOnly: true });
      }
      continue;
    }
    for (const n of [c.name, ...(c.coversVenues || [])]) {
      const k = venueKey(n);
      // A name made only of generic words ("The Theater Center") matches
      // exactly, never as a substring.
      if (k) keys.push({ key: k, reader: c.name, exactOnly: !isDistinctive(k) });
    }
  }
  for (const o of OTHER_VENUE_READERS) keys.push({ key: o.key, reader: o.reader });
  return keys;
}

/** Which reader covers this venue string, or null. Whole-word containment either way. */
function findReaderFor(venue, keys) {
  const v = venueKey(venue);
  if (!v) return null;
  for (const { key, reader, exactOnly } of keys) {
    if (v === key) return reader;
    if (exactOnly) continue;
    if (` ${v} `.includes(` ${key} `)) return reader;
    if (isDistinctive(v) && ` ${key} `.includes(` ${v} `)) return reader;
  }
  return null;
}

function latestDate(show) {
  return [show.closingDate, show.openingDate, show.previewsStartDate, show.unconfirmedStartDate]
    .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort()
    .pop() || null;
}

/**
 * @param {{shows: object[], configs: object[], todayIso?: string,
 *   isKnownVenue?: (v: string) => boolean}} input
 * @returns {{ venues: object[], active: number, activeCovered: number, uncovered: object[] }}
 *   venues: one row per venue string seen on an OB show, with its reader
 *   uncovered: the ACTIVE venues with no reader, busiest first
 */
function computeVenueReaderCoverage({ shows, configs, todayIso = new Date().toISOString().slice(0, 10), isKnownVenue = isKnownOffBroadwayVenue }) {
  const keys = readerKeys(configs);
  const cutoff = new Date(Date.parse(`${todayIso}T00:00:00Z`) - ACTIVE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const byVenue = new Map();
  for (const s of shows || []) {
    if (!s || s.category !== 'off-broadway' || !s.venue || s.venue === 'TBA') continue;
    const k = venueKey(s.venue);
    if (!k) continue;
    let row = byVenue.get(k);
    if (!row) {
      row = { venue: s.venue.trim(), key: k, known: false, reader: findReaderFor(s.venue, keys), recentShows: 0, lastShow: null, lastDate: null };
      byVenue.set(k, row);
    }
    let known = false;
    try { known = isKnownVenue(s.venue); } catch { known = false; }
    row.known = row.known || known;
    const last = latestDate(s);
    const recent = LIVE_STATUSES.has(s.status) || (last && last >= cutoff);
    if (recent) row.recentShows++;
    if (last && (!row.lastDate || last > row.lastDate)) { row.lastDate = last; row.lastShow = s.id; }
  }
  const venues = [...byVenue.values()].filter(r => r.known).sort((a, b) => b.recentShows - a.recentShows || a.key.localeCompare(b.key));
  const active = venues.filter(r => r.recentShows > 0);
  const uncovered = groupRooms(active.filter(r => !r.reader));
  return { venues, active: active.length, activeCovered: active.filter(r => r.reader).length, uncovered };
}

/**
 * Fold rooms of one house into one row ("The Griffin Theater at The Shed"
 * into "The Shed") so the ranking counts the house, not each spelling.
 */
function groupRooms(rows) {
  const sorted = [...rows].sort((a, b) => a.key.split(' ').length - b.key.split(' ').length || a.key.localeCompare(b.key));
  const groups = [];
  for (const r of sorted) {
    const parent = groups.find(g => isDistinctive(g.key) && ` ${r.key} `.includes(` ${g.key} `));
    if (parent) {
      parent.recentShows += r.recentShows;
      parent.spellings.push(r.venue);
      if (r.lastDate && (!parent.lastDate || r.lastDate > parent.lastDate)) { parent.lastDate = r.lastDate; parent.lastShow = r.lastShow; }
    } else {
      groups.push({ ...r, spellings: [r.venue], noReaderReason: noReaderReason(r.key) });
    }
  }
  return groups.sort((a, b) => b.recentShows - a.recentShows || a.key.localeCompare(b.key));
}

/**
 * Newly uncovered venues since the last run, and the next ledger. A venue
 * alerts once when it first shows up uncovered; it re-alerts only after it
 * was covered in between.
 * @param {Object<string, {firstSeen: string}>} prevLedger
 * @param {object[]} uncovered
 * @param {string} nowIso
 */
function diffUncovered(prevLedger, uncovered, nowIso) {
  const ledger = {};
  const fresh = [];
  for (const u of uncovered) {
    if (prevLedger && prevLedger[u.key]) ledger[u.key] = prevLedger[u.key];
    else { ledger[u.key] = { firstSeen: nowIso, venue: u.venue }; fresh.push(u); }
  }
  return { ledger, fresh };
}

// An uncovered venue alerts at this many recent shows. A one-show venue (a
// bookshop, a church hall) is listed in the report, not alerted.
const ALERT_MIN_RECENT_SHOWS = 2;

/** Uncovered venues worth an alert: busy enough, and not already explained. */
function alertableUncovered(uncovered) {
  return (uncovered || []).filter(u => u.recentShows >= ALERT_MIN_RECENT_SHOWS && !u.noReaderReason);
}

module.exports = {
  ACTIVE_WINDOW_DAYS,
  ALERT_MIN_RECENT_SHOWS,
  NO_READER_REASONS,
  alertableUncovered,
  OTHER_VENUE_READERS,
  venueKey,
  readerKeys,
  findReaderFor,
  computeVenueReaderCoverage,
  groupRooms,
  diffUncovered,
};
