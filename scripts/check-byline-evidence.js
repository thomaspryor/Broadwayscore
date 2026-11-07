#!/usr/bin/env node
/**
 * check-byline-evidence.js — who does a page credit? (BRO-5232)
 *
 * Byline audits need "this url shows critic X at outlet Y" evidence, and cloud
 * sessions cannot reach archive.org. Run this through cloud-run-script.js: for
 * each url it reads the live page, then the closest Wayback snapshot, and prints
 * the page's author signals (meta author, JSON-LD author, byline-ish lines) and
 * a short context around each --expect match. Prints bylines, never review text
 * beyond a ~120-char context window.
 *
 * Usage:
 *   node scripts/check-byline-evidence.js '<url>|<expect regex>' ['<url>|<regex>' ...] [--scrape] [--year=YYYY]
 *   --scrape  also try the paid fetchPage() chain when live and Wayback both fail
 *   --year    Wayback timestamp hint (default: the 4-digit year in the url, else 2015)
 * Output: one JSON line per url {url, via, snapshot, authors, matches}.
 */
'use strict';

const https = require('https');
const http = require('http');
const { extractAuthorSignals, matchContexts, waybackTimestamp } = require('./lib/byline-evidence');

function get(url, timeoutMs = 25000, redirects = 4) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 3e6) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

async function wayback(url, ts) {
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${ts}`;
  const r = await get(api);
  if (r.status !== 200) return null;
  let snap;
  try { snap = JSON.parse(r.body).archived_snapshots.closest; } catch { return null; }
  if (!snap || !snap.available) return null;
  const raw = snap.url.replace(/\/web\/(\d+)\//, '/web/$1id_/');
  const page = await get(raw, 40000);
  return page.status === 200 ? { snapshot: snap.url, body: page.body } : null;
}

async function checkOne(spec, opts) {
  const bar = spec.indexOf('|');
  const url = bar >= 0 ? spec.slice(0, bar) : spec;
  const expect = bar >= 0 && spec.slice(bar + 1) ? new RegExp(spec.slice(bar + 1), 'i') : null;
  const out = { url, via: null, snapshot: null, authors: [], matches: [] };
  const tries = [];
  const live = await get(url);
  if (live.status === 200 && live.body.length > 2000) tries.push({ via: 'live', body: live.body });
  const wb = await wayback(url, opts.year || waybackTimestamp(url));
  if (wb) tries.push({ via: 'wayback', snapshot: wb.snapshot, body: wb.body });
  if (tries.length === 0 && opts.scrape) {
    const { fetchPage, cleanup } = require('./lib/scraper.js');
    try {
      const r = await fetchPage(url);
      const body = (r && (r.content || r.html || r.text)) || '';
      if (body) tries.push({ via: `fetchPage:${r.source || '?'}`, body });
    } catch { /* recorded as no source below */ } finally {
      if (typeof cleanup === 'function') await cleanup().catch(() => {});
    }
  }
  // Prefer the first source that matches the expectation; else the first one read.
  const pick = tries.find((t) => expect && matchContexts(t.body, expect).length) || tries[0];
  if (!pick) return { ...out, via: 'none', statusLive: live.status };
  out.via = pick.via;
  out.snapshot = pick.snapshot || null;
  out.authors = extractAuthorSignals(pick.body);
  out.matches = expect ? matchContexts(pick.body, expect) : [];
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const specs = argv.filter((a) => !a.startsWith('--'));
  if (specs.length === 0 || argv.includes('--help')) {
    console.log("Usage: node scripts/check-byline-evidence.js '<url>|<expect regex>' ... [--scrape] [--year=YYYY]");
    return specs.length === 0 ? 1 : 0;
  }
  const yearArg = argv.find((a) => a.startsWith('--year='));
  const opts = { scrape: argv.includes('--scrape'), year: yearArg ? yearArg.slice(7) : null };
  let found = 0;
  for (const s of specs) {
    const r = await checkOne(s, opts);
    if (r.matches.length) found++;
    console.log(JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 1500));
  }
  console.log(`check-byline-evidence: ${found}/${specs.length} urls matched their expectation`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { get, wayback };
