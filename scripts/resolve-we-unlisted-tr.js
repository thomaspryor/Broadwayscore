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
const { selectLookups, pickTrForReview, reviewLedPath, headerFacts, parseTrHeaderDates } = require('./lib/we-review-led-candidates');
const { isLondonVenue } = require('./lib/tr-london-venue');
const { cleanSearchTitle } = require('./lib/title-normalization');

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
 * with its run dates, the "Reviews" heading above the reviews), so the first
 * heading whose block carries run dates wins; otherwise the first block.
 */
const capsKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function pdfHeaderFor(text, title) {
  const want = capsKey(cleanSearchTitle(title));
  if (!want) return null;
  const wants = new Set([want, want.replace(/^THE /, ''), `THE ${want}`]);
  const lines = String(text || '').split('\n');
  let first = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line !== line.toUpperCase() || !/[A-Z]/.test(line)) continue;
    if (!wants.has(capsKey(line))) continue;
    const block = [line];
    for (let j = i + 1; j < lines.length && j <= i + PDF_HEADER_MAX_LINES; j++) {
      if (DATE_LINE.test(lines[j])) break;
      block.push(lines[j]);
    }
    const facts = headerFacts(block.join('\n'));
    const d = parseTrHeaderDates(facts);
    if (d.previewsStartDate || d.openingDate || d.closingDate) return facts;
    if (!first) first = facts;
  }
  return first;
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

  async function header(link, title) {
    if (/\/volume\/|\/issue\//.test(link)) {
      const cookie = (await context.cookies()).find(c => c.name === 'PHPSESSID');
      if (!cookie) throw new Error('no PHPSESSID cookie for PDF download');
      const tmp = path.join(os.tmpdir(), `tr-resolve-${process.pid}.pdf`);
      try {
        execFileSync('curl', ['-s', '-L', '-o', tmp, '-b', `PHPSESSID=${cookie.value}`, link.replace(/#.*$/, '')], { timeout: 60000 });
        if (fs.readFileSync(tmp).subarray(0, 5).toString() !== '%PDF-') throw new Error('download is not a PDF (login expired?)');
        // -layout keeps header lines whole on single-column pages; -raw is
        // the fallback for two-column pages (same order as extract-theatre-record.js).
        let fallback = null;
        for (const mode of ['-layout', '-raw']) {
          const text = execFileSync('pdftotext', [mode, tmp, '-'], { maxBuffer: 50 * 1024 * 1024 }).toString();
          const h = pdfHeaderFor(text, title);
          const d = parseTrHeaderDates(h);
          if (d.previewsStartDate || d.openingDate || d.closingDate) return h;
          fallback = fallback || h;
        }
        return fallback;
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    }
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => {
      const first = document.querySelector('main article');
      return first ? first.innerText : null;
    });
    return text ? headerFacts(text) : null;
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
          if (row.tr) row.header = await header(row.tr.link, row.tr.title);
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

module.exports = { pdfHeaderFor, searchTitles };
