#!/usr/bin/env node
/**
 * fetch-page-probe.js — fetch one URL through the real fetchPage() chain and
 * report which tier answered, the content length and how many distinct
 * matches of --expect it holds (BRO-4038).
 *
 * Use this instead of curl or an inline `node -e` when checking whether an
 * outlet index is visible to discovery: curl skips the tier chain, and inline
 * probes kept reading r.html, which fetchPage never returns (BRO-2763).
 * Needs scraper keys, so from cloud run it through cloud-run-script.js.
 *
 * Usage:
 *   node scripts/fetch-page-probe.js <url> [--expect=<regex>] [--render] [--browserbase]
 *   --browserbase: skip fetchPage and load the page in one Browserbase session
 *   with proxies:true (residential IP), to test a site that blocks the chain (BRO-5886).
 * Exit: 0 content (and >=1 match when --expect is given), 1 otherwise.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { summarizeFetchResult } = require('./lib/fetch-page-probe.js');

async function fetchViaBrowserbase(url) {
  const { createBbSession } = require('./lib/browserbase-session');
  const { chromium } = require('playwright');
  const session = await createBbSession({
    caller: 'fetch-page-probe.js',
    purpose: 'probe a page that blocks the fetch chain (BRO-5886)',
    host: new URL(url).hostname,
    category: 'review-text',
    body: { proxies: true, browserSettings: { solveCaptchas: true } },
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return { content: await page.content(), format: 'html', source: 'browserbase-proxies' };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/fetch-page-probe.js <url> [--expect=<regex>] [--render] [--browserbase]');
    return 0;
  }
  const url = argv.find(a => !a.startsWith('--'));
  if (!url) {
    console.error('fetch-page-probe: a URL is required');
    return 1;
  }
  const expectArg = argv.find(a => a.startsWith('--expect='));
  const expect = expectArg ? new RegExp(expectArg.slice('--expect='.length)) : null;
  const options = argv.includes('--render') ? { renderJs: true } : {};

  const { fetchPage, cleanup } = require('./lib/scraper.js');
  const fetchOne = argv.includes('--browserbase') ? fetchViaBrowserbase : (u) => fetchPage(u, options);
  let summary;
  try {
    summary = summarizeFetchResult(await fetchOne(url), expect);
  } catch (err) {
    console.log(JSON.stringify({ url, ok: false, error: err.message }));
    return 1;
  } finally {
    if (typeof cleanup === 'function') await cleanup().catch(() => {});
  }
  console.log(JSON.stringify({
    url,
    ok: summary.ok,
    source: summary.source,
    format: summary.format,
    length: summary.length,
    matchCount: summary.matches.length,
    sample: summary.matches.slice(0, 5),
  }));
  return summary.ok ? 0 : 1;
}

main().then(code => process.exit(code));
