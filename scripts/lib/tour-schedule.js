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

const { foldDiacritics } = require('./title-match');

const DAY = 86400000;
// Tours lay off for a summer (Hadestown: June to October) without ending, so
// only a gap past six months, or a New York run, starts a new tour.
const SEGMENT_GAP_DAYS = 180;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#x201[34];|&ndash;|&mdash;/gi, '–')
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
    // "December 30–January 4, 2026": the year belongs to the end date.
    const crossesYear = monthIndex(m[3]) < monthIndex(m[1]);
    const a = utc(+m[5] - (crossesYear ? 1 : 0), monthIndex(m[1]), +m[2]);
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
 * between its first and second tours). Each segment records whether a New
 * York run preceded it (afterNewYork).
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
      segments.push({ start: r.start, end: r.end, rows: [r], afterNewYork: broken && segments.length > 0 });
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
 * Wikipedia names this date as a tour's end: the date appears within 300
 * characters of "tour" and of a closing word, not anywhere in the article
 * (a last listed stop's date can show up in an unrelated sentence).
 */
function wikiNamesClosing(wikiText, d) {
  const t = String(wikiText || '');
  for (const form of wikiForms(d)) {
    let i = t.indexOf(form);
    while (i !== -1) {
      const around = t.slice(Math.max(0, i - 300), i + form.length + 300);
      if (/\btour/i.test(around) && /\b(clos|final|end(ed|s)?\b|conclud|last performance)/i.test(around)) return true;
      i = t.indexOf(form, i + 1);
    }
  }
  return false;
}

/**
 * A segment's launch: the first engagement Wikipedia names. Skips openers a
 * tour isn't dated from (Life of Pi's Toronto sit-down before Baltimore;
 * Kimberly Akimbo's Utica previews before the Denver launch, when named).
 */
function segmentLaunch(seg, wikiText) {
  // Only an opener: a mid-tour stop's date can appear in the article too.
  // 120 days covers a sit-down run before the tour proper (Life of Pi:
  // Toronto in September, Baltimore launch in December).
  const limit = seg.start.getTime() + 120 * DAY;
  const row = seg.rows.find(r => r.start.getTime() <= limit && wikiNames(wikiText, r.start));
  return row ? row.start : null;
}

/**
 * Which segment is this tour?
 * - Known launch: the segment holding it.
 * - Id year ({title}-tour-2022): the one segment whose named launch is that year.
 * - Otherwise (a new tour from a roundup): the segment whose named launch falls
 *   within 120 days before the roundup was first seen (a week after, for
 *   listings that lag). No match = null, never a guess.
 */
function pickSegment(segments, tour, wikiText, { seenAt } = {}) {
  const tours = segments.filter(s => s.rows.length > 1);
  const launch = tour && tour.openingDate ? new Date(`${String(tour.openingDate).slice(0, 10)}T00:00:00Z`) : null;
  if (launch && !Number.isNaN(launch.getTime())) {
    return tours.find(s => launch >= new Date(s.start.getTime() - 7 * DAY) && launch <= s.end) || null;
  }
  const named = tours.map(s => ({ s, launch: segmentLaunch(s, wikiText) })).filter(x => x.launch);
  const idYear = Number((String((tour && tour.id) || '').match(/-tour-(\d{4})$/) || [])[1]);
  if (idYear) {
    const sameYear = named.filter(x => x.launch.getUTCFullYear() === idYear);
    return sameYear.length === 1 ? sameYear[0].s : null;
  }
  const seen = seenAt ? new Date(seenAt) : null;
  if (!seen || Number.isNaN(seen.getTime())) return null;
  const near = named.filter(x => x.launch <= new Date(seen.getTime() + 7 * DAY) && x.launch >= new Date(seen.getTime() - 120 * DAY));
  return near.length === 1 ? near[0].s : null;
}

/**
 * Closed year ranges stated for the NORTH AMERICAN tour: Wikipedia section
 * headings ("=== North American tour (2024–2026) ===") and the schedule page's
 * headings/history labels ("First North American Tour (2024–2026)"). Body text
 * and sidebars are ignored, and so is anything naming a UK tour: a loose match
 * could close a running US tour. An open range ("2022–") is not a closing.
 */
function statedClosedRanges(source) {
  const raw = String(source || '');
  const wikiHeadings = raw.match(/^=+[^=\n]+=+\s*$/gm) || [];
  // Headings, and a list item's own text up to its nested list (Tours To You's
  // History tab: <li><span>First North American Tour</span> (2024–2026)<ul>…).
  const htmlLabels = [
    ...(raw.match(/<h[1-6][^>]*>[\s\S]{0,200}?<\/h[1-6]>/gi) || []),
    ...(raw.match(/<li[^>]*>[\s\S]{0,200}?(?=<ul|<\/li>)/gi) || []),
  ].map(decode);
  const out = [];
  for (const line of [...wikiHeadings, ...htmlLabels]) {
    const text = decode(line);
    if (/\b(uk|west end|london|australia|canad)/i.test(text)) continue;
    const m = text.match(/\b(north american|national|us)\s+tour\b[^()]{0,20}\(?\s*(\d{4})\s*[–-]\s*(\d{4})\b/i);
    if (m) out.push({ from: +m[2], to: +m[3] });
  }
  return out;
}

/**
 * Decide what to write for one tour entry.
 * @param {object} tour shows.json tour entry (openingDate/closingDate may be null)
 * @param {string} scheduleHtml Tours To You page
 * @param {string} wikiText Wikipedia raw wikitext of the show's article
 * @param {Date} [now]
 * @param {{seenAt?: string}} [opts] when the roundup for a new tour was first seen
 * @returns {{write: {openingDate?: string, closingDate?: string}, notes: string[], problem?: string}}
 */
function decideTourDates(tour, scheduleHtml, wikiText, now = new Date(), opts = {}) {
  const rows = parseTourSchedule(scheduleHtml);
  if (rows.length === 0) return { write: {}, notes: [], problem: 'schedule page parsed to zero engagements (layout change or wrong page)' };
  const segments = segmentTourRows(rows);
  const seg = pickSegment(segments, tour, wikiText, opts);
  if (!seg) return { write: {}, notes: [`${segments.length} segment(s), none matches this tour`], problem: 'no schedule segment matches this tour' };

  const write = {};
  const launch = segmentLaunch(seg, wikiText);
  const notes = [`segment ${iso(seg.start)}..${iso(seg.end)} (${seg.rows.length} engagements)`];
  if (!tour.openingDate) {
    if (launch) write.openingDate = iso(launch);
    else notes.push('no engagement date in this segment is named by Wikipedia; launch left unset');
  } else if (launch && Math.abs(new Date(`${tour.openingDate}T00:00:00Z`) - launch) / DAY > 14) {
    notes.push(`stored launch ${tour.openingDate} differs from ${iso(launch)} by >14 days`);
  }

  // Closing needs a positive signal. A later segment only counts when a New
  // York run sits between them (a new production, not a summer layoff).
  const idx = segments.indexOf(seg);
  const next = segments.slice(idx + 1).find(s => s.rows.length > 1);
  const separateTourStarted = next && next.afterNewYork && next.start <= now;
  const launchYear = (launch || seg.start).getUTCFullYear();
  // Stated on the schedule page's history note or in a Wikipedia section
  // heading ("=== North American tour (2024–2026) ===").
  const stated = [...statedClosedRanges(scheduleHtml), ...statedClosedRanges(wikiText)]
    .some(r => r.from === launchYear && r.to === seg.end.getUTCFullYear());
  const ended = seg.end.getTime() + DAY <= now.getTime();
  if (ended && !tour.closingDate) {
    if (wikiNamesClosing(wikiText, seg.end)) write.closingDate = iso(seg.end);
    else if (stated) write.closingDate = iso(seg.end);
    else if (separateTourStarted) write.closingDate = iso(seg.end);
    else notes.push(`last listed stop ended ${iso(seg.end)} but nothing confirms the tour closed; left open`);
  }
  return { write, notes };
}

/** Tours To You slug guesses for a title ("MJ" is listed as mj-the-musical). */
function scheduleSlugs(tour) {
  if (tour && tour.tourScheduleSlug) return [tour.tourScheduleSlug];
  const base = foldDiacritics(String((tour && tour.title) || '')).toLowerCase()
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
