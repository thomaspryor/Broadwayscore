'use strict';

/**
 * National-tour roundups as "add this tour?" suggestions (BRO-4211 Phase E).
 *
 * BroadwayWorld's landing page lists roundups like
 * Review-Roundup-DEATH-BECOMES-HER-Launches-National-Tour-20260915. The slug
 * matcher reads the Broadway title and matches the Broadway show, and the
 * category guard in processShow then drops the roundup with only a log line.
 * When that Broadway show has no tour entry yet, the owner should hear about
 * it: adding a category:'tour' entry is a manual, validated step.
 *
 * Pure: callers pass the matched show and the shows list.
 */

// "...-Launches-North-AMERICAN-Tour-...", "...-Embarks-on-National-Tour-...",
// "...-on-Tour-...", "...-US-Tour-...". Anchored to slug words so a title word
// like "Tourist" or "Detour" doesn't count. Also a few words between the
// launch or the continent and "Tour": "...-Launches-North-American-Leg-of-
// World-Tour-..." (Operation Mincemeat, 2026-09-30) and "...-Launches-20th-
// Anniversary-Tour-..." (Jersey Boys) were missed (BRO-4563).
const TOUR_SLUG_RE = /(?:^|-)(?:north-american|national|us|first-national|touring)-tour(?:-|$)|(?:^|-)on-tour(?:-|$)|(?:^|-)tour-(?:launch(?:es)?|kicks-off|opens|begins)(?:-|$)|(?:^|-)(?:north-american|launch(?:es)?)(?:-[a-z0-9]+){0,4}-tour(?:-|$)/i;
// A UK, West End or other overseas tour is not the North American tour.
// No "asian": "...-National-Tour-with-Asian-American-Cast-..." is a US tour.
const UK_SLUG_RE = /(?:^|-)(?:uk|uk-and-ireland|uk-ireland|west-end|ireland|australia|australian|new-zealand|asia|europe|european|international)(?:-|$)/i;

