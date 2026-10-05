'use strict';

/**
 * Find national tours already on the road (BRO-4325).
 *
 * Auto-create (create-tour-entries.js) used to start only from a new
 * BroadwayWorld national-tour roundup, so tours running before launch never
 * arrived: the category held three closed tours while about forty were out.
 * Tours To You lists every touring show as a WordPress page under /shows/
 * (252 pages via the pages API; the /shows/ index shows only 54). For each
 * page whose title is a Broadway show, a schedule segment running now, or one
 * booked to launch within UPCOMING_DAYS, is a tour candidate. create-tour-entries.js then applies the same evidence rules
 * as for a roundup (Wikipedia confirms the launch, no earlier tour open).
 *
 * Pure: callers fetch the pages list and schedules.
 */

const { foldDiacritics } = require('./title-match');
const { parseTourSchedule, segmentTourRows, currentSegment } = require('./tour-schedule');
const { toursOfTitle } = require('./tour-family');

const SHOWS_PARENT_ID = 15096; // tourstoyou.org/shows/
const PAGES_API = `https://tourstoyou.org/wp-json/wp/v2/pages?parent=${SHOWS_PARENT_ID}&per_page=100&_fields=slug,link`;

/** Title or slug to a comparable key: "Moulin Rouge! The Musical" -> moulin-rouge. */
function titleKey(s) {
  return foldDiacritics(String(s || '')).toLowerCase()
    .replace(/&/g, 'and').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .replace(/^(rodgers-(and-)?hammersteins|disneys|irving-berlins|stephen-sondheims)-/, '')
    .replace(/-the-musical$/, '');
}

/** Keys a Broadway title answers to: the whole title, and before a subtitle. */
function titleKeys(title) {
  const t = String(title || '');
  const keys = new Set([titleKey(t)]);
  const head = t.split(/\s*[:(]|,\s+the\b/i)[0];
  if (head && head !== t) keys.add(titleKey(head));
  keys.delete('');
  return keys;
}

/** A Tours To You slug's key: "jersey-boys-1" -> jersey-boys (WordPress dedupe suffix). */
function slugKey(slug) {
  return titleKey(String(slug || '').replace(/-\d+$/, ''));
}

/** Keys to try for a slug, whole first: "9-to-5" is a title, not "9-to" page 5. */
function slugKeys(slug) {
  return [...new Set([titleKey(slug), slugKey(slug)])].filter(Boolean);
}

/**
 * The Broadway production a tour of this schedule page descends from: the
 * latest Broadway production of the title that opened before the tour's
 * first engagement. Null when no Broadway show has the title.
 */
function parentForSlug(slug, shows, beforeIso) {
  const before = String(beforeIso || '').slice(0, 10);
  const broadway = (shows || []).filter(s => (s.category || 'broadway') === 'broadway'
    && s.openingDate && (!before || s.openingDate <= before));
  const latest = list => list.sort((a, b) => b.openingDate.localeCompare(a.openingDate))[0] || null;
  for (const key of slugKeys(slug)) {
    // The whole title first: "Cats" must not become "CATS: The Jellicle Ball"
    // just because that title's head is "Cats".
    const exact = latest(broadway.filter(s => titleKey(s.title) === key));
    if (exact) return exact;
    const byHead = latest(broadway.filter(s => titleKeys(s.title).has(key)));
    if (byHead) return byHead;
  }
  return null;
}

// A tour booked to launch within this many days is found before it opens, so
// it arrives as 'upcoming' and opens on its date like any other show
// (update-show-status.js) instead of weeks later. Tours announce their first
// engagements six to nine months out (Legally Blonde: Cerritos, Jan 2027).
const UPCOMING_DAYS = 270;
const DAY = 86400000;

/**
 * Tours booked ahead on this page: segments that have not started, open
 * within UPCOMING_DAYS, and visit at least three cities (a single-city run is
 * a sit-down, not a tour). Earliest first.
 */
function upcomingSegments(segments, now = new Date()) {
  const t = now.getTime();
  return segments
    .filter(s => s.start.getTime() > t && s.start.getTime() - t <= UPCOMING_DAYS * DAY
      && new Set(s.rows.map(r => String(r.city || '').toLowerCase())).size >= 3)
    .sort((a, b) => a.start - b.start);
}

/**
 * The tour on this schedule page that is running now, or failing that one
 * booked to launch soon, as a candidate row, or {skip} saying why not. A
 * segment already covered by a tour of the title is passed over, so a page
 * whose current tour is tracked still yields the next one.
 * @returns {{candidate: object} | {skip: string}}
 */
function runningTourCandidate({ slug, scheduleUrl, html, shows, now = new Date() }) {
  const rows = parseTourSchedule(html);
  if (!rows.length) return { skip: 'schedule parsed to no engagements' };
  const segments = segmentTourRows(rows);
  const running = currentSegment(segments, now);
  const options = [...(running ? [running] : []), ...upcomingSegments(segments, now).filter(s => s !== running)];
  if (!options.length) return { skip: 'no tour running now or booked to launch' };
  let skip = null;
  for (const seg of options) {
    const segStart = seg.start.toISOString().slice(0, 10);
    const parent = parentForSlug(slug, shows, segStart);
    if (!parent) { skip = skip || 'no Broadway show of this title'; continue; }
    // Already tracked: a tour of the title that covers this segment. Recording
    // it again would replace that tour's candidate row (and its createdTourId).
    const covering = toursOfTitle(parent.title, shows).find(t => t.openingDate
      && (!t.closingDate || t.closingDate >= segStart)
      && t.openingDate <= seg.end.toISOString().slice(0, 10));
    if (covering) { skip = skip || `already tracked as ${covering.id}`; continue; }
    return {
      candidate: {
        broadwayShowId: parent.id,
        title: parent.title,
        source: 'tourstoyou',
        slug: `tourstoyou:${slug}:${segStart}`,
        url: scheduleUrl,
        tourScheduleSlug: slug,
        segmentStart: segStart,
        ...(seg !== running ? { upcoming: true } : {}),
      },
    };
  }
  return { skip };
}

/**
 * One candidate per Broadway show. Two pages running a tour of the same show
 * from different starts (two companies) is ambiguous: the first is kept with
 * an ambiguous note, so it is never created automatically but still reaches
 * the owner as a suggestion.
 * @returns {{candidates: object[], ambiguous: string[]}}
 */
function dedupeCandidates(candidates) {
  const byShow = new Map();
  for (const c of candidates) {
    if (!byShow.has(c.broadwayShowId)) byShow.set(c.broadwayShowId, []);
    byShow.get(c.broadwayShowId).push(c);
  }
  const out = [];
  const ambiguous = [];
  for (const [id, list] of byShow) {
    const starts = new Set(list.map(c => c.segmentStart));
    if (starts.size > 1) {
      const note = `${id}: ${list.map(c => `${c.tourScheduleSlug}@${c.segmentStart}`).join(', ')}`;
      ambiguous.push(note);
      out.push({ ...list[0], ambiguous: note });
    } else out.push(list[0]);
  }
  return { candidates: out, ambiguous };
}

module.exports = { PAGES_API, UPCOMING_DAYS, titleKey, titleKeys, slugKey, slugKeys, parentForSlug, upcomingSegments, runningTourCandidate, dedupeCandidates };
