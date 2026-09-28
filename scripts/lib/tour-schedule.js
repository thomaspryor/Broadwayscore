'use strict';

/**
 * Tour schedule parsing and date decisions (BRO-4262).
 *
 * Source: Tours To You (tourstoyou.org/shows/{slug}/), a volunteer site that
 * lists every engagement of a touring production (city, venue, dates) in plain
 * HTML and keeps past seasons. Cross-check: the show's Wikipedia wikitext.
 * Chosen after testing IBDB, broadway.org, BroadwayWorld (bot-blocked),
 * official sites (JS-rendered) and Playbill (upcoming stops only).
 *
 * Rules (from the research against Beetlejuice, Life of Pi, Kimberly Akimbo, MJ):
 * - Rows marked ♦ are rescheduled/cancelled and ignored.
 * - A gap of more than 8 weeks between engagements starts a new segment: a
 *   second tour, or a sit-down run before the tour (Life of Pi's Toronto run).
 * - A launch date is written only when Wikipedia also names it.
 * - A closing date is written only on a positive signal: a later segment of
 *   the same title has started, Wikipedia names that final date, or the page
 *   states a closed range for the tour ("Tour (2024–2026)"). Silence
 *   (an empty listing, a parse failure) never closes a tour.
 *
 * Pure: no I/O.
 */

const DAY = 86400000;
const SEGMENT_GAP_DAYS = 56;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function utc(y, m, d) {
  const t = Date.UTC(y, m, d);
  const dt = new Date(t);
  return dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}

function monthIndex(name) {
  const i = MONTHS.findIndex(m => m.startsWith(String(name || '').toLowerCase().slice(0, 3)));
  return i >= 0 ? i : null;
}

/**
 * Parse an engagement date cell. Handles "December 1, 2022", "June 22-24, 2027",
 * "October 29–November 3, 2024", "December 30, 2025–January 4, 2026".
 * @returns {{start: Date, end: Date}|null}
 */
