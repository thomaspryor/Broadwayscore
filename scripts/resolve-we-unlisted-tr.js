#!/usr/bin/env node
/**
 * WE historical review-led discovery, step 1 (BRO-5031): look up each
 * unlisted reviewed production on Theatre Record and save its production
 * header (title, venue, run dates) for promote-historical-we.js.
 *
 * discover-historical-shows-we.js builds candidates only from WhatsOnStage
 * London listings. Reviews at West End venues with no listing (Company at the
 * Gielgud 2018, NT Antony and Cleopatra, Fleabag, Royal Court plays) land in
 * `unlistedReviews` and were never promoted. TR has a production page per
 * London opening with the run dates; a review's own date is never used as a
 * run date.
 *
 * TR needs a subscriber login (TR_EMAIL / TR_PASSWORD), which only GitHub
 * Actions holds, so this runs in we-historical-tr-resolve.yml. It writes the
 * raw header text (no review text) to
 * data/audit/we-historical-review-led-<season>.json; parsing the dates
 * happens in lib/we-review-led-candidates.js at promote time, so a parser fix
 * needs no second TR run.
 *
 * Usage:
 *   node scripts/resolve-we-unlisted-tr.js --seasons=2019-2020,2020-2021
 *   node scripts/resolve-we-unlisted-tr.js --seasons=2019-2020 --dry-run   # list lookups, no TR
 */

// venue-write-guard-ok: TR search-result venues go only into the public audit lookup file, never shows.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { selectLookups, pickTrForReview, reviewLedPath, headerFacts, parseTrHeaderDates, dateSnippets, trVenueName } = require('./lib/we-review-led-candidates');
const { isLondonVenue } = require('./lib/tr-london-venue');
const { cleanSearchTitle } = require('./lib/title-normalization');
const { venueFamily } = require('./lib/we-historical-corroboration');
const { azLookups } = require('./lib/we-az-lookups');
const { normalizeTitle } = require('./lib/title-match');

const ROOT = path.join(__dirname, '..');
const USAGE = `resolve-we-unlisted-tr.js — Theatre Record lookups for WE reviews with no WOS listing (BRO-5031).

Usage:
  node scripts/resolve-we-unlisted-tr.js --seasons=2019-2020[,2020-2021...] [--dry-run]
  node scripts/resolve-we-unlisted-tr.js --seasons=2015-2016 --resume [--budget-min=35]   # also looks up data/audit/we-historical-az-<season>.json titles (BRO-6298); keeps finished rows
  node scripts/resolve-we-unlisted-tr.js --dateless [--dry-run]   # existing closed WE rows with no openingDate (BRO-5850)

Needs TR_EMAIL and TR_PASSWORD (GitHub Actions: we-historical-tr-resolve.yml).
Writes data/audit/we-historical-review-led-<season>.json.`;

const PDF_HEADER_MAX_LINES = 40;
const DATE_LINE = /^\s*\d{1,2}\s+[A-Z][a-z]+\s+\d{4}\s*$/;

/**
 * The production block of a PDF-era issue: from an ALL-CAPS heading that IS
 * the title (a contents line "HANSARD 1234" or a two-column line does not
 * count) to the first review's date line, reduced by headerFacts() to the
 * title lines and date phrases. The file is public: never review prose.
 *
 * An issue prints the title more than once (contents, the production listing
 * with its run dates, the "Reviews" heading above the reviews). Headings
 * just under a "Reviews" marker are skipped, the exact title is tried before
 * a THE-variant ("FATHER" before "THE FATHER", another show), and only a
 * block that parses to a date is returned: an undated block has nothing the
 * promoter can use.
 */
/**
 * TR prints a run-date label and its date on separate lines ("Press Night"
 * then "05 Sep 2019"), or, in a -layout PDF, as a row of labels over a row
 * of dates. pairLabelLines() joins each into "Press Night 05 Sep 2019" so the
 * label-led parsers can read it, and folds TR's synonyms onto the labels
 * parseTrHeaderDates() knows ("Previews / Opens" -> "Previews",
 * "Last Performance" -> "Closes").
 */
const LABEL_SYNONYMS = [
  [/^previews?\s*\/\s*opens?/i, 'Previews'],
  [/^first performance/i, 'First preview'],
  [/^(?:opens?\s*\/\s*press night|first night|press (?:performance|date)|opening (?:performance|date))/i, 'Press night'],
  [/^(?:(?:last|final) (?:performance|night)|closing (?:date|night))/i, 'Closes'],
];
const LABEL_ONLY = /^(?:press night|first preview|previews?|opening night|opening|opens|opened|closes|closing|until|runs until|final performance)\s*:?$/i;
const DATE_ONLY = /^\s*(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+)?\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+\.?\s+\d{4}\s*$/;

