#!/usr/bin/env node
/**
 * probe-bachtrack-browserbase.js — what does a Browserbase browser get from a
 * bachtrack.com review? (read-only diagnostic, one session, no writes)
 *
 * BRO-5874: GitHub runners get a 175-byte shell from Bachtrack on every
 * non-browser tier. Browserbase reaches some review pages (HTTP 200) but the
 * collector extracts 0-359 chars: the review body (.pcm-walled-full >
 * .article-body) is filled in by the page's registration-wall script. This
 * waits for that body and reports structure only: HTTP status, title, text
 * lengths, body paragraph count, pcm-walled classes, and failed sub-requests.
 * Never prints review text.
 *
 * Run from a cloud session:
 *   node scripts/cloud-run-script.js scripts/probe-bachtrack-browserbase.js --url=<bachtrack review url> [--url=...]
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/probe-bachtrack-browserbase.js --url=<url> [--url=<url> ...] [--wait=SECONDS]';
const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
const urls = argv.filter(a => a.startsWith('--url=')).map(a => a.slice(6));
const waitArg = argv.find(a => a.startsWith('--wait='));
const waitSeconds = Math.min(60, Math.max(5, parseInt(waitArg ? waitArg.slice(7) : '30', 10) || 30));
if (!urls.length || urls.length > 5 || urls.some(u => !/^https:\/\/(www\.)?bachtrack\.com\//.test(u))) {
  console.log(USAGE + '\n(1-5 bachtrack.com urls)');
  process.exit(2);
}

/** Structure of the rendered page, measured in the browser. Only lengths and class names leave it. */
function measure() {
  const body = document.querySelector('.article-body');
  const paras = body ? Array.from(body.querySelectorAll('p')).map(p => p.textContent.trim()).filter(t => t.length > 30) : [];
  const walled = Array.from(document.querySelectorAll('[class*="pcm-walled"]')).map(el => el.className).slice(0, 6);
  const meta = document.querySelector('meta[name="description"]');
  return {
    textLength: ((document.body && document.body.innerText) || '').length,
    articleBodies: document.querySelectorAll('.article-body').length,
    bodyParagraphs: paras.length,
    bodyChars: paras.join(' ').length,
    walledClasses: walled,
    metaDescriptionChars: meta ? (meta.getAttribute('content') || '').length : 0,
  };
}

async function main() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    console.log('no BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID in this environment; nothing to probe');
    process.exit(2);
  }
  const { chromium } = require('playwright');
  const { createBbSession } = require('./lib/browserbase-session');
  const session = await createBbSession({
    caller: 'probe-bachtrack-browserbase.js',
    purpose: 'BRO-5874 Bachtrack render diagnostic',
    host: 'bachtrack.com',
    category: 'review-text',
    // Room for every url: goto (45s) + body wait + 3s settle each, plus a minute for setup.
    body: { timeout: 60 + urls.length * (48 + waitSeconds), browserSettings: { solveCaptchas: true } },
  });
  console.log(`session ${String(session.id).slice(0, 8)}… created`);
  // A failed connect leaves the session to expire at its timeout (at most 10 minutes).
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage().catch(async (e) => { await browser.close().catch(() => {}); throw e; });
  const failed = [];
  const note = (line) => { if (failed.length < 15) failed.push(line); };
  page.on('response', r => {
    if (r.status() >= 400) { try { const u = new URL(r.url()); note(`${r.status()} ${u.hostname}${u.pathname.slice(0, 60)}`); } catch {} }
  });
  page.on('requestfailed', r => {
    try { const u = new URL(r.url()); note(`failed ${u.hostname}${u.pathname.slice(0, 60)} ${(r.failure() || {}).errorText || ''}`); } catch {}
  });
  let readable = 0;
  try {
    for (const url of urls) {
      failed.length = 0;
      const row = { url };
      const t0 = Date.now();
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        row.status = resp ? resp.status() : null;
        row.atLoad = await page.evaluate(measure);
        await page.waitForSelector('.article-body p', { timeout: waitSeconds * 1000 }).catch(() => {});
        await page.waitForTimeout(3000);
        row.title = (await page.title()).slice(0, 80);
        row.finalUrl = page.url();
        row.afterWait = await page.evaluate(measure);
        row.failedRequests = failed.slice();
        row.seconds = Math.round((Date.now() - t0) / 100) / 10;
        if (row.afterWait.bodyChars > 1000) readable++;
      } catch (e) {
        row.error = String(e.message || e).split('\n')[0].slice(0, 160);
      }
      console.log(JSON.stringify(row));
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\nSUMMARY: ${readable}/${urls.length} review bodies rendered (over 1000 chars) in Browserbase`);
  process.exit(readable > 0 ? 0 : 1);
}

main().catch(e => { console.error(String(e && e.stack || e).split('\n').slice(0, 4).join('\n')); process.exit(1); });
