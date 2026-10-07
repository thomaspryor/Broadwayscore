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
 * - A launch date is written only when Wikipedia also names it: the date, a
 *   date inside the first engagement, or the launch city in the tour's year.
 * - A closing date is written only on a positive signal: a later segment of
 *   the same title has started, Wikipedia names that final date, or the page
 *   states a closed range for the tour ("Tour (2024–2026)"). Silence
 *   (an empty listing, a parse failure) never closes a tour.
 *
 * Pure: no I/O.
 */

const { foldDiacritics } = require('./title-match');
const { isSeparateTour, splitSegmentsAt } = require('./tour-history');

const DAY = 86400000;
// Tours lay off for a summer (Hadestown: June to October) without ending, so
// only a gap past six months, or a New York run, starts a new tour.
const SEGMENT_GAP_DAYS = 180;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Tours To You's legend marks: rescheduled (^ # +), venue season (§ † ‡ ❖),
// non-Equity (*), cancelled (♦, handled by the caller), info (ℹ).
const FOOTNOTE_MARKS = /[§†‡❖◆✦*¤♦^#+ℹ]/g;

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
  // Footnote marks after the date ("May 9-28, 2023 +") are the page's legend
  // (BRO-4723: Hamilton's "+" rows failed to parse and vanished).
  const s = decode(cell).replace(FOOTNOTE_MARKS, '').replace(/\s*[-–—]\s*/g, '–').trim();
  let m = s.match(/^([A-Za-z]+)\.? (\d{1,2}), (\d{4})–([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/);
  if (m) {
    const a = utc(+m[3], monthIndex(m[1]), +m[2]);
    let b = utc(+m[6], monthIndex(m[4]), +m[5]);
    // "November 17, 2022–January 14, 2022" (Lion King, BRO-4723): a range that
    // ends in an earlier month of the same year crosses New Year; the end year
    // is the typo.
    if (a && b && b < a && +m[6] === +m[3] && monthIndex(m[4]) < monthIndex(m[1])) b = utc(+m[6] + 1, monthIndex(m[4]), +m[5]);
    return a && b && b >= a ? { start: a, end: b } : null;
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
    const tableRows = [];
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || []).map(c => c.replace(/^<t[dh][^>]*>|<\/t[dh]>$/g, ''));
      if (cells.length < 3) continue;
      if (/♦/.test(decode(cells[2]))) continue;
      const range = parseDateRange(cells[2]);
      if (!range) continue;
      // Footnote marks on the city ("Chicago, IL ❖", "Dallas, TX †", "Pueblo, CO *")
      // are Tours To You's legend, not part of the name (BRO-4601).
      const city = decode(cells[0]).replace(FOOTNOTE_MARKS, ' ').replace(/\s+/g, ' ').trim();
      const venue = decode(cells[1]);
      tableRows.push({ city, venue, start: range.start, end: range.end });
    }
    for (const r of fixYearTypos(tableRows)) {
      const key = `${r.city}|${r.venue}|${r.start.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }
  return rows.sort((a, b) => a.start - b.start);
}

const shiftYears = (d, n) => utc(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate());

/**
 * Tours To You lists a table's engagements in date order, so a row a year off
 * from both neighbours, which sits between them once the year is fixed, has a
 * typo'd year (The Book of Mormon's "Manhattan, KS February 18-19, 2024"
 * between two February 2025 stops, BRO-4723). Pure; rows in table order.
 */
function fixYearTypos(rows) {
  return rows.map((r, i) => {
    const prev = rows[i - 1];
    const next = rows[i + 1];
    if (!prev || !next || prev.start > next.start) return r;
    for (const n of [1, -1]) {
      const off = n === 1 ? r.start < prev.start && r.start < next.start : r.start > prev.start && r.start > next.start;
      if (!off || Math.abs(r.start - prev.start) < 200 * DAY) continue;
      const start = shiftYears(r.start, n);
      const end = shiftYears(r.end, n);
      if (start && end && start >= prev.start && start <= next.start) return { ...r, start, end };
    }
    return r;
  });
}

/**
 * One company's path through rows that may hold several companies at once
 * (Hamilton's "Past Seasons" table runs the Angelica, Philip and And Peggy
 * companies together; The Lion King's runs two; BRO-4723). From the first
 * row, repeatedly take the earliest row starting on or after the current one
 * ends, stopping at a gap over gapDays. A company cannot play two cities at
 * once, so a schedule with no overlaps comes back unchanged. Pure; rows sorted
 * by start. Returns the path and the rows left out.
 */
function singleCompanyPath(rows, gapDays = SEGMENT_GAP_DAYS) {
  if (!rows.length) return { kept: [], dropped: [] };
  // Same start: the row that ends first is this company's next stop, the
  // longer one is the other company's sit-down.
  const order = [...rows].sort((x, y) => x.start - y.start || x.end - y.end);
  const kept = [order[0]];
  for (const r of order.slice(1)) {
    const cur = kept[kept.length - 1];
    if (r.start < cur.end) continue;
    if ((r.start - cur.end) / DAY > gapDays) break;
    kept.push(r);
  }
  const keep = new Set(kept);
  return { kept, dropped: rows.filter(r => !keep.has(r)) };
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
/**
 * Article prose only: citations carry their own dates (access-date, the
 * source's publish date) that say nothing about the tour. Come From Away's
 * "access-date=September 20, 2026" matched its tour's first stop (BRO-4325).
 */
function proseOnly(wikiText) {
  return String(wikiText || '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{\s*cite[\s\S]*?\}\}/gi, '');
}

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
  const t = proseOnly(wikiText);
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
  const openers = seg.rows.filter(r => r.start.getTime() <= limit);
  const prose = proseOnly(wikiText);
  const row = openers.find(r => wikiNamesLaunch(prose, r.start))
    // Wikipedia often names the launch another way (BRO-4325): opening night
    // inside the first engagement (Water for Elephants: previews Sep 27,
    // "premiered on September 30, 2025"), or the launch city with its month
    // or season ("began in September 2026, starting from the Hippodrome
    // Theatre in Baltimore"; "launch in fall of 2026 in Cleveland"). Both must
    // sit in tour text; the city beside a launch word.
    || (wikiNamesOpeningInside(prose, seg.rows[0]) ? seg.rows[0] : null)
    || openers.find(r => wikiNamesLaunchCity(prose, r));
  return row ? row.start : null;
}

// A BroadwayWorld national-tour roundup is published after the launch press
// night: from a few days before the first engagement (an early press
// performance) to ROUNDUP_LAUNCH_DAYS after it. Inside that window it confirms
// the schedule's first engagement as the launch when Wikipedia hasn't caught
// up yet, the usual case for a tour a few weeks old (Operation Mincemeat:
// Tours To You from 2026-09-20, BWW "Launches North American Leg" roundup
// 2026-09-30, Wikipedia silent; BRO-4563).
const ROUNDUP_LAUNCH_DAYS = 45;
function roundupConfirmsLaunch(seg, roundupDate) {
  if (!seg || !roundupDate) return false;
  const at = new Date(`${String(roundupDate).slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(at)) return false;
  return at >= seg.start.getTime() - 3 * DAY && at <= seg.start.getTime() + ROUNDUP_LAUNCH_DAYS * DAY;
}

// Tour text about another country's production is never evidence for a
// North American launch ("the Australian tour opened ... 14 March 2026").
const FOREIGN_PRODUCTION = /\b(uk|united kingdom|british|west end|england|scotland|ireland|irish|australia|australian|new zealand|germany|german|japan|japanese|korea|korean|china|chinese|europe|european|international)\b/i;

/** Windows of wikitext around each mention of a tour, where launch facts sit. */
function tourWindows(wikiText, radius = 300) {
  const t = String(wikiText || '');
  const out = [];
  for (const m of t.matchAll(/\btour(s|ing|ed)?\b/gi)) out.push(t.slice(Math.max(0, m.index - radius), m.index + radius));
  return out;
}

/**
 * Sentences near a mention of a tour that could state a North American
 * launch: they name a launch word and no other country's production. The
 * launch fact (date, or city and month) must sit in one such sentence, so a
 * UK tour sentence next door neither confirms nor blocks it.
 */
function launchSentences(wikiText) {
  const out = new Set();
  for (const w of tourWindows(wikiText, 250)) {
    for (const s of w.split(/(?<=[.!?])\s+|\n+/)) {
      if (LAUNCH_WORD.test(s) && !FOREIGN_PRODUCTION.test(s)) out.add(s);
    }
  }
  return [...out];
}

/**
 * Wikipedia's tour text names a launch, but not in this row's city: the page
 * lost the real opener (Harry Potter: Tours To You starts at Seattle, the
 * article says the tour began in Denver). Silence is not a contradiction.
 * Only launches dated the row's year or the year before count: an article
 * also tells how earlier tours and the premiere began (Legally Blonde's 2008
 * tour, Shucked's 2022 premiere), which says nothing about this one.
 */
function wikiNamesOtherLaunch(wikiText, row) {
  const city = String((row && row.city) || '').split(',')[0].trim().toLowerCase();
  const year = row && row.start ? row.start.getUTCFullYear() : null;
  const anyYear = /\b(1[89]|20)\d{2}\b/g;
  const sentences = launchSentences(proseOnly(wikiText))
    // Infobox fields ("| premiere_location = Golden Gate Theatre, San Francisco") are not tour text.
    .filter(s => !/^\s*\|/.test(s))
    // A sentence clipped at the edge of its window can lose its year
    // ("...launched in Jackson, Mississippi, on September"): judge whole ones.
    .filter(s => /[.!?]['"”’)\]]*\s*$/.test(s))
    // A launch dated some other year is another tour's (or the premiere's).
    .filter(s => !year || (s.match(anyYear) || []).every(y => Math.abs(Number(y) - year) <= 1));
  // A sentence agreeing on month and year that names no place at all is no
  // contradiction: "a 2nd National tour would begin in January, 2027"
  // (Shucked). One naming another city still is (Harry Potter: Denver, May
  // 2026, while the page starts at a later stop).
  const month = year ? new RegExp(`\\b${MONTHS[row.start.getUTCMonth()]}\\b[^.]{0,12}\\b${year}\\b`, 'i') : null;
  const monthNames = new RegExp(`\\b(${MONTHS.join('|')})\\b`, 'gi');
  const namesPlace = s => /\b(in|at|from)\s+(the\s+)?\[{0,2}[A-Z][a-z]/.test(s.replace(monthNames, '').replace(/\b(fall|spring|summer|winter|autumn)\b/gi, ''));
  return sentences.length > 0 && !sentences.some(s => s.toLowerCase().includes(city) || (month && month.test(s) && !namesPlace(s)));
}

const LAUNCH_WORD = /\b(launch|premier|began|begin|start|kick(ed|s)? off|open(ed|s)? (in|at|on))/i;

/**
 * Tour text names this date beside a launch word. A date in a table of stops
 * is not a launch: Harry Potter's article lists Seattle on 22 August 2026, but
 * the tour began in Denver in May (BRO-4325).
 */
function wikiNamesLaunch(prose, d) {
  const forms = wikiForms(d);
  return launchSentences(prose).some(s => forms.some(f => s.includes(f)));
}

/**
 * Wikipedia says the tour ends in the month and year of the last listed stop
 * ("a North American tour began in September 2025 and is scheduled to end in
 * August 2026"; Suffs, BRO-4325), in one North American sentence. Only used
 * once that stop has passed with nothing listed after it, so a tour that
 * extends shows later stops and a later month.
 */
function wikiNamesClosingMonth(wikiText, d) {
  const when = new RegExp(`\\b${MONTHS[d.getUTCMonth()]}\\s+(\\d{1,2},\\s+)?${d.getUTCFullYear()}\\b`, 'i');
  for (const w of tourWindows(proseOnly(wikiText), 250)) {
    for (const s of w.split(/(?<=[.!?])\s+|\n+/)) {
      if (/\btour/i.test(s) && /\b(clos(e|ed|es|ing)|end(ed|s|ing)?|conclud|final performance)\b/i.test(s)
        && !FOREIGN_PRODUCTION.test(s) && when.test(s)) return true;
    }
  }
  return false;
}

/**
 * Opening night in the first week of the engagement (previews first), named
 * in tour text. A week, not the whole engagement: a months-long sit-down
 * would otherwise take any date in its run.
 */
function wikiNamesOpeningInside(wikiText, row) {
  const windows = launchSentences(wikiText);
  const last = Math.min(row.end.getTime(), row.start.getTime() + 7 * DAY);
  for (let t = row.start.getTime() + DAY; t <= last; t += DAY) {
    const forms = wikiForms(new Date(t));
    if (windows.some(w => forms.some(f => w.includes(f)))) return true;
  }
  return false;
}

const SEASONS = { spring: [2, 3, 4], summer: [5, 6, 7], fall: [8, 9, 10], autumn: [8, 9, 10], winter: [11, 0, 1] };

/**
 * Tour text names the engagement's city, its month or season with its year
 * ("September 2026", "September 13, 2026", "fall of 2026"), and a launch word.
 * A bare year is not enough: Beauty and the Beast "opened in June 2025 ... in
 * Chicago", but the Chicago stop began July 9.
 */
function wikiNamesLaunchCity(wikiText, row) {
  const city = String(row.city || '').split(',')[0].trim();
  if (city.length < 4) return false;
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cityRe = new RegExp(`\\b${esc(city)}\\b`, 'i');
  const y = row.start.getUTCFullYear();
  const mi = row.start.getUTCMonth();
  const month = MONTHS[mi];
  const seasons = Object.keys(SEASONS).filter(k => SEASONS[k].includes(mi)).join('|');
  const whenRe = new RegExp(`\\b(${month}(\\s+\\d{1,2},)?\\s+${y}|(${seasons})\\s+(of\\s+)?${y})\\b`, 'i');
  return launchSentences(wikiText).some(s => cityRe.test(s) && whenRe.test(s));
}

/**
 * Which segment is this tour?
 * - Known launch: the segment holding it.
 * - Id year ({title}-tour-2022): the one segment whose named launch is that year.
 * - Otherwise (a new tour from a roundup): the segment whose named launch falls
 *   within 120 days before the roundup was first seen (a week after, for
 *   listings that lag).
 * - A tour found running (segmentStart): the segment starting then.
 * No match = null, never a guess.
 */
function pickSegment(segments, tour, wikiText, { seenAt, segmentStart, roundupDate } = {}) {
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
  // A tour found running on its schedule page (tour-discovery.js): the segment
  // discovery saw, by its first engagement.
  if (segmentStart) {
    const at = new Date(`${String(segmentStart).slice(0, 10)}T00:00:00Z`).getTime();
    const hit = tours.filter(s => Math.abs(s.start.getTime() - at) <= 7 * DAY);
    return hit.length === 1 ? hit[0] : null;
  }
  const seen = seenAt ? new Date(seenAt) : null;
  if (!seen || Number.isNaN(seen.getTime())) return null;
  const near = named.filter(x => x.launch <= new Date(seen.getTime() + 7 * DAY) && x.launch >= new Date(seen.getTime() - 120 * DAY));
  if (near.length === 1) return near[0].s;
  // No Wikipedia-named launch near the roundup: the one segment the roundup's
  // own date confirms (BRO-4563).
  if (near.length === 0 && roundupDate) {
    const hit = tours.filter(s => roundupConfirmsLaunch(s, roundupDate));
    return hit.length === 1 ? hit[0] : null;
  }
  return null;
}

/**
 * The one tour segment running at now (from 30 days before its first
 * engagement to its last), or null. A tour that has ended is not running:
 * created from here it would be marked open (BRO-4331 covers closed tours).
 * Two running at once (Hamilton's companies share a page) returns null.
 */
function currentSegment(segments, now = new Date()) {
  const t = now.getTime();
  const hit = segments.filter(s => s.rows.length > 1 && s.start.getTime() - 30 * DAY <= t && t <= s.end.getTime() + DAY);
  return hit.length === 1 ? hit[0] : null;
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
 * @param {{seenAt?: string, segmentStart?: string, roundupDate?: string, cuts?: string[]}} [opts] when the roundup for a new tour was first seen, or the first engagement of a tour found running; roundupDate is the BWW roundup's slug date (BRO-4563); cuts split segments where a tracked tour closed (BRO-4724)
 * @returns {{write: {openingDate?: string, closingDate?: string}, notes: string[], problem?: string}}
 */
function decideTourDates(tour, scheduleHtml, wikiText, now = new Date(), opts = {}) {
  const rows = parseTourSchedule(scheduleHtml);
  if (rows.length === 0) return { write: {}, notes: [], problem: 'schedule page parsed to zero engagements (layout change or wrong page)' };
  // opts.cuts: dates a tracked tour of the title closed mid-segment, the rows
  // after which the page's history calls a new tour (tour-discovery.js
  // lifecyclePlan, BRO-4724).
  const segments = splitSegmentsAt(segmentTourRows(rows), opts.cuts);
  const seg = pickSegment(segments, tour, wikiText, opts);
  if (!seg) return { write: {}, notes: [`${segments.length} segment(s), none matches this tour`], problem: 'no schedule segment matches this tour' };

  const write = {};
  const wikiLaunch = segmentLaunch(seg, wikiText);
  const roundupLaunch = !wikiLaunch && roundupConfirmsLaunch(seg, opts.roundupDate) ? seg.start : null;
  // Opt-in (create-tour-entries only, BRO-4601): a tour whose first listed
  // engagement is within opts.freshLaunchDays of today is launching now, so
  // that engagement IS the launch. Never for an older segment: Tours To You
  // keeps only recent rows, so a long-running tour's first row is not its
  // launch (Wicked's page starts in 2021, Hamilton's in Sept 2020).
  const freshLaunch = !wikiLaunch && !roundupLaunch && opts.freshLaunchDays > 0
    && seg.rows.length >= 3 && seg.start.getTime() <= now.getTime() && now.getTime() - seg.start.getTime() <= opts.freshLaunchDays * DAY
    && !wikiNamesOtherLaunch(wikiText, seg.rows[0])
    ? seg.start : null;
  // Opt-in too: a tour not yet launched (tour-discovery.js upcomingSegments). Its
  // first listed engagement is its launch for the same reason, and more
  // surely: Tours To You drops past rows, never future ones.
  const upcomingLaunch = !wikiLaunch && !roundupLaunch && !freshLaunch && opts.upcomingDays > 0
    && seg.rows.length >= 3 && seg.start.getTime() > now.getTime()
    && seg.start.getTime() - now.getTime() <= opts.upcomingDays * DAY
    && !wikiNamesOtherLaunch(wikiText, seg.rows[0])
    ? seg.start : null;
  const launch = wikiLaunch || roundupLaunch || freshLaunch || upcomingLaunch;
  const launchSource = wikiLaunch ? 'wikipedia' : roundupLaunch ? 'bww-roundup' : freshLaunch ? 'tourstoyou-fresh' : upcomingLaunch ? 'tourstoyou-upcoming' : null;
  const notes = [`segment ${iso(seg.start)}..${iso(seg.end)} (${seg.rows.length} engagements)`];
  if (!tour.openingDate) {
    if (launch) write.openingDate = iso(launch);
    else notes.push('no engagement date in this segment is named by Wikipedia; launch left unset');
    if (roundupLaunch) notes.push(`launch ${iso(roundupLaunch)} confirmed by the BroadwayWorld roundup dated ${String(opts.roundupDate).slice(0, 10)} (Wikipedia silent)`);
    if (freshLaunch) notes.push(`launch ${iso(freshLaunch)} is the first listed engagement of a tour launching now (within ${opts.freshLaunchDays} days; Wikipedia and roundups silent)`);
    if (upcomingLaunch) notes.push(`launch ${iso(upcomingLaunch)} is the first listed engagement of a tour booked ahead (within ${opts.upcomingDays} days; Wikipedia and roundups silent)`);
  } else if (launch && Math.abs(new Date(`${tour.openingDate}T00:00:00Z`) - launch) / DAY > 14) {
    notes.push(`stored launch ${tour.openingDate} differs from ${iso(launch)} by >14 days`);
  }

  // Closing needs a positive signal. A later segment only counts when a New
  // York run sits between them (a new production, not a summer layoff).
  const idx = segments.indexOf(seg);
  const next = segments.slice(idx + 1).find(s => s.rows.length > 1);
  // Or when the page's history names the later block as another tour
  // (BRO-4724: "2nd North American Tour (2027–"), so a tour followed by a
  // separately booked one closes once that one starts. The tracked launch
  // first, as lifecyclePlan uses: the page may have dropped the early rows.
  const separateTourStarted = next && next.start <= now
    && (next.afterNewYork || isSeparateTour({ html: scheduleHtml, earlierLaunch: tour.openingDate || launch || seg.start, laterStart: next.start }).separate === true);
  const launchYear = (launch || seg.start).getUTCFullYear();
  // Stated on the schedule page's history note or in a Wikipedia section
  // heading ("=== North American tour (2024–2026) ===").
  const stated = [...statedClosedRanges(scheduleHtml), ...statedClosedRanges(wikiText)]
    .some(r => r.from === launchYear && r.to === seg.end.getUTCFullYear());
  const ended = seg.end.getTime() + DAY <= now.getTime();
  if (ended && !tour.closingDate) {
    if (wikiNamesClosing(wikiText, seg.end)) write.closingDate = iso(seg.end);
    else if (wikiNamesClosingMonth(wikiText, seg.end)) write.closingDate = iso(seg.end);
    else if (stated) write.closingDate = iso(seg.end);
    else if (separateTourStarted) write.closingDate = iso(seg.end);
    else notes.push(`last listed stop ended ${iso(seg.end)} but nothing confirms the tour closed; left open`);
  }
  // The segment decided on, so a caller can check its engagements against
  // other tours (duplicateScheduleOf).
  return { write, notes, launchSource, segmentRows: seg.rows };
}

/** Tours To You slug guesses for a title ("MJ" is listed as mj-the-musical). */
function scheduleSlugs(tour) {
  if (tour && tour.tourScheduleSlug) return [tour.tourScheduleSlug];
  const base = foldDiacritics(String((tour && tour.title) || '')).toLowerCase()
    .replace(/&/g, 'and').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base ? [base, `${base}-the-musical`] : [];
}

/**
 * The tour in `schedules` ({ <id>: { stops: [{city, venue, start}] } }, the
 * shape of data/tour-schedules.json) whose stops share at least `min`
 * engagements (same city, venue and start) with `rows`, or null. Tours To You
 * once showed Operation Mincemeat's 2026 table on the Come From Away page
 * (BRO-4601); two different shows never play the same house on the same
 * opening day three times. `rows` may carry Date or YYYY-MM-DD starts.
 */
function duplicateScheduleOf(rows, schedules, { exceptId = null, min = 3 } = {}) {
  const key = r => `${r.city}|${r.venue}|${r.start instanceof Date ? iso(r.start) : String(r.start).slice(0, 10)}`;
  const mine = new Set((rows || []).map(key));
  for (const [id, entry] of Object.entries(schedules || {})) {
    if (id === exceptId) continue;
    const shared = ((entry && entry.stops) || []).filter(s => mine.has(key(s))).length;
    if (shared >= min) return id;
  }
  return null;
}

// A national tour plays many cities. Liberation's 2026 "tour" (Berkeley Rep,
// Geffen, Studio Theatre: three nonprofit regional engagements) was
// auto-created as a tour on 2026-10-06 and is not one (BRO-4262 review).
const MIN_TOUR_STOPS = 4;
function tooFewStops(rows) {
  return Array.isArray(rows) && rows.length < MIN_TOUR_STOPS;
}

module.exports = {
  MIN_TOUR_STOPS,
  tooFewStops,
  wikiNamesOtherLaunch,
  launchSentences,
  proseOnly,
  duplicateScheduleOf,
  parseDateRange,
  parseTourSchedule,
  fixYearTypos,
  singleCompanyPath,
  segmentTourRows,
  pickSegment,
  currentSegment,
  segmentLaunch,
  wikiNamesOpeningInside,
  wikiNamesLaunchCity,
  wikiNamesClosingMonth,
  decideTourDates,
  roundupConfirmsLaunch,
  ROUNDUP_LAUNCH_DAYS,
  statedClosedRanges,
  scheduleSlugs,
  wikiNames,
  SEGMENT_GAP_DAYS,
};
