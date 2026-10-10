#!/usr/bin/env node

/**
 * Crawl WSJ's own Theater Review + Opera Review section indexes via an
 * authenticated browser session (task #841 owner directive: deterministic
 * matching against WSJ's own catalog beats per-file SERP guessing).
 *
 * Walks https://www.wsj.com/news/types/theater-review?page=N and
 * https://www.wsj.com/news/types/opera-review?page=N until a 404/empty page,
 * extracting {headline, critic, date, url} per review via WSJ's
 * data-testid="flexcard-headline"/"byline"/"timestamp-text" card markup.
 *
 * Cookies from data/cookies/wsj.json (scripts/wsj-otp-login.js) or
 * WSJ_COOKIES env var. Same real-Chrome launch strategy as
 * recover-wsj-browser.js (bundled Chromium gets paywall-locked pages).
 *
 * Usage:
 *   node scripts/wsj-crawl-theater-review-index.js [--max-pages=N] [--min-date=YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const maxPagesArg = args.find(a => a.startsWith('--max-pages='));
const minDateArg = args.find(a => a.startsWith('--min-date='));
const MAX_PAGES = maxPagesArg ? parseInt(maxPagesArg.split('=')[1], 10) : 80;
const MIN_DATE = minDateArg ? new Date(minDateArg.split('=')[1]) : new Date('2025-01-01');

const OUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'wsj-theater-review-index.json');

const SECTIONS = [
  { key: 'theater-review', base: 'https://www.wsj.com/news/types/theater-review' },
  { key: 'opera-review', base: 'https://www.wsj.com/news/types/opera-review' },
];

async function extractCards(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[data-testid="flexcard-headline"]'));
    const records = [];
    for (const a of links) {
      const container = a.closest('h3')?.parentElement || a.parentElement?.parentElement;
      if (!container) continue;
      const bylineEls = container.querySelectorAll('[data-testid="byline"] p');
      const critic = bylineEls.length ? bylineEls[bylineEls.length - 1].innerText.trim() : null;
      const dateEl = container.querySelector('[data-testid="timestamp-text"]');
      records.push({
        url: a.href.split('?')[0],
        headline: a.innerText.trim(),
        critic,
        date: dateEl ? dateEl.innerText.trim() : null,
      });
    }
    return records;
  });
}

async function main() {
  const { loadCookiesForDomain } = require('./lib/cookie-loader');
  const cookies = loadCookiesForDomain('wsj.com');
  if (!cookies) {
    console.error('ERROR: no WSJ cookies available. Run: node scripts/wsj-otp-login.js');
    process.exit(1);
  }
  console.log(`Loaded ${cookies.length} WSJ cookies.`);

  const { chromium } = require('playwright');
  const PROFILE_DIR = '/tmp/wsj-recovery-browser-profile';
  const launchOpts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, { ...launchOpts, channel: 'chrome' });
  } catch {
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  }
  await context.addCookies(cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires && c.expires > 0 ? c.expires : undefined,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  })));
  const page = context.pages()[0] || (await context.newPage());

  const byUrl = new Map();
  const sectionCounts = {};

  for (const section of SECTIONS) {
    let pageNum = 1;
    let sawAny = false;
    let stopReason = null;
    while (pageNum <= MAX_PAGES) {
      const url = pageNum === 1 ? section.base : `${section.base}?page=${pageNum}`;
      let resp;
      try {
        resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        stopReason = `nav error: ${e.message}`;
        break;
      }
      await page.waitForTimeout(1800 + Math.random() * 1200);
      if (!resp || resp.status() >= 400) {
        stopReason = `HTTP ${resp ? resp.status() : 'none'}`;
        break;
      }
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      if (/verification required|slide right to secure/i.test(bodyText)) {
        stopReason = 'DataDome challenge detected';
        break;
      }
      const records = await extractCards(page);
      if (records.length === 0) {
        stopReason = 'empty page';
        break;
      }
      sawAny = true;
      let oldestOnPage = null;
      for (const r of records) {
        const parsed = r.date ? new Date(r.date) : null;
        if (parsed && !isNaN(parsed)) {
          if (!oldestOnPage || parsed < oldestOnPage) oldestOnPage = parsed;
        }
        const existing = byUrl.get(r.url);
        if (!existing) {
          byUrl.set(r.url, { ...r, section: section.key });
        }
      }
      console.log(`  [${section.key}] page ${pageNum}: ${records.length} cards (oldest: ${oldestOnPage ? oldestOnPage.toISOString().slice(0, 10) : 'unknown'})`);
      sectionCounts[section.key] = (sectionCounts[section.key] || 0) + records.length;
      if (oldestOnPage && oldestOnPage < MIN_DATE) {
        stopReason = `reached min-date (${MIN_DATE.toISOString().slice(0, 10)})`;
        break;
      }
      pageNum++;
    }
    console.log(`[${section.key}] stopped: ${stopReason || 'max pages reached'} (sawAny=${sawAny})`);
  }

  await context.close();

  const index = Array.from(byUrl.values()).sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    crawledAt: new Date().toISOString(),
    minDate: MIN_DATE.toISOString().slice(0, 10),
    sectionCounts,
    totalUnique: index.length,
    reviews: index,
  }, null, 2) + '\n');

  console.log(`\nWrote ${index.length} unique reviews to ${OUT_PATH}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
