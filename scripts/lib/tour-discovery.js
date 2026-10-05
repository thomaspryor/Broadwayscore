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
const { parseTourSchedule, segmentTourRows, currentSegment, pickSegment } = require('./tour-schedule');
const { isSeparateTour, splitSegmentsAt } = require('./tour-history');
const { toursOfTitle } = require('./tour-family');

const SHOWS_PARENT_ID = 15096; // tourstoyou.org/shows/
const PAGES_API = `https://tourstoyou.org/wp-json/wp/v2/pages?parent=${SHOWS_PARENT_ID}&per_page=100&_fields=slug,link,modified_gmt`;

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

const isoDay = d => d.toISOString().slice(0, 10);

/**
 * What the page says about the title's tracked tours (BRO-4724), from its
 * engagements and History tab (tour-history.js isSeparateTour):
 *  - a closed tour whose segment carries rows after its closing date: those
 *    rows are a new tour (cut there, so they become their own segment), the
 *    same tour back (reopen: clear the closing), or the page doesn't say
 *    (undecided: nothing changes);
 *  - a running tour whose segment ends before a later block the evidence
 *    calls a separate tour: it ends with its segment (knownEnds), so the
 *    later tour can be created before it launches instead of only after the
 *    first is marked closed.
 * Pure.
 * @param {{segments: object[], html: string, tours: object[]}} args tours of ONE title
 * @returns {{cuts: string[], reopen: object[], undecided: object[], knownEnds: Object<string,string>}}
 */
/**
 * Why a closed tour the page lists again must not be reopened by itself, or
 * null. A person checked its closing (hand-verified / humanCorrectedClosingDate),
 * or another tracked tour of the title launched after it closed and still runs
 * at the resumed dates, so those rows are that tour's (BRO-4724 ship-check).
 */
function reopenBlocker(tour, tours, resumes) {
  if (!tour) return 'tour not found';
  if (tour.humanCorrectedClosingDate === true || /hand-verified/i.test(String(tour.closingDateSource || ''))) {
    return `closing ${tour.closingDate} was checked by hand`;
  }
  const close = String(tour.closingDate || '').slice(0, 10);
  const other = (tours || []).find(o => o.id !== tour.id && o.openingDate && o.openingDate > close
    && (!o.closingDate || String(o.closingDate).slice(0, 10) >= resumes));
  return other ? `${other.id} launched after it closed and covers ${resumes}` : null;
}

function lifecyclePlan({ segments, html, tours }) {
  const plan = { cuts: [], reopen: [], undecided: [], knownEnds: {} };
  for (const t of tours || []) {
    if (!t.openingDate) continue;
    const seg = pickSegment(segments, t, '');
    if (!seg) continue;
    if (t.closingDate) {
      const close = String(t.closingDate).slice(0, 10);
      const after = seg.rows.filter(r => isoDay(r.start) > close);
      if (!after.length) continue;
      const d = isSeparateTour({ html, earlierLaunch: t.openingDate, laterStart: after[0].start });
      const facts = { id: t.id, closingDate: close, resumes: isoDay(after[0].start), reason: d.reason };
      const blocked = d.separate === false ? reopenBlocker(t, tours, facts.resumes) : null;
      if (d.separate === true) plan.cuts.push(close);
      else if (d.separate === false && !blocked) plan.reopen.push(facts);
      else plan.undecided.push(blocked ? { ...facts, reason: blocked } : facts);
      continue;
    }
    const next = segments.slice(segments.indexOf(seg) + 1).find(s => s.rows.length > 1);
    if (!next || next.start <= seg.end) continue;
    const d = isSeparateTour({ html, earlierLaunch: t.openingDate, laterStart: next.start, afterNewYork: next.afterNewYork });
    if (d.separate === true) plan.knownEnds[t.id] = isoDay(seg.end);
  }
  return plan;
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
  // The title's tracked tours decide how this page splits (BRO-4724).
  const titleParent = parentForSlug(slug, shows, null);
  const tracked = titleParent ? toursOfTitle(titleParent.title, shows) : [];
  const plan = lifecyclePlan({ segments: segmentTourRows(rows), html, tours: tracked });
  const segments = splitSegmentsAt(segmentTourRows(rows), plan.cuts);
  const lifecycle = { reopen: plan.reopen, undecided: plan.undecided };
  const running = currentSegment(segments, now);
  const options = [...(running ? [running] : []), ...upcomingSegments(segments, now).filter(s => s !== running)];
  if (!options.length) return { skip: 'no tour running now or booked to launch', lifecycle };
  let skip = null;
  for (const seg of options) {
    const segStart = seg.start.toISOString().slice(0, 10);
    const parent = parentForSlug(slug, shows, segStart);
    if (!parent) { skip = skip || 'no Broadway show of this title'; continue; }
    // Already tracked: a tour of the title that covers this segment. Recording
    // it again would replace that tour's candidate row (and its createdTourId).
    // A running tour the page shows ending before this segment (knownEnds)
    // doesn't cover it.
    const endOf = t => t.closingDate || plan.knownEnds[t.id] || null;
    const ofTitle = toursOfTitle(parent.title, shows);
    const covering = ofTitle.find(t => t.openingDate
      && (!endOf(t) || endOf(t) >= segStart)
      && t.openingDate <= seg.end.toISOString().slice(0, 10));
    if (covering) { skip = skip || `already tracked as ${covering.id}`; continue; }
    // Carried to create-tour-entries.js, which re-splits the page the same
    // way and lets a running predecessor that ends first stand aside.
    const predecessorEnds = Object.fromEntries(ofTitle.filter(t => !t.closingDate && plan.knownEnds[t.id] && plan.knownEnds[t.id] < segStart).map(t => [t.id, plan.knownEnds[t.id]]));
    const cuts = plan.cuts.filter(c => c < segStart);
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
        // Only when the page needs them; recordTourCandidates drops a stale
        // value an earlier run recorded.
        ...(cuts.length ? { splitAt: cuts } : {}),
        ...(Object.keys(predecessorEnds).length ? { predecessorEnds } : {}),
      },
      lifecycle,
    };
  }
  return { skip, lifecycle };
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

module.exports = { PAGES_API, UPCOMING_DAYS, titleKey, titleKeys, slugKey, slugKeys, parentForSlug, upcomingSegments, lifecyclePlan, reopenBlocker, runningTourCandidate, dedupeCandidates };
