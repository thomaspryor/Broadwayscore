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

// Categories a North American tour can be touring FROM: Broadway, Off-Broadway
// and regional productions (BRO-4931), plus tour entries themselves. West End
// and off-West End are a different production and never tour parents here.
const { AUTO_TOUR_PARENT_CATEGORIES: TOUR_PARENT_CATEGORIES } = require('./tour-family');
const ROUNDUP_POOL_CATEGORIES = [...TOUR_PARENT_CATEGORIES, 'tour'];

/**
 * The shows a BWW roundup slug may be matched against. A national-tour
 * roundup is about a US-produced title's tour, so it matches Broadway,
 * Off-Broadway, regional and tour shows only, never West End: the token
 * matcher ties every production of a title and breaks the tie on openingDate,
 * so the West End "Dirty Dancing" beat the undated Broadway one and the tour
 * roundup was dropped as a West End article (BRO-4924). Off-Broadway and
 * regional titles are tracked tours too (BRO-4931). Any other slug matches
 * everything, as before.
 */
function roundupMatchPool(slug, shows) {
  if (!isNationalTourRoundupSlug(slug)) return shows;
  return (shows || []).filter(s => ROUNDUP_POOL_CATEGORIES.includes(s.category || 'broadway'));
}

/** True when a show of this category can be the parent of a tracked tour. */
function isTourParentCategory(category) {
  return TOUR_PARENT_CATEGORIES.includes(category || 'broadway');
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
 * True when a tour of this title is already tracked and still running (or
 * undated). `matched` is the tour parent ({id, title}), or for a standalone
 * tour (BRO-4931) just {id: null, title}: a tour with no tourOf is matched by
 * its own title, since it carries no parent to compare.
 */
// Straight and curly apostrophes read the same: a Tours To You page title has
// a straight one where the entry built from the page title may have a curly one
// ("Dolly Parton's" vs "Dolly Parton\u2019s", BRO-4931).
const sameTitleKey = t => String(t || '').trim().toLowerCase().replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'");

function hasOpenTour(matched, shows, { predecessorEnds = null, segmentStart = null } = {}) {
  const title = sameTitleKey(matched.title);
  const byId = new Map((shows || []).map(s => [s.id, s]));
  return (shows || []).some(s => {
    if (s.category !== 'tour') return false;
    const parent = s.tourOf ? byId.get(s.tourOf) : null;
    const sameTitle = (matched.id && s.tourOf === matched.id)
      || (!!parent && sameTitleKey(parent.title) === title)
      // Standalone tours carry no tourOf: their own title, or the Tours To You
      // page they were built from, is the link.
      || (!s.tourOf && sameTitleKey(s.title) === title)
      || (!!matched.tourScheduleSlug && s.tourScheduleSlug === matched.tourScheduleSlug);
    if (!sameTitle || (s.status === 'closed' && s.closingDate)) return false;
    // A running tour its schedule page shows ending before this one starts
    // (tour-discovery.js lifecyclePlan, BRO-4724): the tour booked after its
    // layoff is a candidate now, not only once the first is marked closed.
    const end = predecessorEnds && predecessorEnds[s.id];
    return !(end && segmentStart && !s.closingDate && end < segmentStart);
  });
}

/**
 * The show (Broadway, Off-Broadway or regional) a tour roundup suggests adding
 * a tour for, or null when the slug isn't a tour roundup, the match isn't one
 * of those, or a tour entry for that production (or another of its title)
 * already exists.
 */
function tourCandidateFor(slug, matchedShow, shows, { predecessorEnds = null, segmentStart = null } = {}) {
  if (!isNationalTourRoundupSlug(slug) || !matchedShow) return null;
  if (!isTourParentCategory(matchedShow.category)) return null;
  // A tour of this title that is still running (or undated) already owns the
  // roundup. Once every tour of the title has closed, a new tour roundup is a
  // second tour and is a candidate again (Beetlejuice 2026, BRO-4262).
  if (hasOpenTour(matchedShow, shows, { predecessorEnds, segmentStart })) return null;
  return { broadwayShowId: matchedShow.id, title: matchedShow.title };
}

/**
 * A national-tour roundup that matched NO show at all (a standalone touring
 * show, or a title we don't track yet). Row shape, kept stable because the
 * Tours To You pairing step reads it (BRO-4931):
 *
 *   { key: 'roundup:<lowercased slug>',   // ledger key; there is no show id
 *     source: 'bww-roundup',
 *     slug, url, roundupUrl,              // slug as on BWW; url === roundupUrl
 *     title }                             // HINT only: cleaned slug, title-cased
 *   // no broadwayShowId. openTourCandidates() skips these rows (no show to
 *   // tour from); recordTourCandidates() keys rows by `r.key || r.broadwayShowId`.
 *   // recordTourCandidates adds firstSeen / lastSeen, and a pairing step may
 *   // add notifiedAt / createdTourId.
 *
 * The title is derived from the slug (head, tail phrase and date removed), so
 * it is only a hint for matching a Tours To You page, never a show title.
 * Returns null when the slug is not a national-tour roundup.
 */
function roundupOnlyCandidate(slug, url) {
  const clean = String(slug || '').split(/[?#]/)[0];
  if (!isNationalTourRoundupSlug(clean)) return null;
  const title = clean.toLowerCase()
    .replace(/^review-roundup-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(?:opens|launches?|kicks-off|begins|embarks(?:-on)?|on-tour|north-american|first-national|national-tour|us-tour|touring-tour|tour-(?:launch|kicks|opens|begins)[a-z]*)(?:-.*)?$/, '')
    .split('-').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return { key: `roundup:${clean.toLowerCase()}`, source: 'bww-roundup', slug: clean, url, roundupUrl: url, title };
}

/**
 * Merge candidates into the JSON ledger at file (one row per tour-parent show,
 * or per `key` for roundup-only rows, keeping the first-seen time). Returns
 * the number of rows tracked.
 */
function recordTourCandidates(file, candidates, now = new Date().toISOString()) {
  const fs = require('fs');
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  // Rows from before roundup-only candidates have no key: broadwayShowId is it.
  const keyOf = r => r.key || r.broadwayShowId;
  const byId = new Map(rows.filter(r => keyOf(r)).map(r => [keyOf(r), r]));
  const fromSchedule = r => !!r && r.source === 'tourstoyou';
  // What a schedule page said this run about how it splits (tour-discovery.js
  // lifecyclePlan): never carried over from an earlier run (BRO-4724).
  // needsClassification/type/upcoming (BRO-4931): an override added since, or a tour no longer booked ahead, must not leave the old value on the row.
  const PAGE_FACTS = ['splitAt', 'predecessorEnds', 'needsClassification', 'type', 'upcoming'];
  const dropStale = (row, c) => { if (fromSchedule(c)) for (const k of PAGE_FACTS) if (!(k in c)) delete row[k]; return row; };
  // Discovery reads a page without Wikipedia, so it reports 'unclassified' every run for a page the
  // create step already classified from the infobox (production, or an event). That earlier answer
  // stays on the row for the same segment, or the row would reopen and drop out daily (BRO-4931).
  const keepEarlierClass = (row, prev, c) => {
    if (!prev || !fromSchedule(c) || c.pageClass !== 'unclassified' || !prev.pageClass || prev.pageClass === 'unclassified') return row;
    if (prev.slug && c.slug && prev.slug !== c.slug) return row;
    const kept = { ...row, pageClass: prev.pageClass };
    if (prev.type) kept.type = prev.type; else delete kept.type;
    delete kept.needsClassification;
    return kept;
  };
  for (const c of candidates) {
    const ck = keyOf(c);
    if (!ck) continue;
    let prev = byId.get(ck);
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
      byId.set(ck, keepEarlierClass(dropStale(row, c), prev, c));
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
    byId.set(ck, keepEarlierClass(dropStale(row, c), prev, c));
  }
  const out = [...byId.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return out.length;
}

/**
 * A candidate row's tracked parent id: parentId (Tours To You rows since
 * BRO-4931), else broadwayShowId (roundup rows and older rows), else null for
 * a standalone page row or a roundup-only row.
 */
const NOT_A_PRODUCTION = new Set(['event', 'aggregator', 'template', 'company']);
const candidateParentId = r => r.parentId || r.broadwayShowId || null;

/**
 * Rows still worth suggesting. A row with a tracked parent: the parent exists
 * and no tour of its title is running yet (a tour added since the roundup
 * settles the row). A standalone page row (key page:<slug>, no parent, since
 * BRO-4931): no tracked tour carries its title, tours with no tourOf being
 * matched by their own title. A row whose page nothing could classify
 * (needsClassification) stays open so the owner digest can ask. Roundup-only
 * rows (key roundup:..., no page yet) are not suggestions: they wait for a
 * Tours To You page to pair with.
 */
function openTourCandidates(rows, shows) {
  const byId = new Map((shows || []).map(s => [s.id, s]));
  return (rows || []).filter(r => {
    if (r.createdTourId) return false; // create-tour-entries.js made its entry (BRO-4262)
    if (String(r.key || '').startsWith('roundup:')) return false;
    // create-tour-entries.js read the page's Wikipedia infobox and found it is no stage production.
    if (NOT_A_PRODUCTION.has(r.pageClass)) return false;
    // A tour found running on Tours To You (tour-discovery.js) has no roundup
    // slug; the same "no open tour of this title" test applies.
    const found = r.source === 'tourstoyou';
    const slug = found ? 'national-tour' : (r.slug || 'national-tour');
    const opts = found ? { predecessorEnds: r.predecessorEnds, segmentStart: r.segmentStart } : {};
    const parentId = candidateParentId(r);
    if (!parentId) {
      // Only a Tours To You page row can stand on its own title.
      return found && !!r.title && !hasOpenTour({ id: null, title: r.title, tourScheduleSlug: r.tourScheduleSlug }, shows, opts);
    }
    const show = byId.get(parentId);
    if (!show) return false;
    // The page row's parent was validated against TOUR_PARENT_CATEGORIES when
    // the page was read (a West End parent is fine for a page); a roundup is not.
    if (found) return !hasOpenTour(show, shows, opts);
    return !!tourCandidateFor(slug, show, shows, opts);
  });
}

/**
 * Candidates in the order create-tour-entries.js decides them: parented tours
 * first, then standalone pages, those still to be classified last. A standalone
 * page costs two Wikipedia reads, so it must not use up the run's time budget
 * before a parented tour is decided (BRO-4931). Stable; returns a new array.
 */
function sortForCreate(candidates) {
  const rank = c => (candidateParentId(c) ? 0 : c.needsClassification ? 2 : 1);
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

module.exports = { sortForCreate, isNationalTourRoundupSlug, roundupMatchPool, isTourParentCategory, roundupDateFromSlug, roundupOnlyCandidate, hasOpenTour, candidateParentId, tourCandidateFor, recordTourCandidates, openTourCandidates };