/** A cell that is only a run-date label, folded onto a known label; else null. */
function labelCell(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  for (const [rx, to] of LABEL_SYNONYMS) {
    const m = t.match(new RegExp(`${rx.source}\\s*:?$`, 'i'));
    if (m) { t = to; break; }
  }
  return LABEL_ONLY.test(t) ? t.replace(/\s*:$/, '') : null;
}

/** "Previews / Opens 22 Aug 2019" -> "Previews 22 Aug 2019"; other lines unchanged. */
function canonLabelLine(line) {
  const t = String(line || '').replace(/\s+/g, ' ').trim();
  for (const [rx, to] of LABEL_SYNONYMS) {
    const m = t.match(rx);
    if (m && DATE_ONLY.test(t.slice(m[0].length).replace(/^\s*:?/, ''))) return `${to} ${t.slice(m[0].length).replace(/^\s*:?\s*/, '')}`;
  }
  return line;
}

function pairLabelLines(lines) {
  const out = [];
  const nextFilled = k => { while (k < lines.length && !lines[k].trim()) k++; return k; };
  for (let i = 0; i < lines.length; i++) {
    // A stack of label lines followed by the same number of date lines, zipped
    // in order (one label over one date is the common case). Any other count
    // is ambiguous and left unpaired.
    if (labelCell(lines[i])) {
      const labels = [];
      let k = i;
      while (k < lines.length && labelCell(lines[k])) { labels.push(labelCell(lines[k])); k = nextFilled(k + 1); }
      const dates = [];
      let end = k;
      while (k < lines.length && DATE_ONLY.test(lines[k]) && dates.length < labels.length) { dates.push(lines[k].trim()); end = k; k = nextFilled(k + 1); }
      if (dates.length === labels.length) {
        labels.forEach((l, n) => out.push(`${l} ${dates[n]}`));
        i = end;
        continue;
      }
      if (labels.length > 1) {
        // Ambiguous stack: keep it whole so no tail label pairs on its own.
        let last = i;
        for (let n = 0, m = i; n < labels.length; n++, m = nextFilled(m + 1)) last = m;
        out.push(...lines.slice(i, last + 1));
        i = last;
        continue;
      }
    }
    // A -layout row of labels over a row of dates.
    const j = nextFilled(i + 1);
    const cells = lines[i].trim().split(/\s{2,}/);
    const dateCells = j < lines.length ? lines[j].trim().split(/\s{2,}/) : [];
    if (cells.length > 1 && cells.length === dateCells.length
        && cells.every(c => labelCell(c)) && dateCells.every(d => DATE_ONLY.test(d))) {
      cells.forEach((c, n) => out.push(`${labelCell(c)} ${dateCells[n]}`));
      i = j;
      continue;
    }
    out.push(canonLabelLine(lines[i]));
  }
  return out;
}

const capsKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const pdfTitleKey = title => capsKey(cleanSearchTitle(String(title || '')).replace(/^(.*)\s+\(The\)$/i, 'The $1'));

const TR_ISSUE_BANNER = /\bIssue\s+\d+(?:\s*[-–]\s*\d+)?(?:\s+Openings)?(?:\s+\d{1,2}\s*[-–]\s*\d{1,2}\s+[A-Za-z]+\s+\d{4})?/gi;

function pdfHeaderFor(text, title, venue, opts = {}) {
  const want = pdfTitleKey(title);
  if (!want) return null;
  const variants = [...new Set([want.replace(/^THE /, ''), `THE ${want.replace(/^THE /, '')}`])].filter(v => v !== want);
  const lines = String(text || '').split('\n');
  for (const keys of [new Set([want]), new Set(variants)]) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line !== line.toUpperCase() || !/[A-Z]/.test(line)) continue;
      if (!keys.has(capsKey(line))) continue;
      if (lines.slice(Math.max(0, i - 5), i).some(l => l.trim() === 'Reviews')) continue;
      // Pair labels inside the block only (a heading like OPENING NIGHT is
      // matched raw), then stop at the first unpaired date line: a review's.
      const raw = [];
      for (let j = i + 1; j < lines.length && j <= i + PDF_HEADER_MAX_LINES; j++) {
        if (lines[j].trim() === 'Reviews') break;
        raw.push(lines[j]);
      }
      const block = [line];
      for (const full of pairLabelLines(raw)) {
        // 2018 PDF running head, e.g. "Issue 17-18 Openings 1-30 September 2018":
        // cut just the banner, keeping whatever -layout printed either side.
        const l = full.replace(TR_ISSUE_BANNER, ' ').replace(/\s{2,}$/, '').trimEnd();
        if (!l.trim()) continue;
        if (DATE_LINE.test(l)) break;
        block.push(l);
      }
      const facts = headerFacts(block.join('\n'));
      const d = parseTrHeaderDates(facts);
      if (d.previewsStartDate || d.openingDate || d.closingDate) return facts;
    }
  }
  return pdfContentsRowFor(text, want, variants, opts.page) || pdfIndexRowFor(text, want, variants, opts.volume, opts.page)
    || pdfOpeningsFor(text, want, variants, venue);
}

