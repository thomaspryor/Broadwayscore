#!/usr/bin/env node
/**
 * collect-talkinbroadway-index.js — read Talkin' Broadway's own index pages once a
 * day, so a review is never invisible just because we found no forum post or SERP
 * hit for it (BRO-5679).
 *
 * talkinbroadway.com sits behind a Cloudflare managed challenge that Bright Data,
 * ScrapingBee and headless Playwright cannot pass from CI. A Browserbase session
 * with solveCaptchas can (probe verified 2026-10-19: 6/6 pages, incl. both index
 * pages and the Off Broadway archive). One session loads the index pages and every
 * review page we are missing; the HTML goes to ingest-review-from-url.js
 * (--html-file) so the write path is the same one every other URL ingest uses.
 *
 * Writes: this script never writes a review file. ingest-review-from-url.js does, through
 * review-file-writer (createOrMergeReviewFile, Guard A); the only files written here are
 * temp HTML handed to it.
 *
 * Spend: one Browserbase session per run, held to the caller allowance in
 * scripts/lib/browserbase-caps.js (8/day, expires 2026-11-19).
 *
 * Usage:
 *   node scripts/collect-talkinbroadway-index.js [--dry-run]
 *     [--window-days=400] [--max-pages=12] [--data-dir=PATH]
 *   --dry-run      list what is missing, fetch nothing but the index pages, write nothing
 */
'use strict';

// Labels every ingest-review-from-url.js run this script starts (BRO-6588).
process.env.INGEST_CALLER = process.env.INGEST_CALLER || 'collect-talkinbroadway-index';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  BASE, extractReviewLinks, isReviewHref, normalizeTbUrl, titleFromPageTitle, planCollection, heldKey,
  pickCriticForShow, pageTitleMatchesShow, bylineDate, reviewDateFitsShow, resolveAgainst, holdsReview,
} = require('./lib/talkinbroadway-index');

const USAGE = 'Usage: node scripts/collect-talkinbroadway-index.js [--dry-run] [--window-days=N] [--max-pages=N] [--data-dir=PATH]';
const args = process.argv.slice(2);
if (hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }

const getArg = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const dryRun = args.includes('--dry-run');
const windowDays = parseInt(getArg('window-days'), 10) || 400;
const maxPages = parseInt(getArg('max-pages'), 10) || 12;
const reviewTextsDir = getArg('data-dir') || path.join(__dirname, '..', 'data', 'review-texts');
const showsPath = path.join(__dirname, '..', 'data', 'shows.json');

// The index pages (world/index, ob/index) show only the newest review and link to no others;
// the "past reviews" pages list every review as "<title> - M/D/YY". A review shows on the
// past page once it is no longer the newest.
const LIST_PAGES = [`${BASE}/page/world/past.html`, `${BASE}/page/ob/past.html`];
const CHALLENGE = /just a moment|checking your browser|cf-chl|attention required|enable javascript and cookies/i;

/** showIds that already hold a usable talkinbroadway review. */
function loadHeldKeys() {
  const held = new Set();
  if (!fs.existsSync(reviewTextsDir)) return held;
  for (const showId of fs.readdirSync(reviewTextsDir)) {
    const dir = path.join(reviewTextsDir, showId);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith('talkinbroadway--') || !f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (holdsReview(d)) held.add(heldKey(showId));
      } catch { /* unreadable file: not held */ }
    }
  }
  return held;
}

async function readPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 6; i++) {
    const title = await page.title();
    const body = await page.evaluate(() => (document.body && document.body.innerText) || '');
    if (!CHALLENGE.test(title) && !CHALLENGE.test(body.slice(0, 400)) && body.length > 200) break;
    await page.waitForTimeout(2500);
  }
  const title = await page.title();
  const text = await page.evaluate(() => (document.body && document.body.innerText) || '');
  if (CHALLENGE.test(title) || CHALLENGE.test(text.slice(0, 400)) || text.length < 500) {
    throw new Error(`challenge or empty page at ${url}`);
  }
  const rawAnchors = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 120) })));
  // List pages use relative hrefs ("Bug.html"); resolve them against the page they came from.
  const anchors = rawAnchors.map((a) => ({ href: resolveAgainst(url, a.href), text: a.text })).filter((a) => a.href);
  const canonical = await page.evaluate(() => {
    const el = document.querySelector('link[rel="canonical"]') || document.querySelector('meta[property="og:url"]');
    return el ? (el.getAttribute('href') || el.getAttribute('content')) : null;
  });
  const html = await page.content();
  return { title, text, anchors, html, canonical };
}

