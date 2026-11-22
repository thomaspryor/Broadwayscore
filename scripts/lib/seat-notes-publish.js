'use strict';
/**
 * Which seat notes a page shows (BRO-8057). Pure, dependency-free, shared by
 * the web build (src/), the mobile generator and the validator, so the rule
 * lives in one place.
 *
 * A seat note is one sourced, specific tip tied to a seat location:
 *   { type: 'watch-out'|'value'|'note', hazard?, level, side?, rows?, claim, short?,
 *     evidence: [{ url, quoteHash, fetchedAt }], verifiedAt: 'YYYY-MM-DD' }
 */

const NOTE_TYPES = ['watch-out', 'value', 'note'];
const TYPE_ORDER = { 'watch-out': 0, value: 1, note: 2 };
const MAX_NOTES = 8;
const MIN_NOTES = 2;
// Prices move. A "good value" note that has not been re-checked in this many
// days is hidden rather than shown stale.
const VALUE_MAX_AGE_DAYS = 270;

const LEVEL_LABEL = {
  orchestra: 'Orchestra',
  'front-mezzanine': 'Front Mezzanine',
  'rear-mezzanine': 'Rear Mezzanine',
  mezzanine: 'Mezzanine',
  balcony: 'Balcony',
  box: 'Box seats',
};
const SIDE_LABEL = { center: 'Center', sides: 'far sides', left: 'Left', right: 'Right' };
// Display names for source hosts (link text on the card).
const SOURCE_LABEL = {
  'seatplan.com': 'SeatPlan',
  'tickpick.com': 'TickPick',
  'headout.com': 'Headout',
  'aviewfrommyseat.com': 'A View From My Seat',
  'rateyourseats.com': 'RateYourSeats',
  'nytix.com': 'NYTix',
  'reddit.com': 'Reddit',
  'old.reddit.com': 'Reddit',
  'broadwayworld.com': 'BroadwayWorld',
  'forum.broadwayworld.com': 'BroadwayWorld',
  'broadwaydirect.com': 'Broadway Direct',
  'telecharge.com': 'Telecharge',
  'ticketmaster.com': 'Ticketmaster',
  'seatgeek.com': 'SeatGeek',
  'theatermania.com': 'TheaterMania',
  'playbill.com': 'Playbill',
};

/**
 * "Today" for expiry. In the web build this is the build date (inlined by
 * next.config.js), so server HTML and client hydration judge the same day.
 * Scripts and tests fall back to the real clock.
 */
function buildToday() {
  const d = process.env.NEXT_PUBLIC_BUILD_DATE;
  return d ? new Date(`${d}T12:00:00Z`) : new Date();
}

function daysBetween(fromIso, to) {
  const a = Date.parse(fromIso);
  const b = to instanceof Date ? to.getTime() : Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return (b - a) / 86400000;
}

// A claim about a start row and everything behind it ("the overhang starts at
// row O"). Its single stored row then reads "row O back", not "row O" (BRO-8057).
const STARTS_A_SPAN = /\b(from (around )?row [A-Z]{1,3} back|(starts|begins) (at|over) ((front |rear )?mezzanine |orchestra |balcony )?row|overhangs? (from|at) row)\b/i;
/** True when a note's single stored row is where a span starts (it covers the rows behind). */
const startsASpan = (n) => /^[A-Z]{1,3}$/.test(String((n && n.rows) || '')) && STARTS_A_SPAN.test(String((n && n.claim) || ''));

/** "Center Orchestra, rows E to J" built from the structured location. */
function noteLocationLabel(n) {
  const level = LEVEL_LABEL[n.level] || '';
  let place;
  if (n.side === 'sides') place = `${level}, far sides`;
  else if (n.side) place = `${SIDE_LABEL[n.side] || ''} ${level}`.trim();
  else place = level;
  if (!n.rows) return place;
  const r = String(n.rows);
  const m = r.match(/^([A-Z]{1,3})-([A-Z]{1,3})$/);
  if (m) return `${place}, rows ${m[1]} to ${m[2]}`;
  if (/^[A-Z]{1,3}$/.test(r)) return startsASpan(n) ? `${place}, row ${r} back` : `${place}, row ${r}`;
  return `${place}, ${r}`;
}