/** "30 Apr 18" -> "2018-04-30"; null for an impossible date. */
function readPdfDate(day, month, year) {
  const y = Number(year) < 100 ? 2000 + Number(year) : Number(year);
  const iso = parseTrHeaderDates(`Press night ${day} ${month} ${y}`).openingDate;
  return iso && new Date(iso).toISOString().slice(0, 10) === iso ? iso : null;
}

const CONTENTS_ROW = /^(.+?)\s+[–—-]\s+.*?\s(\d{1,2})\s+([A-Z][a-z]{2,8})\.?\s+(\d{2}|\d{4})(?:\s+(\d{1,2})\s+([A-Z][a-z]{2,8})\.?\s+(\d{2}|\d{4}))?\s+(\d{1,4})$/;
// 2016 issues print the same table without years: "... Royal Court 16 Nov 23 Dec 1297".
const CONTENTS_ROW_YEARLESS = /^(.+?)\s+[–—-]\s+.*?\s(\d{1,2})\s+([A-Z][a-z]{2,8})\.?(?:\s+(\d{1,2})\s+([A-Z][a-z]{2,8})\.?)?\s+(\d{1,4})$/;
const ISSUE_PERIOD = /Theatre Record\s+(\d{1,2})(?:\s+([A-Z][a-z]+))?\s*[–—-]\s*(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})/g;

/**
 * The issue's own covering period from its running head, e.g.
 * "Theatre Record 04 – 17 November 2016" or "21 October – 03 November 2016".
 * The most frequent banner wins; null when none prints or two tie.
 */
