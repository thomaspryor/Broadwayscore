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

const ROOT = path.join(__dirname, '..');
const USAGE = `resolve-we-unlisted-tr.js — Theatre Record lookups for WE reviews with no WOS listing (BRO-5031).

Usage:
  node scripts/resolve-we-unlisted-tr.js --seasons=2019-2020[,2020-2021...] [--dry-run]

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

function pdfHeaderFor(text, title, venue) {
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
  return pdfOpeningsFor(text, want, variants, venue);
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
  const readDate = (day, month, year) => {
    const y = Number(year) < 100 ? 2000 + Number(year) : Number(year);
    const iso = parseTrHeaderDates(`Press night ${day} ${month} ${y}`).openingDate;
    return iso && new Date(iso).toISOString().slice(0, 10) === iso ? iso : null;
  };
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

async function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const seasonsArg = (args.find(a => a.startsWith('--seasons=')) || '').split('=')[1];
  const dryRun = args.includes('--dry-run');
  if (!seasonsArg) { console.error(USAGE); process.exit(2); }
  const seasons = seasonsArg.split(',').map(s => s.trim()).filter(Boolean);
  for (const s of seasons) {
    if (!/^\d{4}-\d{4}$/.test(s)) { console.error(`bad season: ${s}`); process.exit(2); }
  }

  const plan = seasons.map(season => {
    const file = path.join(ROOT, 'data', 'audit', `we-historical-candidates-${season}.json`);
    if (!fs.existsSync(file)) throw new Error(`no candidates file for ${season}: run discover-historical-shows-we.js first`);
    const audit = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { season, ...selectLookups(audit.unlistedReviews, season) };
  });
  for (const p of plan) {
    console.log(`${p.season}: ${p.lookups.length} lookups, ${p.dropped.length} dropped`);
    for (const d of p.dropped) console.log(`  drop  ${d.title} @ ${d.venue}: ${d.reason}`);
    for (const l of p.lookups) console.log(`  look  ${l.title} @ ${l.venue} (review ${l.date})`);
  }
  if (dryRun) return;

  if (!process.env.TR_EMAIL || !process.env.TR_PASSWORD) {
    console.error('TR_EMAIL and TR_PASSWORD are required (run via we-historical-tr-resolve.yml)');
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
          const h = pdfHeaderFor(text, title, venue);
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
      for (const review of p.lookups) {
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
        await page.waitForTimeout(1500);
      }
      const out = { generatedAt: new Date().toISOString(), season: p.season, lookups: rows, dropped: p.dropped };
      fs.writeFileSync(reviewLedPath(ROOT, p.season), JSON.stringify(out, null, 2) + '\n');
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

module.exports = { pdfHeaderFor, htmlHeaderFor, pairLabelLines, searchTitles, logDateContext };
