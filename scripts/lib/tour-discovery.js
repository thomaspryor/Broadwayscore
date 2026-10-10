'use strict';

/**
 * Find national tours already on the road (BRO-4325).
 *
 * Auto-create (create-tour-entries.js) used to start only from a new
 * BroadwayWorld national-tour roundup, so tours running before launch never
 * arrived: the category held three closed tours while about forty were out.
 * Tours To You lists every touring show as a WordPress page under /shows/
 * (252 pages via the pages API; the /shows/ index shows only 54). Each page is
 * classified first (tour-page-class.js): a production with a schedule segment
 * running now, or booked to launch within UPCOMING_DAYS, is a tour candidate
 * (BRO-4931: of any tracked production in any market, or standalone when none
 * is tracked). create-tour-entries.js then applies the same evidence rules as
 * for a roundup (the launch is confirmed, no earlier tour open).
 *
 * Pure apart from listShowPages' injected fetch: callers fetch the schedules.
 */

const { foldDiacritics } = require('./title-match');
const { parseTourSchedule, segmentTourRows, currentSegment, pickSegment, tooFewStops } = require('./tour-schedule');
const { isSeparateTour, splitSegmentsAt } = require('./tour-history');
const { toursOfTitle, normTitle, TOUR_PARENT_CATEGORIES, AUTO_TOUR_PARENT_CATEGORIES, tourParentCategory } = require('./tour-family');
const { classifyTourPage, SKIPPED_CLASSES, pageTitleFromHtml, decodeTitle } = require('./tour-page-class');

const SHOWS_PARENT_ID = 15096; // tourstoyou.org/shows/
const PAGES_API = `https://tourstoyou.org/wp-json/wp/v2/pages?parent=${SHOWS_PARENT_ID}&per_page=100&_fields=slug,link,modified_gmt,title`;

/**
 * Every show page on Tours To You (WordPress pages API, 100 a page): slugs,
 * plus each page's last edit (`modified`) so edited pages are read first, and
 * its title (`titles`). Returns an array of slugs carrying `.modified` and
 * `.titles` maps.
 */
async function listShowPages(fetchText) {
  const out = [];
  const modified = {};
  const titles = {};
  for (let page = 1; page <= 50; page++) {
    let rows;
    try {
      rows = JSON.parse(await fetchText(`${PAGES_API}&page=${page}`));
    } catch (e) {
      // WordPress answers past the last page with an HTTP 400.
      if (page > 1 && /HTTP 400/.test(e.message)) break;
      throw e;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      if (!r.slug) continue;
      out.push(r.slug);
      // The page's own title, from the API (never taken from the URL).
      if (r.title && r.title.rendered) titles[r.slug] = decodeTitle(r.title.rendered);
      // modified_gmt is UTC without a zone suffix (plain `modified` is site-local).
      if (r.modified_gmt) modified[r.slug] = `${r.modified_gmt}Z`;
    }
    if (rows.length < 100) break;
  }
  const slugs = [...new Set(out)];
  slugs.modified = modified;
  slugs.titles = titles;
  return slugs;
}

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

// A Broadway production announced but not yet open.
const PRE_BROADWAY_STATUSES = new Set(['announced', 'upcoming', 'previews']);
// A Broadway run that opens this long after a tour starts still counts as that tour's parent.
const PRE_BROADWAY_WINDOW_DAYS = 365;

/**
 * The production a tour of this schedule page descends from (BRO-4931: any
 * TOUR_PARENT_CATEGORIES production, not only Broadway). Categories are tried
 * in that priority order (broadway, off-broadway, regional, west-end,
 * off-west-end); within one, the latest production of the title that opened on
 * or before the tour's first engagement. Outside Broadway only a title that
 * matches whole counts: a subtitled production in another market is a
 * different show ("Dirty Dancing: The Classic Story on Stage" is not the
 * Dirty Dancing musical). Failing all that, the title's Broadway run not yet
 * open (a tour that launches first). Null when nothing has the title.
 * `categories` narrows the markets tried: automatic discovery passes
 * AUTO_TOUR_PARENT_CATEGORIES (no UK parents, BRO-4931); the default is every
 * TOUR_PARENT_CATEGORIES market, for a person's manual add.
 */
