'use strict';

/**
 * Is a later run of a title's tour the same tour or a new one (BRO-4724)?
 *
 * A Tours To You page lists every company of a title in one table. Rows
 * resuming after a tour closed, or a second block of rows after a running
 * tour's last stop, can be the same tour back from a layoff or a new company.
 * The page's History tab names its tours: "2nd North American Tour (2026–",
 * "First North American Tour (2024–2026)", "North American Tour 2025–".
 * Those labels, and a New York run between the two blocks, are the evidence.
 *
 * Pure: no I/O.
 */

const { tourParentCategory } = require('./tour-family');

const DAY = 86400000;

function decode(s) {
  return String(s || '')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '–')
    .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&nbsp;|&#160;/g, ' ');
}

// A UK, West End or other overseas company says nothing about the US tour.
const OVERSEAS_RE = /\b(uk|u\.k\.|west end|london|ireland|australia|australian|canad|asia|europe|international|world)\b/i;
const YEARS_RE = /^\(?\s*(\d{4})\s*[–-]\s*(\d{4})?\s*\)?$/;
// A tour's own name ("2nd North American Tour", "National Tour"), not a
// "Tour recoupment" or "Pre-Tour Notes" line.
const TOUR_NAME_RE = /\b(?:north american|national|u\.?s\.?)\s+tour$/i;

/**
 * The tours a page's History tab names, in page order:
 * [{ name, from, to }] (to null for a running tour). Labels with no years are
 * dropped (a "The First National Tour was delayed..." note is prose).
 */