async function main() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    console.log('no BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID in this environment; nothing to collect');
    process.exit(2);
  }
  const rawShows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = Array.isArray(rawShows) ? rawShows : rawShows.shows;
  const held = loadHeldKeys();
  // An empty or missing corpus would read as "everything is missing"; never ingest on that.
  if (!dryRun && held.size < 50) {
    console.log(`only ${held.size} talkinbroadway files visible in ${reviewTextsDir}; refusing to ingest without the review-texts checkout`);
    process.exit(2);
  }
  console.log(`held talkinbroadway files in corpus: ${held.size}`);

  const { chromium } = require('playwright');
  const { createBbSession } = require('./lib/browserbase-session');
  let session;
  try {
    session = await createBbSession({
      caller: 'collect-talkinbroadway-index.js',
      purpose: 'Talkin Broadway daily index collector',
      host: 'talkinbroadway.com',
      category: 'discovery',
      body: { timeout: 900, browserSettings: { solveCaptchas: true } },
    });
  } catch (e) {
    // A refused session (cap, allowance, kill switch) is a normal skip, not a failure.
    console.log(`no session: ${e.message}`);
    process.exit(0);
  }
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();

  let failures = 0;
  try {
    // 1. Index pages -> review links. The index page itself is the newest review.
    const entries = [];
    for (const url of LIST_PAGES) {
      try {
        const r = await readPage(page, url);
        const links = extractReviewLinks(r.anchors);
        // An index page is itself the newest review. File it only under its own canonical
        // review URL; never under index.html, which shows a different review tomorrow.
        const own = titleFromPageTitle(r.title);
        if (own && isReviewHref(r.canonical)) entries.push({ url: normalizeTbUrl(r.canonical), title: own });
        const section = url.includes('/page/world/') ? 'world' : 'ob';
        links.forEach((l, rank) => entries.push({ url: l.url, title: l.text, date: l.date, section, rank }));
        // Self-report links that look like dated reviews ("<title> - M/D/YY") but were not accepted
        // as review pages, so a change in TB's URL shapes shows up here instead of as silence.
        const accepted = new Set(links.map((l) => l.url));
        const rejected = r.anchors.filter((a) => /\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/.test(a.text || '') && !accepted.has(normalizeTbUrl(a.href)));
        if (rejected.length) {
          console.log(`index ${url}: ${rejected.length} dated links not accepted as reviews; first 25:`);
          for (const a of rejected.slice(0, 25)) console.log(`   REJECTED ${a.href} | ${a.text}`);
        }
        console.log(`index ${url}: ${links.length} review links${own ? `, page is "${own}" (canonical ${r.canonical || 'none'})` : ''}`);
        if (dryRun) for (const l of links.slice(0, 80)) console.log(`   ${l.url} | ${l.text}`);
      } catch (e) {
        failures++;
        console.log(`index ${url} failed: ${e.message}`);
      }
    }

    // 2. What are we missing?
    const { toFetch, skipped } = planCollection(entries, shows, held, { now: new Date(), windowDays });
    const why = {};
    for (const s of skipped) why[s.why] = (why[s.why] || 0) + 1;
    console.log(`\nmissing reviews: ${toFetch.length}; skipped: ${JSON.stringify(why)}`);
    for (const t of toFetch) console.log(`  MISSING ${t.showId} | ${t.title} | ${t.url}`);
    if (dryRun || !toFetch.length) return;

    // 3. Fetch and ingest each missing review page.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-collect-'));
    let ingested = 0;
    for (const t of toFetch.slice(0, maxPages)) {
      try {
        const r = await readPage(page, t.url);
        // The page must be about this show, and the critic must be the one who reviewed it.
        if (!pageTitleMatchesShow(r.title, t.title)) {
          console.log(`  ${t.showId} skipped: page title "${r.title.slice(0, 80)}" is not "${t.title}"`);
          continue;
        }
        const pageDate = bylineDate(r.html);
        if (pageDate ? !reviewDateFitsShow(pageDate, { openingDate: t.openingDate }) : t.verifyPageDate) {
          console.log(`  ${t.showId} skipped: page byline date ${pageDate || 'missing'} does not fit the opening ${t.openingDate} (${t.url})`);
          continue;
        }
        const picked = pickCriticForShow(r.html, t.title);
        if (picked.skip) {
          console.log(`  ${t.showId} skipped: ${picked.skip} (${t.url}); needs a person`);
          continue;
        }
        const critic = picked.critic;
        const htmlFile = path.join(tmpDir, `${t.showId}.html`);
        fs.writeFileSync(htmlFile, r.html);
        const ingestArgs = [
          path.join(__dirname, 'ingest-review-from-url.js'),
          `--show=${t.showId}`, `--url=${t.url}`, '--outlet=talkinbroadway',
          `--html-file=${htmlFile}`, `--data-dir=${reviewTextsDir}`, '--land',
        ];
        if (critic) ingestArgs.push(`--critic=${critic}`);
        const out = execFileSync('node', ingestArgs, { encoding: 'utf8', timeout: 240000 });
        console.log(`  ingested ${t.showId} (${critic || 'critic unknown'}): ${out.trim().split('\n').slice(-1)[0]}`);
        ingested++;
      } catch (e) {
        failures++;
        console.log(`  ${t.showId} failed: ${String((e.stdout || '') + (e.stderr || e.message)).trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`);
      }
    }
    console.log(`\nDone. ${ingested} ingested, ${failures} failed.`);
  } finally {
    await browser.close().catch(() => {});
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((e) => { console.error(String((e && e.stack) || e).split('\n').slice(0, 4).join('\n')); process.exit(1); });
