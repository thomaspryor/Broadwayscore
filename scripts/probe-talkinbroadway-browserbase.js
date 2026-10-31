#!/usr/bin/env node
/**
 * probe-talkinbroadway-browserbase.js — can a Browserbase browser read
 * talkinbroadway.com? (read-only feasibility probe, one session, no writes)
 *
 * Talkin' Broadway sits behind a Cloudflare managed challenge (since ~2026-04).
 * Bright Data and headless Playwright from CI time out on it, so its reviews land
 * only intermittently and its own index pages are never read. Stagedoor had the
 * same wall and scrape-stagedoor-critics.js gets past it with a Browserbase
 * session (solveCaptchas). This probe checks whether that works for TB and what
 * the index / day pages look like, so a daily collector can be built on facts.
 *
 * Prints only structure (status, title, text length, link counts, sample link
 * paths), never review text. Cost: one Browserbase session (~$0.10), capped by
 * the 180s session timeout.
 *
 * Run from a cloud session:  node scripts/cloud-run-script.js scripts/probe-talkinbroadway-browserbase.js
 */
'use strict';

const { chromium } = require('playwright');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/probe-talkinbroadway-browserbase.js [--url=<url> ...]';
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const BASE = 'https://www.talkinbroadway.com';
const DEFAULT_URLS = [
  `${BASE}/page/world/past.html`,        // Broadway "Past Broadway Reviews" index
  `${BASE}/page/world/index.html`,       // Broadway current index
  `${BASE}/page/ob/index.html`,          // Off Broadway index (guess; shape from the corpus)
  `${BASE}/page/ob/past.html`,
  `${BASE}/page/ob/10_09_26.html`,       // a known OB day page (Good Time Charlie)
  `${BASE}/page/regional/minn/minn1534.html`, // a known Regional page (Mystic Pizza)
];
const urls = process.argv.slice(2).filter(a => a.startsWith('--url=')).map(a => a.slice(6));
// --sample-links=N: also print N anchors spread evenly across the whole page (href | text), to see a list's real shape.
const sampleArg = process.argv.slice(2).find(a => a.startsWith('--sample-links='));
const sampleLinks = sampleArg ? parseInt(sampleArg.slice(15), 10) || 0 : 0;

const { CHALLENGE } = require('./lib/browser-read-page');
const REVIEW_LINK = /\/page\/(ob|world|bwaybway|westend|regional)\//i;

async function main() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    console.log('no BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID in this environment; nothing to probe');
    process.exit(2);
  }
  const { createBbSession } = require('./lib/browserbase-session');
  const session = await createBbSession({
    caller: 'probe-talkinbroadway-browserbase.js',
    purpose: 'Talkin Broadway Cloudflare feasibility probe',
    host: 'talkinbroadway.com',
    category: 'discovery',
    body: { timeout: 180, browserSettings: { solveCaptchas: true } },
  });
  console.log(`session ${String(session.id).slice(0, 8)}… created`);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  const results = [];
  try {
    for (const url of (urls.length ? urls : DEFAULT_URLS)) {
      const row = { url };
      const t0 = Date.now();
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Give a managed challenge a few seconds to resolve itself.
        for (let i = 0; i < 6; i++) {
          const title = await page.title();
          const body = await page.evaluate(() => (document.body && document.body.innerText) || '');
          if (!CHALLENGE.test(title) && !CHALLENGE.test(body.slice(0, 400)) && body.length > 200) break;
          await page.waitForTimeout(2500);
        }
        const title = await page.title();
        const text = await page.evaluate(() => (document.body && document.body.innerText) || '');
        const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 60) })));
        const reviewLinks = links.filter(l => REVIEW_LINK.test(l.href || ''));
        const bylines = (text.match(/Theatre Review by [^\n]{3,60}? - [A-Za-z]+ \d{1,2}, \d{4}/g) || []);
        Object.assign(row, {
          status: resp ? resp.status() : null,
          finalUrl: page.url(),
          title: title.slice(0, 80),
          challenge: CHALLENGE.test(title) || CHALLENGE.test(text.slice(0, 400)),
          textLength: text.length,
          links: links.length,
          reviewLinks: reviewLinks.length,
          sampleReviewLinks: reviewLinks.slice(0, 8).map(l => `${l.href} | ${l.text}`),
          sampleLinks: sampleLinks ? Array.from({ length: Math.min(sampleLinks, links.length) }, (_, i) => links[Math.floor(i * links.length / Math.min(sampleLinks, links.length))]).map(l => `${l.href} | ${l.text}`) : undefined,
          bylines: bylines.length,
          firstBylines: bylines.slice(0, 4),
          seconds: Math.round((Date.now() - t0) / 100) / 10,
        });
      } catch (e) {
        row.error = String(e.message || e).split('\n')[0].slice(0, 160);
      }
      results.push(row);
      console.log(JSON.stringify(row));
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const ok = results.filter(r => !r.error && !r.challenge && r.textLength > 500).length;
  console.log(`\nSUMMARY: ${ok}/${results.length} pages readable through Browserbase`);
  process.exit(ok > 0 ? 0 : 1);
}

main().catch(e => { console.error(String(e && e.stack || e).split('\n').slice(0, 4).join('\n')); process.exit(1); });