/** Distinct source hosts behind a note, for "2 sources" and the source links. */
function noteSources(n) {
  const hosts = [];
  for (const e of n.evidence || []) {
    let h;
    try { h = new URL(e.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!hosts.includes(h)) hosts.push(h);
  }
  return hosts;
}

/**
 * One link per source site behind a note: [{ label, url }], first URL per label.
 */
function noteSourceLinks(n) {
  const out = [];
  for (const e of n.evidence || []) {
    let h;
    try { h = new URL(e.url).hostname.replace(/^www\./, ''); } catch { continue; }
    const label = SOURCE_LABEL[h] || h;
    if (!out.some((o) => o.label === label)) out.push({ label, url: e.url });
  }
  return out;
}

/**
 * The notes to render, in order, or [] when the theater does not clear the
 * bar (>= 2 notes, at least one watch-out or value).
 */
function publishableSeatNotes(notes, { today = buildToday() } = {}) {
  if (!Array.isArray(notes)) return [];
  const live = notes
    .filter((n) => n && NOTE_TYPES.includes(n.type) && n.claim && noteSources(n).length > 0)
    .filter((n) => n.type !== 'value' || daysBetween(n.verifiedAt, today) <= VALUE_MAX_AGE_DAYS)
    .map((n, i) => ({ n, i }))
    .sort((a, b) => TYPE_ORDER[a.n.type] - TYPE_ORDER[b.n.type] || a.i - b.i)
    .map(({ n }) => n)
    .slice(0, MAX_NOTES);
  if (live.length < MIN_NOTES) return [];
  if (!live.some((n) => n.type === 'watch-out' || n.type === 'value')) return [];
  return live;
}

/** Noon UTC of the calendar day of `d`: the same clock buildToday() gives the site. */
function noonUtc(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
}

/** Value notes that could be shown (same eligibility as publishableSeatNotes). */
function eligibleValueNotes(meta) {
  const out = [];
  for (const [theater, v] of Object.entries(meta || {})) {
    const notes = v && v.structuredTips && v.structuredTips.seating && v.structuredTips.seating.seatNotes;
    if (!Array.isArray(notes)) continue;
    for (const n of notes) {
      if (n && n.type === 'value' && n.claim && noteSources(n).length > 0) out.push({ theater, n });
    }
  }
  return out;
}

/**
 * Value notes that are expired or expire within warnDays:
 * [{ theater, where, daysLeft, invalid? }]. `meta` is data/theater-metadata.json.
 * Counts whole days against noon UTC of `today`, so daysLeft <= 0 exactly when
 * publishableSeatNotes hides the note. A missing or unparseable verifiedAt is
 * reported as invalid and expired (the site hides it too).
 * Used by scripts/audit-seat-notes-expiry.js.
 */
function valueNotesNearExpiry(meta, { today = new Date(), warnDays = 60 } = {}) {
  const t = noonUtc(today);
  const out = [];
  for (const { theater, n } of eligibleValueNotes(meta)) {
    const age = daysBetween(n.verifiedAt, t);
    const invalid = !Number.isFinite(age);
    const daysLeft = invalid ? 0 : VALUE_MAX_AGE_DAYS - Math.floor(age);
    if (daysLeft <= warnDays) {
      const row = { theater, where: noteLocationLabel(n), daysLeft };
      if (invalid) row.invalid = true;
      out.push(row);
    }
  }
  return out;
}

/**
 * The two headline tips the closed card shows (owner-picked design B,
 * 2026-11-22): the first watch-out and the first value note, in stored order.
 * Takes the output of publishableSeatNotes().
 */
function seatNotePicks(notes) {
  const list = Array.isArray(notes) ? notes : [];
  return {
    avoid: list.find((n) => n.type === 'watch-out') || null,
    value: list.find((n) => n.type === 'value') || null,
  };
}

/** "Center Orchestra, rows A to C. Very close to the stage." for a headline pick. */
function pickText(n) {
  const head = String(n.short || n.claim || '').trim().replace(/[.!]+$/, '');
  return { where: noteLocationLabel(n), what: head ? `${head}.` : '' };
}

/** Latest verifiedAt across the notes shown, for "checked Nov 2026". */
function latestVerified(notes) {
  let best = null;
  for (const n of notes || []) if (n.verifiedAt && (!best || n.verifiedAt > best)) best = n.verifiedAt;
  return best;
}

module.exports = {
  NOTE_TYPES, MAX_NOTES, MIN_NOTES, VALUE_MAX_AGE_DAYS, LEVEL_LABEL,
  SOURCE_LABEL, noteLocationLabel, noteSources, noteSourceLinks, publishableSeatNotes, latestVerified,
  seatNotePicks, pickText, valueNotesNearExpiry, eligibleValueNotes, buildToday, startsASpan,
};