function parentForSlug(slug, shows, beforeIso, categories = TOUR_PARENT_CATEGORIES) {
  const before = String(beforeIso || '').slice(0, 10);
  const candidates = (shows || []).filter(s => tourParentCategory(s) && categories.includes(tourParentCategory(s))
    && s.openingDate && (!before || s.openingDate <= before));
  const latest = list => list.sort((a, b) => b.openingDate.localeCompare(a.openingDate))[0] || null;
  for (const category of categories) {
    const inCategory = candidates.filter(s => (s.category || 'broadway') === category);
    if (!inCategory.length) continue;
    for (const key of slugKeys(slug)) {
      // The whole title first: "Cats" must not become "CATS: The Jellicle Ball"
      // just because that title's head is "Cats".
      const exact = latest(inCategory.filter(s => titleKey(s.title) === key));
      if (exact) return exact;
      if (category !== 'broadway') continue;
      const byHead = latest(inCategory.filter(s => titleKeys(s.title).has(key)));
      if (byHead) return byHead;
    }
  }
  // A tour that launches before its Broadway run (Dirty Dancing toured from
  // Aug 2026 and opens at the Lena Horne in Feb 2027, BRO-4924) has no earlier
  // Broadway production, so the Broadway run still ahead is its parent. Only
  // as a last resort, so an older tour keeps its real earlier parent. "Ahead"
  // is a run not yet open (any status in PRE_BROADWAY_STATUSES) or one that
  // opened within PRE_BROADWAY_WINDOW_DAYS after the tour's first engagement,
  // so the tour keeps its parent once the Broadway run opens.
  const windowEnd = before ? new Date(new Date(`${before}T00:00:00Z`).getTime() + PRE_BROADWAY_WINDOW_DAYS * 86400000).toISOString().slice(0, 10) : null;
  const ahead = (shows || []).filter(s => (s.category || 'broadway') === 'broadway'
    && (PRE_BROADWAY_STATUSES.has(String(s.status || '').toLowerCase()) || (windowEnd && s.openingDate && s.openingDate > before && s.openingDate <= windowEnd))
    && (!s.openingDate || !before || s.openingDate > before));
  const soonest = list => list.sort((a, b) => String(a.openingDate || a.unconfirmedStartDate || '9999').localeCompare(String(b.openingDate || b.unconfirmedStartDate || '9999')))[0] || null;
  for (const key of slugKeys(slug)) {
    const exact = soonest(ahead.filter(s => titleKey(s.title) === key));
    if (exact) return exact;
    const byHead = soonest(ahead.filter(s => titleKeys(s.title).has(key)));
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
 * The tracked production a classified page tours from, for the segment that
 * starts at segStart: an override's named parent as is, a title match re-picked
 * by that date (a later revival is not an earlier tour's parent), or null.
 */
function parentForClass(cls, { slug, title, shows, segStart }) {
  if (cls.parentId && cls.source === 'override') return (shows || []).find(s => s.id === cls.parentId) || null;
  if (cls.parentId) return parentForSlug(slug, shows, segStart, AUTO_TOUR_PARENT_CATEGORIES) || (title ? parentForSlug(titleKey(title), shows, segStart, AUTO_TOUR_PARENT_CATEGORIES) : null);
  return null;
}

/**
 * The tour on this schedule page that is running now, or failing that one
 * booked to launch soon, as a candidate row, or {skip, kind} saying why not
 * (kind: event, aggregator, template, company, nothing-running, too-few-stops,
 * no-parent, tracked). A segment already covered by a tour of the title is
 * passed over, so a page whose current tour is tracked still yields the next one.
 *
 * Since BRO-4931 the page is classified first (tour-page-class.js): only a
 * production becomes a candidate. A production with a tracked parent in any
 * market carries it (parentId; broadwayShowId too when it is a Broadway show);
 * one without is standalone and keyed page:<slug>. A page nothing can classify
 * is recorded with needsClassification so create-tour-entries.js can try
 * Wikipedia and route-tour-candidates.js can ask the owner.
 * @param {{slug: string, scheduleUrl: string, html: string, shows: object[], now?: Date, pageTitle?: string, overrides?: object, wikiText?: string}} args
 * @returns {{candidate: object, lifecycle?: object} | {skip: string, kind: string, pageClass?: object, lifecycle?: object}}
 */
function runningTourCandidate({ slug, scheduleUrl, html, shows, now = new Date(), pageTitle = null, overrides = {}, wikiText = '' }) {
  const rows = parseTourSchedule(html);
  const title = pageTitle || pageTitleFromHtml(html);
  const cls = classifyTourPage({ slug, pageTitle: title, rows, shows, overrides, wikiText });
  if (SKIPPED_CLASSES.has(cls.class)) return { skip: `${cls.class} page: ${cls.reason}`, kind: cls.class, pageClass: cls };
  if (!rows.length) return { skip: 'schedule parsed to no engagements', kind: 'nothing-running', pageClass: cls };
  // The title's tracked tours decide how this page splits (BRO-4724). A page
  // with no tracked production answers to its own title.
  const titleParent = cls.parentId ? parentForClass(cls, { slug, title, shows, segStart: null }) : null;
  const tourTitle = titleParent ? titleParent.title : (cls.title || title);
  const tracked = tourTitle ? toursOfTitle(tourTitle, shows) : [];
  const plan = lifecyclePlan({ segments: segmentTourRows(rows), html, tours: tracked });
  const segments = splitSegmentsAt(segmentTourRows(rows), plan.cuts);
  const lifecycle = { reopen: plan.reopen, undecided: plan.undecided };
  const running = currentSegment(segments, now);
  const options = [...(running ? [running] : []), ...upcomingSegments(segments, now).filter(s => s !== running)];
  if (!options.length) return { skip: 'no tour running now or booked to launch', kind: 'nothing-running', lifecycle, pageClass: cls };
  let skip = null;
  let kind = null;
  const note = (s, k) => { if (!skip) { skip = s; kind = k; } };
  for (const seg of options) {
    const segStart = seg.start.toISOString().slice(0, 10);
    const parent = parentForClass(cls, { slug, title, shows, segStart });
    // A title that matches a tracked production, none of which had opened by
    // this segment: not standalone (it would be refused as a tour of that
    // production) and not parented yet.
    if (cls.parentId && !parent) { note('no production of this title had opened by the tour\'s first engagement', 'no-parent'); continue; }
    const standaloneTitle = cls.title || title;
    if (!parent && !standaloneTitle) { note('page has no title to name a standalone tour', 'no-parent'); continue; }
    // A page nobody has classified is not worth a question for a one-off run.
    if (!parent && cls.class === 'unclassified' && tooFewStops(seg.rows)) { note(`only ${seg.rows.length} engagements and no tracked production`, 'too-few-stops'); continue; }
    // Already tracked: a tour of the title that covers this segment. Recording
    // it again would replace that tour's candidate row (and its createdTourId).
    // A running tour the page shows ending before this segment (knownEnds)
    // doesn't cover it. A standalone tour has no tourOf; it is matched by title.
    const endOf = t => t.closingDate || plan.knownEnds[t.id] || null;
    // The page a tour was built from also names it: a title drifts between the
    // page and the entry ("Dolly Parton's" vs "Dolly Parton’s", BRO-4931).
    const byTitle = toursOfTitle(parent ? parent.title : standaloneTitle, shows);
    const ofTitle = [...byTitle, ...(shows || []).filter(s => s.category === 'tour' && s.tourScheduleSlug === slug && !byTitle.includes(s))];
    const covering = ofTitle.find(t => t.openingDate
      && (!endOf(t) || endOf(t) >= segStart)
      && t.openingDate <= seg.end.toISOString().slice(0, 10));
    if (covering) { note(`already tracked as ${covering.id}`, 'tracked'); continue; }
    // Carried to create-tour-entries.js, which re-splits the page the same
    // way and lets a running predecessor that ends first stand aside.
    const predecessorEnds = Object.fromEntries(ofTitle.filter(t => !t.closingDate && plan.knownEnds[t.id] && plan.knownEnds[t.id] < segStart).map(t => [t.id, plan.knownEnds[t.id]]));
    const cuts = plan.cuts.filter(c => c < segStart);
    const isBroadway = parent && (parent.category || 'broadway') === 'broadway';
    return {
      candidate: {
        key: parent ? parent.id : `page:${slug}`,
        // Back-compat for rows and readers that predate BRO-4931: only a Broadway parent.
        ...(isBroadway ? { broadwayShowId: parent.id } : {}),
        ...(parent ? { parentId: parent.id } : {}),
        title: parent ? parent.title : standaloneTitle,
        ...(parent ? { type: parent.type || 'musical' } : (cls.type ? { type: cls.type } : {})),
        pageClass: cls.class,
        ...(cls.class === 'unclassified' ? { needsClassification: true } : {}),
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
      pageClass: cls,
      lifecycle,
    };
  }
  return { skip, kind, lifecycle, pageClass: cls };
}

/** A candidate row's ledger key: the tracked parent's id, or page:<slug> for a standalone tour. */
const candidateKey = c => c.key || c.broadwayShowId;

/**
 * One candidate per tour parent, or per normalised title for a standalone
 * tour (two pages for one show: "jersey-boys" and "jersey-boys-1"). Two
 * pages running a tour of the same show from different starts (two companies)
 * is ambiguous: the first is kept with an ambiguous note, so it is never
 * created automatically but still reaches the owner as a suggestion.
 * @returns {{candidates: object[], ambiguous: string[]}}
 */
function dedupeCandidates(candidates) {
  const byShow = new Map();
  for (const c of candidates) {
    const key = candidateKey(c);
    const k = String(key).startsWith('page:') && c.title ? `title:${normTitle(c.title)}` : key;
    if (!byShow.has(k)) byShow.set(k, []);
    byShow.get(k).push(c);
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

/**
 * The BWW roundup-only row (tour-roundup-candidate.js roundupOnlyCandidate)
 * that belongs to a Tours To You page row, or null: its title hint answers to
 * the page's slug or title. Rows that already created a tour are left alone.
 * @param {object} pageRow a candidate row from runningTourCandidate
 * @param {object[]} rows the candidate ledger
 */
function roundupRowFor(pageRow, rows) {
  if (!pageRow || !pageRow.tourScheduleSlug) return null;
  const wanted = new Set([...slugKeys(pageRow.tourScheduleSlug), ...titleKeys(pageRow.title)]);
  const hit = (rows || []).filter(r => r && String(r.key || '').startsWith('roundup:') && !r.createdTourId && r.roundupUrl && r.title
    && [...titleKeys(r.title)].some(k => wanted.has(k)));
  // Two roundups for one page is ambiguous: none is borrowed.
  return hit.length === 1 ? hit[0] : null;
}

module.exports = { PAGES_API, listShowPages, UPCOMING_DAYS, titleKey, titleKeys, slugKey, slugKeys, parentForSlug, parentForClass, upcomingSegments, lifecyclePlan, reopenBlocker, runningTourCandidate, dedupeCandidates, candidateKey, roundupRowFor };
