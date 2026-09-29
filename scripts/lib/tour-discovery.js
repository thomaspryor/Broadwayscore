'use strict';

/**
 * Find national tours already on the road (BRO-4325).
 *
 * Auto-create (create-tour-entries.js) used to start only from a new
 * BroadwayWorld national-tour roundup, so tours running before launch never
 * arrived: the category held three closed tours while about forty were out.
 * Tours To You lists every touring show as a WordPress page under /shows/
 * (252 pages via the pages API; the /shows/ index shows only 54). For each
 * page whose title is a Broadway show, a schedule segment running now is a
 * tour candidate. create-tour-entries.js then applies the same evidence rules
 * as for a roundup (Wikipedia confirms the launch, no earlier tour open).
 *
 * Pure: callers fetch the pages list and schedules.
 */

const { foldDiacritics } = require('./title-match');
const { parseTourSchedule, segmentTourRows, currentSegment } = require('./tour-schedule');

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

/**
 * The Broadway production a tour of this schedule page descends from: the
 * latest Broadway production of the title that opened before the tour's
 * first engagement. Null when no Broadway show has the title.
 */
function parentForSlug(slug, shows, beforeIso) {
  const key = slugKey(slug);
  if (!key) return null;
  const before = String(beforeIso || '').slice(0, 10);
  const matches = (shows || []).filter(s => (s.category || 'broadway') === 'broadway'
    && s.openingDate && (!before || s.openingDate <= before)
    && titleKeys(s.title).has(key));
  matches.sort((a, b) => b.openingDate.localeCompare(a.openingDate));
  return matches[0] || null;
}

/**
 * The tour on this schedule page that is running now, as a candidate row,
 * or {skip} saying why not.
 * @returns {{candidate: object} | {skip: string}}
 */
function runningTourCandidate({ slug, scheduleUrl, html, shows, now = new Date() }) {
  const rows = parseTourSchedule(html);
  if (!rows.length) return { skip: 'schedule parsed to no engagements' };
  const seg = currentSegment(segmentTourRows(rows), now);
  if (!seg) return { skip: 'no tour running now' };
  const segStart = seg.start.toISOString().slice(0, 10);
  const parent = parentForSlug(slug, shows, segStart);
  if (!parent) return { skip: 'no Broadway show of this title' };
  return {
    candidate: {
      broadwayShowId: parent.id,
      title: parent.title,
      source: 'tourstoyou',
      slug: `tourstoyou:${slug}:${segStart}`,
      url: scheduleUrl,
      tourScheduleSlug: slug,
      segmentStart: segStart,
    },
  };
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

module.exports = { PAGES_API, titleKey, titleKeys, slugKey, parentForSlug, runningTourCandidate, dedupeCandidates };