function parseDateRange(cell) {
  const s = decode(cell).replace(/[♦§*†]/g, '').replace(/\s*[-–—]\s*/g, '–').trim();
  let m = s.match(/^([A-Za-z]+)\.? (\d{1,2}), (\d{4})–([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/);
  if (m) {
    const a = utc(+m[3], monthIndex(m[1]), +m[2]);
    const b = utc(+m[6], monthIndex(m[4]), +m[5]);
    return a && b ? { start: a, end: b } : null;
  }
  m = s.match(/^([A-Za-z]+)\.? (\d{1,2})–([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/);
  if (m) {
    const a = utc(+m[5], monthIndex(m[1]), +m[2]);
    const b = utc(+m[5], monthIndex(m[3]), +m[4]);
    return a && b && b >= a ? { start: a, end: b } : null;
  }
  m = s.match(/^([A-Za-z]+)\.? (\d{1,2})–(\d{1,2}), (\d{4})$/);
  if (m) {
    const a = utc(+m[4], monthIndex(m[1]), +m[2]);
    const b = utc(+m[4], monthIndex(m[1]), +m[3]);
    return a && b && b >= a ? { start: a, end: b } : null;
  }
  m = s.match(/^([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/);
  if (m) {
    const a = utc(+m[3], monthIndex(m[1]), +m[2]);
    return a ? { start: a, end: a } : null;
  }
  return null;
}

/**
 * Every engagement row on a Tours To You show page (current schedule and past
 * seasons), de-duplicated and sorted by start date.
 * @returns {Array<{city, venue, start: Date, end: Date}>}
 */
function parseTourSchedule(html) {
  const rows = [];
  const seen = new Set();
  for (const table of String(html || '').match(/<table[\s\S]*?<\/table>/g) || []) {
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || []).map(c => c.replace(/^<t[dh][^>]*>|<\/t[dh]>$/g, ''));
      if (cells.length < 3) continue;
      if (/♦/.test(decode(cells[2]))) continue;
      const range = parseDateRange(cells[2]);
      if (!range) continue;
      const city = decode(cells[0]).replace(/\s*§\s*/g, '').trim();
      const venue = decode(cells[1]);
      const key = `${city}|${venue}|${range.start.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ city, venue, start: range.start, end: range.end });
    }
  }
  return rows.sort((a, b) => a.start - b.start);
}

const isNewYorkRun = r => /^new york,? ny\b|^broadway\b/i.test(r.city);

/**
 * Split engagements into runs separated by more than SEGMENT_GAP_DAYS. A New
 * York engagement is a Broadway run, never a tour stop: it is left out and
 * always ends the current segment (Beetlejuice's 2025 Palace return sat
 * between its first and second tours).
 */
function segmentTourRows(rows, gapDays = SEGMENT_GAP_DAYS) {
  const segments = [];
  let broken = false;
  for (const r of rows) {
    if (isNewYorkRun(r)) { broken = true; continue; }
    const cur = segments[segments.length - 1];
    if (cur && !broken && (r.start - cur.end) / DAY <= gapDays) {
      cur.rows.push(r);
      if (r.end > cur.end) cur.end = r.end;
    } else {
      segments.push({ start: r.start, end: r.end, rows: [r] });
    }
    broken = false;
  }
  return segments;
}

const iso = d => d.toISOString().slice(0, 10);
const wikiForms = d => {
  const m = MONTHS[d.getUTCMonth()];
  const cap = m[0].toUpperCase() + m.slice(1);
  return [`${cap} ${d.getUTCDate()}, ${d.getUTCFullYear()}`, `${d.getUTCDate()} ${cap} ${d.getUTCFullYear()}`, iso(d)];
};
/** Wikipedia names this date (either date style, or ISO in a template). */
function wikiNames(wikiText, d) {
  const t = String(wikiText || '');
  return wikiForms(d).some(f => t.includes(f));
}

/**
 * Which segment is this tour? The one holding its known launch date; for a tour
 * with no launch date, the one Wikipedia dates (a launch it names), preferring
 * the latest. A single-engagement sit-down segment is never a tour.
 */
function pickSegment(segments, tour, wikiText) {
  const tours = segments.filter(s => s.rows.length > 1);
  const launch = tour && tour.openingDate ? new Date(`${String(tour.openingDate).slice(0, 10)}T00:00:00Z`) : null;
  if (launch && !Number.isNaN(launch.getTime())) {
    return tours.find(s => launch >= new Date(s.start.getTime() - 7 * DAY) && launch <= s.end) || null;
  }
  const named = tours.filter(s => wikiNames(wikiText, s.start));
  // Tour ids carry the launch year ({title}-tour-2022): with two tours of a
  // title, that year says which one this entry is.
  const idYear = Number((String((tour && tour.id) || '').match(/-tour-(\d{4})$/) || [])[1]);
  if (idYear) {
    const sameYear = named.filter(s => s.start.getUTCFullYear() === idYear);
    return sameYear.length === 1 ? sameYear[0] : null;
  }
  return named.length ? named[named.length - 1] : null;
}

/**
 * Closed year ranges the schedule page states for a tour, e.g. "First North
 * American Tour (2024–2026)". An open range ("2022–") is not a closing.
 */
function statedClosedRanges(html) {
  const text = decode(String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/g, ' '));
  const out = [];
  const re = /\btour\b[^.()]{0,40}\(?\s*(\d{4})\s*[–-]\s*(\d{4})\b/gi;
  let m;
  while ((m = re.exec(text))) out.push({ from: +m[1], to: +m[2] });
  return out;
}

/**
 * Decide what to write for one tour entry.
 * @param {object} tour shows.json tour entry (openingDate/closingDate may be null)
 * @param {string} scheduleHtml Tours To You page
 * @param {string} wikiText Wikipedia raw wikitext of the show's article
 * @returns {{write: {openingDate?: string, closingDate?: string}, notes: string[], problem?: string}}
 */
function decideTourDates(tour, scheduleHtml, wikiText, now = new Date()) {
  const rows = parseTourSchedule(scheduleHtml);
  if (rows.length === 0) return { write: {}, notes: [], problem: 'schedule page parsed to zero engagements (layout change or wrong page)' };
  const segments = segmentTourRows(rows);
  const seg = pickSegment(segments, tour, wikiText);
  if (!seg) return { write: {}, notes: [`${segments.length} segment(s), none matches this tour`], problem: 'no schedule segment matches this tour' };

  const write = {};
  const notes = [`segment ${iso(seg.start)}..${iso(seg.end)} (${seg.rows.length} engagements)`];
  if (!tour.openingDate) {
    if (wikiNames(wikiText, seg.start)) write.openingDate = iso(seg.start);
    else notes.push(`launch ${iso(seg.start)} not confirmed by Wikipedia; left unset`);
  } else if (Math.abs(new Date(`${tour.openingDate}T00:00:00Z`) - seg.start) / DAY > 14) {
    notes.push(`stored launch ${tour.openingDate} differs from schedule ${iso(seg.start)} by >14 days`);
  }

  const later = segments.find(s => s.start > seg.end && s.rows.length > 1 && s.start <= now);
  const ended = seg.end < now;
  if (ended && !tour.closingDate) {
    const stated = statedClosedRanges(scheduleHtml)
      .some(r => r.from === seg.start.getUTCFullYear() && r.to === seg.end.getUTCFullYear());
    if (later) write.closingDate = iso(seg.end);
    else if (wikiNames(wikiText, seg.end)) write.closingDate = iso(seg.end);
    else if (stated) write.closingDate = iso(seg.end);
    else notes.push(`last listed stop ended ${iso(seg.end)} but nothing confirms the tour closed; left open`);
  }
  return { write, notes };
}

/** Tours To You slug guesses for a title ("MJ" is listed as mj-the-musical). */
function scheduleSlugs(tour) {
  if (tour && tour.tourScheduleSlug) return [tour.tourScheduleSlug];
  const base = String((tour && tour.title) || '').toLowerCase()
    .replace(/&/g, 'and').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base ? [base, `${base}-the-musical`] : [];
}

module.exports = {
  parseDateRange,
  parseTourSchedule,
  segmentTourRows,
  pickSegment,
  decideTourDates,
  statedClosedRanges,
  scheduleSlugs,
  wikiNames,
  SEGMENT_GAP_DAYS,
};