function tourHistoryLabels(html) {
  const raw = String(html || '');
  const at = raw.search(/<strong>\s*History\s*<\/strong>/i);
  if (at < 0) return [];
  // The History tab panel ends at the next tab panel (or a generous cap).
  const rest = raw.slice(at);
  const end = rest.search(/<div id="elementor-tab-content|data-tab="\d+"\s+role="tabpanel"|<\/section>/i);
  const block = rest.slice(0, end > 0 ? end : 6000);
  const lines = decode(block).replace(/<[^>]*>/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // "2nd North American Tour (2026–" can arrive as one line or two.
    const inline = lines[i].match(/^(.{3,60}?\btour)\s*(\(?\s*\d{4}\s*[–-]\s*(?:\d{4})?\s*\)?)$/i);
    const name = inline && TOUR_NAME_RE.test(inline[1]) ? inline[1] : (lines[i].length <= 60 && TOUR_NAME_RE.test(lines[i]) ? lines[i] : null);
    if (!name) continue;
    // Years on the name's own line or the one right after it: a later
    // "2026-2027" season heading belongs to no label.
    const y = (inline ? inline[2] : lines[i + 1] || '').match(YEARS_RE);
    if (y) out.push({ name: name.trim(), from: +y[1], to: y[2] ? +y[2] : null });
  }
  return out.filter(l => !OVERSEAS_RE.test(l.name));
}

const yearOf = d => (d instanceof Date ? d : new Date(`${String(d).slice(0, 10)}T00:00:00Z`)).getUTCFullYear();

/**
 * Is a later block of engagements a different tour from the one that
 * launched at earlierLaunch? true / false from evidence, null when the page
 * doesn't say.
 * @param {{html: string, earlierLaunch: string|Date, laterStart: string|Date, afterNewYork?: boolean}} args
 * @returns {{separate: boolean|null, reason: string}}
 */
function isSeparateTour({ html, earlierLaunch, laterStart, afterNewYork = false }) {
  // Project convention (segmentTourRows): a Broadway run between two blocks
  // makes them two productions (Beetlejuice 2022 and 2026).
  if (afterNewYork) return { separate: true, reason: 'a New York run sits between them' };
  const labels = tourHistoryLabels(html);
  const first = yearOf(earlierLaunch);
  const later = yearOf(laterStart);
  const fmt = l => `"${l.name} (${l.from}–${l.to || ''})"`;
  // A tour the page says began after the earlier one launched, by the time
  // the later rows start: A Beautiful Noise's "2nd North American Tour (2026–".
  const newer = labels.find(l => l.from > first && l.from <= later);
  if (newer) return { separate: true, reason: `Tours To You history lists ${fmt(newer)}` };
  // The earlier tour stated closed before the later rows' year:
  // Shucked's "First North American Tour (2024–2026)" and a 2027 leg.
  const closed = labels.find(l => l.from === first && l.to != null && l.to < later);
  if (closed) return { separate: true, reason: `Tours To You history lists ${fmt(closed)}, closed before ${later}` };
  // One tour, running since the earlier launch: the later rows continue it.
  if (labels.length === 1 && labels[0].from === first && labels[0].to == null) {
    return { separate: false, reason: `Tours To You history lists one tour, ${fmt(labels[0])}, still running` };
  }
  return { separate: null, reason: labels.length ? `Tours To You history (${labels.map(fmt).join(', ')}) does not say` : 'Tours To You lists no tour history' };
}

/**
 * Split segments at each cut date: a segment's rows starting after a cut
 * become their own segment. Used where a tracked tour closed mid-segment and
 * the evidence says the rows after it are a new tour.
 * @param {Array<{start: Date, end: Date, rows: object[], afterNewYork?: boolean}>} segments
 * @param {string[]} cuts YYYY-MM-DD
 */
function splitSegmentsAt(segments, cuts) {
  const at = (cuts || []).filter(Boolean).map(c => new Date(`${String(c).slice(0, 10)}T00:00:00Z`).getTime() + DAY - 1);
  if (!at.length) return segments;
  const out = [];
  for (const seg of segments) {
    let rows = [];
    let pieces = [];
    for (const r of seg.rows) {
      if (rows.length && at.some(c => rows[rows.length - 1].start.getTime() <= c && r.start.getTime() > c)) { pieces.push(rows); rows = []; }
      rows.push(r);
    }
    pieces.push(rows);
    if (pieces.length === 1) { out.push(seg); continue; }
    pieces.forEach((p, i) => out.push({
      start: p[0].start,
      end: new Date(Math.max(...p.map(r => r.end.getTime()))),
      rows: p,
      afterNewYork: i === 0 ? !!seg.afterNewYork : false,
    }));
  }
  return out;
}

const WRITER_ROLE_RE = /book|music|lyric|playwright|written|script|libretto|adapt/i;

/** A production's writers (book, music, lyrics, playwright), lowercased. */
function writersOf(show) {
  return new Set(((show && show.creativeTeam) || [])
    .filter(c => WRITER_ROLE_RE.test(String(c.role || '')))
    .flatMap(c => String(c.name || '').split(/\s*(?:,|&|\band\b)\s*/))
    .map(n => n.trim().toLowerCase()).filter(Boolean));
}

/**
 * Different works sharing a title among the productions a tour can descend
 * from (TOUR_PARENT_CATEGORIES), as groups of production ids.
 * Productions linked by isRevival/originalProductionId are one work, and so
 * are productions sharing a writer; one with no writers listed can't be told
 * apart and is left out. More than one group means the title alone can't say
 * which work a tour descends from: "A Christmas Carol" is Jack Thorne's 2019
 * play and the Dickens/Patrick Stewart solo shows; a small-town tour of the
 * title was matched to the 2022 Jefferson Mays production (BRO-4724).
 */
function distinctWorksOfTitle(title, shows, type = null) {
  const key = String(title || '').trim().toLowerCase();
  const originals = (shows || []).filter(s => tourParentCategory(s)
    && String(s.title || '').trim().toLowerCase() === key && !s.isRevival && !s.originalProductionId
    && (!type || !s.type || s.type === type));
  const withWriters = originals.map(s => ({ id: s.id, w: writersOf(s) })).filter(x => x.w.size);
  const groups = [];
  for (const x of withWriters) {
    const hits = groups.filter(g => [...x.w].some(n => g.w.has(n)));
    const merged = { ids: [x.id], w: new Set(x.w) };
    for (const g of hits) { merged.ids.push(...g.ids); for (const n of g.w) merged.w.add(n); groups.splice(groups.indexOf(g), 1); }
    groups.push(merged);
  }
  return groups.map(g => g.ids.sort());
}

module.exports = { tourHistoryLabels, isSeparateTour, splitSegmentsAt, writersOf, distinctWorksOfTitle };