function isNationalTourRoundupSlug(slug) {
  const s = String(slug || '').split(/[?#]/)[0];
  return TOUR_SLUG_RE.test(s) && !UK_SLUG_RE.test(s);
}

/**
 * The shows a BWW roundup slug may be matched against. A national-tour
 * roundup is about a Broadway title's tour, so it matches Broadway shows (and
 * tour entries) only: the token matcher ties every production of a title and
 * breaks the tie on openingDate, so the West End "Dirty Dancing" beat the
 * undated Broadway one and the tour roundup was dropped as a West End article
 * (BRO-4924). Any other slug matches everything, as before.
 */
function roundupMatchPool(slug, shows) {
  if (!isNationalTourRoundupSlug(slug)) return shows;
  return (shows || []).filter(s => ['broadway', 'tour'].includes(s.category || 'broadway'));
}

/** A BWW roundup's publication date from its slug tail (-YYYYMMDD), or null. */
function roundupDateFromSlug(slugOrUrl) {
  const m = String(slugOrUrl || '').split(/[?#]/)[0].match(/-(\d{4})(\d{2})(\d{2})\/?$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  // Round-trip so a non-date like 20260230 (which Date rolls to March 2) is refused.
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * The Broadway show a tour roundup suggests adding a tour for, or null when
 * the slug isn't a tour roundup, the match isn't a Broadway show, or a tour
 * entry for that production (or another of its title) already exists.
 */
function tourCandidateFor(slug, matchedShow, shows, { predecessorEnds = null, segmentStart = null } = {}) {
  if (!isNationalTourRoundupSlug(slug) || !matchedShow) return null;
  if ((matchedShow.category || 'broadway') !== 'broadway') return null;
  const title = String(matchedShow.title || '').trim().toLowerCase();
  const byId = new Map((shows || []).map(s => [s.id, s]));
  // A tour of this title that is still running (or undated) already owns the
  // roundup. Once every tour of the title has closed, a new tour roundup is a
  // second tour and is a candidate again (Beetlejuice 2026, BRO-4262).
  const hasTour = (shows || []).some(s => {
    if (s.category !== 'tour' || !s.tourOf) return false;
    const parent = byId.get(s.tourOf);
    const sameTitle = s.tourOf === matchedShow.id || (!!parent && String(parent.title || '').trim().toLowerCase() === title);
    if (!sameTitle || (s.status === 'closed' && s.closingDate)) return false;
    // A running tour its schedule page shows ending before this one starts
    // (tour-discovery.js lifecyclePlan, BRO-4724): the tour booked after its
    // layoff is a candidate now, not only once the first is marked closed.
    const end = predecessorEnds && predecessorEnds[s.id];
    return !(end && segmentStart && !s.closingDate && end < segmentStart);
  });
  if (hasTour) return null;
  return { broadwayShowId: matchedShow.id, title: matchedShow.title };
}

/**
 * Merge candidates into the JSON ledger at file (one row per Broadway show,
 * keeping the first-seen time). Returns the number of rows tracked.
 */
function recordTourCandidates(file, candidates, now = new Date().toISOString()) {
  const fs = require('fs');
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  const byId = new Map(rows.map(r => [r.broadwayShowId, r]));
  const fromSchedule = r => !!r && r.source === 'tourstoyou';
  // What a schedule page said this run about how it splits (tour-discovery.js
  // lifecyclePlan): never carried over from an earlier run (BRO-4724).
  const PAGE_FACTS = ['splitAt', 'predecessorEnds'];
  const dropStale = (row, c) => { if (fromSchedule(c)) for (const k of PAGE_FACTS) if (!(k in c)) delete row[k]; return row; };
  for (const c of candidates) {
    let prev = byId.get(c.broadwayShowId);
    // A BWW roundup and a Tours To You listing of one show are two sources
    // for the same tour, not two tours: keep the schedule row and carry the
    // roundup on it, so create-tour-entries.js can use the roundup to confirm
    // the launch when Wikipedia hasn't caught up (BRO-4563). Before this the
    // two overwrote each other on every run and the roundup was lost.
    // A roundup row whose tour was already created belongs to that earlier
    // tour: a schedule row arriving later is a new tour and starts fresh,
    // without the old roundup as launch evidence.
    if (prev && fromSchedule(c) && !fromSchedule(prev) && prev.createdTourId) prev = undefined;
    if (prev && fromSchedule(prev) !== fromSchedule(c)) {
      const schedule = fromSchedule(c) ? c : prev;
      const roundup = fromSchedule(c)
        ? { roundupUrl: prev.roundupUrl || prev.url, roundupSeen: prev.roundupSeen || prev.firstSeen || now }
        : { roundupUrl: c.url, roundupSeen: prev.roundupUrl === c.url ? (prev.roundupSeen || now) : now };
      const keep = fromSchedule(prev) && !(prev.slug && schedule.slug && prev.slug !== schedule.slug) ? prev : {};
      // The owner was already asked about this tour from the roundup: don't ask again.
      const asked = !fromSchedule(prev) && prev.notifiedAt ? { notifiedAt: prev.notifiedAt } : {};
      const row = { ...keep, ...asked, ...schedule, ...roundup, firstSeen: keep.firstSeen || now, lastSeen: now };
      if (!schedule.ambiguous) delete row.ambiguous;
      byId.set(c.broadwayShowId, dropStale(row, c));
      continue;
    }
    // A different roundup for the same show is a later tour (BRO-4262): start
    // it fresh, or the first tour's firstSeen/createdTourId/notifiedAt would
    // hide it for good. The same roundup seen again keeps notifiedAt, so the
    // owner isn't asked twice.
    if (prev && prev.slug && c.slug && prev.slug !== c.slug) prev = undefined;
    const row = { ...prev, ...c, firstSeen: (prev && prev.firstSeen) || now, lastSeen: now };
    // A tour no longer ambiguous (one company left) is decided normally.
    if (!c.ambiguous) delete row.ambiguous;
    byId.set(c.broadwayShowId, dropStale(row, c));
  }
  const out = [...byId.values()].sort((a, b) => a.broadwayShowId.localeCompare(b.broadwayShowId));
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return out.length;
}

/**
 * Rows still worth suggesting: the show exists, is Broadway, and has no tour
 * entry of its title yet (a tour added since the roundup settles the row).
 */
function openTourCandidates(rows, shows) {
  const byId = new Map((shows || []).map(s => [s.id, s]));
  return (rows || []).filter(r => {
    if (r.createdTourId) return false; // create-tour-entries.js made its entry (BRO-4262)
    const show = byId.get(r.broadwayShowId);
    // A tour found running on Tours To You (tour-discovery.js) has no roundup
    // slug; the same "no open tour of this title" test applies.
    const slug = r.source === 'tourstoyou' ? 'national-tour' : (r.slug || 'national-tour');
    return !!show && !!tourCandidateFor(slug, show, shows, r.source === 'tourstoyou' ? { predecessorEnds: r.predecessorEnds, segmentStart: r.segmentStart } : {});
  });
}

module.exports = { isNationalTourRoundupSlug, roundupMatchPool, roundupDateFromSlug, tourCandidateFor, recordTourCandidates, openTourCandidates };
