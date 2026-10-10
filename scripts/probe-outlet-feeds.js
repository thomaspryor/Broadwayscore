#!/usr/bin/env node
/**
 * probe-outlet-feeds.js — find free RSS/Atom feeds for outlets the outlet
 * listing poller still covers by SERP only, and print candidate
 * OUTLET_STRATEGY_CONFIG entries for a human to review (BRO-4185).
 *
 * Why offline, not runtime: feed URLs change slowly and want a human eye
 * (urlFilter for all-arts sites, e.g. culturesauce/thewrap precedent in
 * outlet-listing-poller.js). A configured entry is also always-on
 * (mergeAlwaysOnOutlets), so it keeps polling even when an outlet dips under
 * the ≥5-shows/4-months volume gate.
 *
 * The SERP fallback it replaces ("site:domain theater review", 7d) returned
 * 0 results for 31/69 outlets on 2026-09-26 while their feeds held the
 * reviews (Off Off Online → The Holes, First Night Magazine → Table 17).
 *
 * Usage:
 *   node scripts/probe-outlet-feeds.js                   # all SERP-only qualifying outlets
 *   node scripts/probe-outlet-feeds.js --outlets a,b     # specific outlet ids
 *   node scripts/probe-outlet-feeds.js --json out.json   # also write results
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseRssFeed, deriveQualifyingOutlets } = require('./lib/outlet-listing-helpers');
const { hasHelpFlag } = require('./lib/cli-help.js');

const COMMON_FEED_PATHS = ['/feed/', '/rss.xml', '/feed.xml', '/rss', '/index.xml', '/blog?format=rss'];
const MAX_SQUARESPACE_COLLECTIONS = 15;
const REVIEWISH_RE = /review|critic/i;

/** `<link rel="alternate" type="application/(rss|atom)+xml" href>` → absolute URLs, comment feeds dropped. */
function extractFeedLinksFromHtml(html, baseUrl) {
  const out = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (!href) continue;
    let url;
    try { url = new URL(href[1].replace(/&amp;/g, '&'), baseUrl).toString(); } catch { continue; }
    if (/comments/i.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * Squarespace serves one feed per blog collection at /<collection>?format=rss,
 * never a site-wide /feed/, so guess collections from single-segment nav links.
 */
function squarespaceCollectionFeeds(html, baseUrl) {
  if (!/squarespace/i.test(html)) return [];
  const out = [];
  for (const [, href] of html.matchAll(/<a\b[^>]*href=["'](\/[a-z0-9-]+)\/?["']/gi)) {
    let url;
    try { url = new URL(`${href}?format=rss`, baseUrl).toString(); } catch { continue; }
    if (!out.includes(url)) out.push(url);
    if (out.length >= MAX_SQUARESPACE_COLLECTIONS) break;
  }
  return out;
}

/** Ordered, deduped feed URLs to try: declared alternates, Squarespace collections, then common paths. */
function feedCandidateUrls(domain, homepageHtml) {
  const base = `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/`;
  const urls = [
    ...extractFeedLinksFromHtml(homepageHtml || '', base),
    ...squarespaceCollectionFeeds(homepageHtml || '', base),
    ...COMMON_FEED_PATHS.map(p => new URL(p, base).toString()),
  ];
  return [...new Set(urls)];
}

/** A body is a usable feed only if it looks like XML feed markup AND yields ≥1 dated-or-undated item. */
function summarizeFeed(body) {
  if (!body || !/<(rss|feed|rdf:RDF)\b/i.test(body.slice(0, 2000))) return null;
  const items = parseRssFeed(body, new Date(0));
  if (items.length === 0) return null;
  const dates = items.map(i => i.publishDate).filter(Boolean).sort();
  return {
    itemCount: items.length,
    newest: dates[dates.length - 1] || null,
    reviewishCount: items.filter(i => REVIEWISH_RE.test(i.url) || REVIEWISH_RE.test(i.headline)).length,
    sample: items.slice(0, 3).map(i => i.url),
  };
}

// ---------------------------------------------------------------------------
// I/O (not unit-tested)
// ---------------------------------------------------------------------------

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0; +https://broadwayscorecard.com)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8',
      },
    });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: null, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

async function probeOutlet(outletId, domain) {
  const home = await fetchText(`https://${domain}/`);
  const candidates = feedCandidateUrls(domain, home.body);
  // Squarespace sites expose one feed per collection (shop, events, news…), so
  // the first valid feed can be the shop. Try all and keep the most review-ish.
  let best = null;
  for (const url of candidates) {
    const r = await fetchText(url);
    const summary = summarizeFeed(r.body);
    if (summary && (!best || summary.reviewishCount > best.reviewishCount)) best = { outletId, domain, feedUrl: url, ...summary };
  }
  return best || { outletId, domain, feedUrl: null, homepageStatus: home.status, tried: candidates.length };
}

function parseArgs(argv) {
  const opts = { outlets: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--outlets') opts.outlets = argv[++i].split(',').map(s => s.trim());
    else if (argv[i] === '--json') opts.json = argv[++i];
  }
  return opts;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/probe-outlet-feeds.js [--outlets id1,id2] [--json out.json]\n'
      + 'Probes SERP-only outlets for a usable RSS/Atom feed and prints candidate OUTLET_STRATEGY_CONFIG entries. Read-only.');
    return;
  }
  const opts = parseArgs(process.argv.slice(2));
  const root = path.join(__dirname, '..');
  const { outlets: registry } = JSON.parse(fs.readFileSync(path.join(root, 'data', 'outlet-registry.json'), 'utf-8'));
  const { SKIP_OUTLETS, OUTLET_STRATEGY_CONFIG, WP_API_CONFIG } = require('./outlet-listing-poller');

  let ids = opts.outlets;
  if (!ids) {
    const { shows } = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf-8'));
    const { reviews } = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf-8'));
    ids = deriveQualifyingOutlets(reviews, shows, SKIP_OUTLETS, { minShowCount: 5, lookbackDays: 120 })
      .filter(id => !OUTLET_STRATEGY_CONFIG[id] && !WP_API_CONFIG[id]);
  }
  console.log(`Probing ${ids.length} SERP-only outlets…\n`);

  const results = [];
  for (const id of ids) {
    const entry = registry[id] || {};
    const domain = (entry.domain || entry.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) { results.push({ outletId: id, feedUrl: null, note: 'no domain in registry' }); continue; }
    const r = await probeOutlet(id, domain);
    results.push(r);
    console.log(r.feedUrl
      ? `✓ ${id.padEnd(28)} ${r.feedUrl}  (${r.itemCount} items, ${r.reviewishCount} review-ish, newest ${r.newest})`
      : `✗ ${id.padEnd(28)} ${domain}  (home ${r.homepageStatus}, tried ${r.tried})`);
  }

  const found = results.filter(r => r.feedUrl);
  console.log(`\n${found.length}/${results.length} outlets have a usable feed. Candidate entries (review before adding; add urlFilter for all-arts sites):\n`);
  for (const r of found) console.log(`  '${r.outletId}': { strategy: 'rss', url: '${r.feedUrl}' },`);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(results, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}

module.exports = { extractFeedLinksFromHtml, squarespaceCollectionFeeds, feedCandidateUrls, summarizeFeed };