function issuePeriod(text) {
  const counts = new Map();
  for (const m of String(text || '').matchAll(ISSUE_PERIOD)) {
    const end = readPdfDate(m[3], m[4], m[5]);
    if (!end) continue;
    let start = readPdfDate(m[1], m[2] || m[4], m[5]);
    if (start && start > end) start = readPdfDate(m[1], m[2] || m[4], Number(m[5]) - 1);
    if (!start) continue;
    const k = `${start}|${end}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!counts.size) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked[1] && ranked[1][1] === ranked[0][1]) return null; // a tie names no issue
  const [start, end] = ranked[0][0].split('|');
  return { start, end };
}

/**
 * A yearless press night takes the year that puts it near the issue's own
 * period (up to 31 days before it, 7 after): a production is reviewed in the
 * issue covering its press night. Both or neither year fitting fails closed.
 */
function yearFromIssue(day, month, period) {
  const DAY = 86400000;
  const lo = Date.parse(period.start) - 31 * DAY;
  const hi = Date.parse(period.end) + 7 * DAY;
  const endYear = Number(period.end.slice(0, 4));
  const fits = [endYear - 1, endYear].map(y => readPdfDate(day, month, y)).filter(d => d && Date.parse(d) >= lo && Date.parse(d) <= hi);
  return fits.length === 1 ? fits[0] : null;
}

/**
 * 2017-18 issues (BRO-5851): the production pages print no dates, but the
 * issue's contents table has one row per production under the header
 * "Production Venue Opening Closing Page", e.g.
 *   "NINE NIGHT – A new play by Natasha Gordon National, Dorfman 30 Apr 18 26 May 18 355".
 * Opening is press night. A row whose page number equals the link's page is
 * this production. Without a page there is no positional anchor (a wrapped
 * row can join the next one, a dateless row can absorb a review line), so
 * /issue/N#page= links skip this path. A row that wraps is joined with up to
 * two following lines, never a byline. A line holding a second "TITLE –" row
 * (two -layout columns) and conflicting rows fail closed.
 */
function pdfContentsRowFor(text, want, variants, page) {
  if (page == null) return null;
  const lines = String(text || '').replace(/\f/g, '\n').split('\n').map(l => l.replace(/\s+/g, ' ').trim());
  const startsRow = l => /^[^a-z]{2,}?\s+[–—-]\s+/.test(l);
  const byline = l => /^[A-Z][a-z]+(?: [A-Z][A-Za-z'’-]+)+, /.test(l);
  const secondRow = r => /\s[A-Z][A-Z'’&.]+(?: [A-Z'’&.]+)*\s+[–—-]\s+/.test(r.replace(/^.+?\s+[–—-]\s+/, ' '));
  const maxYear = new Date().getUTCFullYear();
  let period;
  for (const keys of [new Set([want]), new Set(variants)]) {
    const matches = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (!startsRow(lines[i])) continue;
      const rows = [lines[i]];
      for (let k = 1; k <= 2 && lines[i + k] && !startsRow(lines[i + k]) && !byline(lines[i + k]); k++) rows.push(`${rows[k - 1]} ${lines[i + k]}`);
      // A yeared row cut after its opening year ("... 30 Apr 18") reads as a
      // complete yearless one, so every join is tried yeared first.
      let row = rows.find(r => CONTENTS_ROW.test(r));
      let m = row && row.match(CONTENTS_ROW);
      if (!m) {
        row = rows.find(r => CONTENTS_ROW_YEARLESS.test(r));
        const y = row && row.match(CONTENTS_ROW_YEARLESS);
        if (y) m = [y[0], y[1], y[2], y[3], null, y[4], y[5], null, y[6]];
      }
      if (!m || !keys.has(pdfTitleKey(m[1]))) continue;
      if (Number(m[8]) !== Number(page)) continue;
      if (secondRow(row)) return null;
      let start;
      if (m[4]) start = readPdfDate(m[2], m[3], m[4]);
      else {
        period = period === undefined ? issuePeriod(text) : period;
        start = period && yearFromIssue(m[2], m[3], period);
      }
      if (!start || Number(start.slice(0, 4)) > maxYear) return null;
      let close = null;
      if (m[5]) {
        // A yearless close is in the start's year, or the next when it falls before it.
        close = readPdfDate(m[5], m[6], m[7] || start.slice(0, 4));
        if (close && !m[7] && close < start) {
          // Rolled into the next year: a run past ~10 months, or a typo like
          // "16 Nov 14 Nov", cannot be told apart from a real date, so no close.
          close = readPdfDate(m[5], m[6], Number(start.slice(0, 4)) + 1);
          if (close && Date.parse(close) - Date.parse(start) > 300 * 86400000) close = undefined;
        }
        if (close === null || (close && close < start)) return null;
      }
      matches.add(`${want}\nPress night ${m[2]} ${m[3]} ${start.slice(0, 4)}${close ? `\nCloses ${m[5]} ${m[6]} ${close.slice(0, 4)}` : ''}`);
    }
    if (matches.size) return matches.size === 1 ? [...matches][0] : null;
  }
  return null;
}

const INDEX_ROW = /^(.+?)\s+[–—-]\s+.*?\s(\d{1,2})\s+([A-Z][a-z]{2,8})\.?\s+(\d{2}|\d{4})\s+(\d{1,3})\/(\d{1,4})(?:\s|$)/;

/**
 * 2016 volume-end issues carry a cumulative index, one row per production
 * with its press night and "volume/page" (BRO-5851), e.g.
 *   "NO MAN'S LAND – Revival of play by Harold Pinter Wyndham's 20 Sep 16 36/1005 Corner Shop 0".
 * Only a row whose volume/page is the link's own counts; it gives press night
 * only. Conflicting rows fail closed.
 */
function pdfIndexRowFor(text, want, variants, volume, page) {
  if (volume == null || page == null) return null;
  const lines = String(text || '').replace(/\f/g, '\n').split('\n').map(l => l.replace(/\s+/g, ' ').trim());
  const maxYear = new Date().getUTCFullYear();
  for (const keys of [new Set([want]), new Set(variants)]) {
    const matches = new Set();
    for (const line of lines) {
      const m = line.match(INDEX_ROW);
      if (!m || !keys.has(pdfTitleKey(m[1]))) continue;
      if (Number(m[5]) !== Number(volume) || Number(m[6]) !== Number(page)) continue;
      const start = readPdfDate(m[2], m[3], m[4]);
      if (!start || Number(start.slice(0, 4)) > maxYear) return null;
      matches.add(`${want}\nPress night ${m[2]} ${m[3]} ${start.slice(0, 4)}`);
    }
    if (matches.size) return matches.size === 1 ? [...matches][0] : null;
  }
  return null;
}

/**
 * Older issues print dates as venue rows in Openings, not labelled production
 * headers. Match both title and venue, and save only the factual date fields.
 * The first date is press night; a yearless close inherits the start year,
 * rolling forward only when its month/day precedes the start. No issue or
 * review date supplies a missing start year. Conflicting rows fail closed.
 */
function pdfOpeningsFor(text, want, variants, venue) {
  if (!venue) return null;
  const wantedVenue = venueFamily(trVenueName(venue));
  const lines = String(text || '').replace(/\f/g, '\n').split('\n');
  const rowDate = /^(.+?)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}|\d{2})(?:\s*(?:\||[–-]|to)\s*|\s+)?(?:(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}|\d{2}))?)?\s*$/;
  const readDate = readPdfDate;
  for (const keys of [new Set([want]), new Set(variants)]) {
    const matches = new Set();
    let inOpenings = false;
    let matchedTitle = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(?:Issue\s+\d+(?:\s*[-–]\s*\d+)?\s+)?Openings(?:\s+\d.*)?$/i.test(line)) {
        inOpenings = true;
        matchedTitle = false;
        continue;
      }
      if (/^(?:Reviews|Contents|Index)\b/i.test(line)) { inOpenings = false; matchedTitle = false; continue; }
      if (!inOpenings) continue;
      if (keys.has(pdfTitleKey(line))) { matchedTitle = true; continue; }
      const row = line.match(rowDate);
      if (!row) {
        // Author credits may separate a title from its venue rows.
        if (!/^by\s+/i.test(line)) matchedTitle = false;
        continue;
      }
      if (!matchedTitle || !isLondonVenue(row[1], { pdfEra: true })
          || venueFamily(trVenueName(row[1])) !== wantedVenue) continue;
      const start = readDate(row[2], row[3], row[4]);
      if (!start) return null;
      let close = null;
      if (row[5]) {
        close = readDate(row[5], row[6], row[7] || start.slice(0, 4));
        if (close && !row[7] && close < start) close = readDate(row[5], row[6], Number(start.slice(0, 4)) + 1);
        if (!close || close < start) return null;
      }
      matches.add(`${want}\nPress night ${row[2]} ${row[3]} ${start.slice(0, 4)}${close ? `\nCloses ${row[5]} ${row[6]} ${close.slice(0, 4)}` : ''}`);
    }
    if (matches.size) return matches.size === 1 ? [...matches][0] : null;
  }
  return null;
}

const LOG_DATE = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+\d{4})?/gi;

/**
 * CI-log diagnostics for a PDF where no dated header was found: for each
 * heading that matches the title, its line offset and, for the next 40
 * lines, each date with at most 24 characters before it (enough to show a
 * label like "Press Night" or "Closes", too little to carry review text).
 * Goes to the Actions log only, never to the committed file.
 */
function logDateContext(text, title, mode) {
  const want = pdfTitleKey(title).replace(/^THE /, '');
  const lines = String(text || '').split('\n');
  let shown = 0;
  for (let i = 0; i < lines.length && shown < 4; i++) {
    const key = capsKey(lines[i].trim()).replace(/^THE /, '');
    if (!key || key !== want) continue;
    shown++;
    const underReviews = lines.slice(Math.max(0, i - 5), i).some(l => l.trim() === 'Reviews');
    console.log(`    [${mode}] heading at line ${i}${underReviews ? ' (under Reviews)' : ''}`);
    for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
      const flat = lines[j].replace(/\s+/g, ' ');
      for (const m of flat.matchAll(LOG_DATE)) {
        let before = flat.slice(Math.max(0, m.index - 24), m.index).trim();
        if (!before) {
          // A date alone on its line: its label is the line above (40 chars max).
          let k = j - 1;
          while (k > i && !lines[k].trim()) k--;
          before = `[prev] ${lines[k].replace(/\s+/g, ' ').trim().slice(0, 40)}`;
        }
        console.log(`      +${j - i}: …${before} | ${m[0]}`);
      }
    }
  }
  if (!shown) console.log(`    [${mode}] no heading equal to "${want}"`);
  logOpeningsContext(lines, want, mode);
}

/**
 * CI-log diagnostics for the issue's Openings listing (BRO-5851): pre-2019
 * production pages print no dates, so the run dates live in listing rows
 * elsewhere in the issue. For up to 6 non-heading lines that contain the
 * title, print that line and the next 2, each cut to 90 characters: enough to
 * show the venue/date row layout, too little to carry review text.
 */
function logOpeningsContext(lines, want, mode) {
  if (!want) return;
  const openings = lines.reduce((n, l) => n + (/^\s*(?:Issue\s+\d+\S*\s+)?Openings\b/i.test(l) ? 1 : 0), 0);
  console.log(`    [${mode}] Openings headings: ${openings}`);
  let hits = 0;
  for (let i = 0; i < lines.length && hits < 6; i++) {
    const key = capsKey(lines[i].trim()).replace(/^THE /, '');
    if (!key || key === want || !key.includes(want)) continue;
    // Only a line that parses as a contents or index row (all facts) prints
    // past 90 characters; neighbours and other long lines never do.
    const flat = lines[i].replace(/\s+/g, ' ').trim();
    const contentsRow = [CONTENTS_ROW, CONTENTS_ROW_YEARLESS, INDEX_ROW].some(re => re.test(flat));
    if (!contentsRow && flat.length > 120) continue;
    hits++;
    const cut = s => s.replace(/\s+/g, ' ').trim().slice(0, 90);
    console.log(`    [${mode}] title row @${i}: ${contentsRow ? flat.slice(0, 160) : cut(lines[i])} || ${cut(lines[i + 1] || '')} || ${cut(lines[i + 2] || '')}`);
  }
}

const LABEL_LINE = /^(?:press night|first preview|previews?|opening night|opens|opened|closes|closing|until|runs until|final performance)\b/i;

/**
 * HTML-era production page: the title plus the date phrases from short lines
 * that START with a run-date label ("Press Night 05 Sep 2019",
 * "Closes 05 Oct 2019"). Lines elsewhere on the page (reviews) are ignored,
 * so a date a critic mentions is never read as the run.
 */
function htmlHeaderFor(title, text) {
  const facts = [];
  for (const raw of pairLabelLines(String(text || '').split('\n'))) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!LABEL_LINE.test(line) || line.split(' ').length > 10) continue;
    for (const sn of dateSnippets(line)) if (!facts.includes(sn)) facts.push(sn);
  }
  return facts.length ? [String(title || '').trim(), ...facts].join('\n') : null;
}

/**
 * Search strings for a WOS review title. Double bills and seasons
 * ("Pinter Seven A Slight Ache / The Dumb Waiter", "Her Naked Skin/Votes for
 * Women! in Courage Everywhere") are also searched by each part, since TR
 * may file them under its own title.
 */
function searchTitles(title) {
  const full = cleanSearchTitle(title);
  const parts = full.split(/\s*(?:\/|:|\bin\b)\s*/).map(s => s.trim())
    .filter(s => s && s !== full && (s.split(' ').length >= 2 || s.length >= 6));
  return [...new Set([full, ...parts])].slice(0, 4);
}

const DATELESS_KEY = 'dateless';
const datelessPath = root => path.join(root, 'data', 'audit', 'we-dateless-tr-lookups.json');

/**
 * BRO-5850: lookups for existing closed West End rows with no openingDate.
 * The row's own previews start (else its closing date) stands in for the
 * review date, so pickTrForReview() only accepts a TR issue within a few
 * months of that run; the TR header's press night is then checked against
 * the row's own run window at plan time (plan-we-dateless-openings.js).
 */
function datelessLookups(root) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const lookups = [];
  const dropped = [];
  for (const s of shows) {
    if (s.market !== 'west-end' || s.status !== 'closed' || s.openingDate) continue;
    // The guard needs previews to bound a press night, so a row without them is not looked up.
    if (!s.previewsStartDate) { dropped.push({ id: s.id, title: s.title, venue: s.venue, reason: 'no previews start to bound a press night' }); continue; }
    // Press night is up to ~45 days after previews and the picker looks only 1 month past the anchor, so anchor 3 weeks in.
    const date = new Date(Date.parse(s.previewsStartDate) + 21 * 86400000).toISOString().slice(0, 10);
    lookups.push({ showId: s.id, title: s.title, venue: s.venue, date });
  }
  return { lookups, dropped };
}

async function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const seasonsArg = (args.find(a => a.startsWith('--seasons=')) || '').split('=')[1];
  const dryRun = args.includes('--dry-run');
  const resume = args.includes('--resume');
  const budgetMin = Number((args.find(a => a.startsWith('--budget-min=')) || '').split('=')[1]) || 0;
  const startedAt = Date.now();
  const dateless = args.includes('--dateless');
  if (!seasonsArg && !dateless) { console.error(USAGE); process.exit(2); }
  const seasons = dateless ? [DATELESS_KEY] : seasonsArg.split(',').map(s => s.trim()).filter(Boolean);
  for (const s of seasons) {
    if (s !== DATELESS_KEY && !/^\d{4}-\d{4}$/.test(s)) { console.error(`bad season: ${s}`); process.exit(2); }
  }

  const plan = seasons.map(season => {
    if (season === DATELESS_KEY) return { season, ...datelessLookups(ROOT) };
    const file = path.join(ROOT, 'data', 'audit', `we-historical-candidates-${season}.json`);
    if (!fs.existsSync(file)) throw new Error(`no candidates file for ${season}: run discover-historical-shows-we.js first`);
    const audit = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sel = selectLookups(audit.unlistedReviews, season);
    const azFile = path.join(ROOT, 'data', 'audit', `we-historical-az-${season}.json`);
    if (fs.existsSync(azFile)) {
      const az = azLookups(JSON.parse(fs.readFileSync(azFile, 'utf8')), sel.lookups);
      sel.lookups.push(...az.lookups);
      sel.dropped.push(...az.dropped);
    }
    return { season, ...sel };
  });
  for (const p of plan) {
    console.log(`${p.season}: ${p.lookups.length} lookups, ${p.dropped.length} dropped`);
    for (const d of p.dropped) console.log(`  drop  ${d.title} @ ${d.venue}: ${d.reason}`);
    for (const l of p.lookups) console.log(`  look  ${l.title} @ ${l.venue} (${p.season === DATELESS_KEY ? 'run anchor' : 'review'} ${l.date})`);
  }
  if (dryRun) return;

  if (!process.env.TR_EMAIL || !process.env.TR_PASSWORD) {
    console.error('TR_EMAIL and TR_PASSWORD are required (run via we-historical-tr-resolve.yml or we-dateless-tr-resolve.yml)');
    process.exit(2);
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  const page = await context.newPage();
  await page.goto('https://www.theatrerecord.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.TR_EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.TR_PASSWORD);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForTimeout(3000);
  const loggedIn = await page.locator('text=Sign Out').count() > 0 ||
                   await page.locator('img[alt="Account"]').count() > 0;
  if (!loggedIn) { await browser.close(); throw new Error('Theatre Record login failed'); }
  console.log('Theatre Record login ok');

  async function searchResults(url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);
    return page.evaluate(() => [...document.querySelectorAll('article')].map(a => {
      const h2 = a.querySelector('h2');
      const h3 = a.querySelector('h3');
      const link = [...a.querySelectorAll('a')].find(l => l.href && l.href.includes('/archive/'));
      return h2 && link ? { title: h2.textContent.trim(), venue: (h3?.textContent || '').trim(), link: link.href } : null;
    }).filter(Boolean));
  }

  async function search(title) {
    const base = 'https://www.theatrerecord.com/search?query=';
    const seen = new Set();
    const out = [];
    const urls = [];
    for (const q of searchTitles(title)) {
      urls.push(`${base}${encodeURIComponent(`"${q}"`)}&title=on&order=newest`,
        `${base}${encodeURIComponent(`"${q}"`)}&title=on&location=on&order=newest`);
      if (/['‘’"“”]/.test(q)) urls.push(`${base}${encodeURIComponent(q.replace(/['‘’"“”]/g, ' ').replace(/\s+/g, ' ').trim())}&title=on&order=newest`);
    }
    for (const url of urls) {
      for (const r of await searchResults(url)) {
        if (!seen.has(r.link)) { seen.add(r.link); out.push(r); }
      }
    }
    return out;
  }

  async function header(link, title, venue) {
    if (/\/volume\/|\/issue\//.test(link)) {
      const cookie = (await context.cookies()).find(c => c.name === 'PHPSESSID');
      if (!cookie) throw new Error('no PHPSESSID cookie for PDF download');
      const tmp = path.join(os.tmpdir(), `tr-resolve-${process.pid}.pdf`);
      try {
        execFileSync('curl', ['-s', '-L', '-o', tmp, '-b', `PHPSESSID=${cookie.value}`, link.replace(/#.*$/, '')], { timeout: 60000 });
        if (fs.readFileSync(tmp).subarray(0, 5).toString() !== '%PDF-') throw new Error('download is not a PDF (login expired?)');
        // -layout keeps header lines whole on single-column pages; -raw is
        // the fallback for two-column pages (same order as extract-theatre-record.js).
        for (const mode of ['-layout', '-raw']) {
          const text = execFileSync('pdftotext', [mode, tmp, '-'], { maxBuffer: 50 * 1024 * 1024 }).toString();
          const pageNo = (link.match(/\/page\/(\d+)/) || [])[1];
          const volNo = (link.match(/\/volume\/(\d+)/) || [])[1];
          const h = pdfHeaderFor(text, title, venue, { page: pageNo ? Number(pageNo) : null, volume: volNo ? Number(volNo) : null });
          const d = parseTrHeaderDates(h);
          if (!d.closingDate || !d.openingDate) logDateContext(text, title, mode);
          if (h) return h;
        }
        return null;
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    }
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const { title: pageTitle, text } = await page.evaluate(() => {
      const first = document.querySelector('main article');
      const root = document.querySelector('main') || document.body;
      return { title: first ? first.innerText.split('\n').map(l => l.trim()).find(Boolean) : null, text: root ? root.innerText : null };
    });
    const h = htmlHeaderFor(pageTitle || title, text);
    if (!parseTrHeaderDates(h).closingDate || !parseTrHeaderDates(h).openingDate) logDateContext(`${capsKey(cleanSearchTitle(title))}\n${text || ''}`, title, 'html');
    return h;
  }

  let failures = 0;
  try {
    for (const p of plan) {
      const rows = [];
      // --resume keeps finished rows (no error) of an earlier partial run, so a time-boxed run can be dispatched again
      const prior = new Map();
      if (resume && p.season !== DATELESS_KEY && fs.existsSync(reviewLedPath(ROOT, p.season))) {
        for (const r of JSON.parse(fs.readFileSync(reviewLedPath(ROOT, p.season), 'utf8')).lookups || []) {
          if (!r.error) prior.set(`${normalizeTitle(r.review.title)}|${r.review.venue || ''}`, r);
        }
      }
      let pending = 0;
      for (const review of p.lookups) {
        const done = prior.get(`${normalizeTitle(review.title)}|${review.venue || ''}`);
        if (done) { rows.push({ ...done, review }); continue; }
        if (budgetMin && Date.now() - startedAt > budgetMin * 60000) { pending++; continue; }
        const row = { review, tr: null, trResults: [], header: null, error: null };
        try {
          const results = await search(review.title);
          row.trResults = results.slice(0, 10);
          row.tr = pickTrForReview(results, review, { isLondonVenue });
          if (row.tr) row.header = await header(row.tr.link, row.tr.title, row.tr.venue);
          console.log(`  ${review.title}: ${row.tr ? `${row.tr.venue} ${row.tr.link} header=${row.header ? 'yes' : 'NO'}` : `no match (${results.length} results)`}`);
        } catch (e) {
          failures++;
          row.error = e.message;
          console.log(`  ${review.title}: ERROR ${e.message}`);
        }
        rows.push(row);
        // Checkpoint: a 97-row run can hit the workflow timeout, and the file is written only here.
        if (p.season !== DATELESS_KEY && rows.length % 10 === 0) {
          fs.writeFileSync(reviewLedPath(ROOT, p.season), JSON.stringify({ generatedAt: new Date().toISOString(), season: p.season, partial: true, lookups: rows, dropped: p.dropped }, null, 2) + '\n');
        }
        if (p.season === DATELESS_KEY && rows.length % 10 === 0) {
          fs.writeFileSync(datelessPath(ROOT), JSON.stringify({ generatedAt: new Date().toISOString(), season: p.season, partial: true, lookups: rows, dropped: p.dropped }, null, 2) + '\n');
        }
        await page.waitForTimeout(1500);
      }
      const out = { generatedAt: new Date().toISOString(), season: p.season, ...(pending ? { partial: true, pending } : {}), lookups: rows, dropped: p.dropped };
      if (pending) console.log(`${p.season}: time budget reached, ${pending} lookups still pending (dispatch again with --resume)`);
      fs.writeFileSync(p.season === DATELESS_KEY ? datelessPath(ROOT) : reviewLedPath(ROOT, p.season), JSON.stringify(out, null, 2) + '\n');
      console.log(`${p.season}: wrote ${rows.length} rows (${rows.filter(r => r.header).length} with a header)`);
    }
  } finally {
    await browser.close();
  }
  if (failures) console.log(`${failures} lookup error(s); rows saved with error set`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { datelessLookups, pdfHeaderFor, pdfContentsRowFor, pdfIndexRowFor, htmlHeaderFor, pairLabelLines, searchTitles, logDateContext };
