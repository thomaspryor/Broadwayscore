#!/usr/bin/env node
'use strict';

/**
 * outlet-census.js (BRO-6481): outlet-first review census.
 *
 * For one outlet: enumerate every review it published since --since (WP API, sitemap),
 * match each to a NYC show with the poller's matcher plus the run window, and diff
 * against the corpus. Writes data/audit/outlet-census/<outlet>.manifest.json (url, date,
 * headline) and <outlet>.report.json (buckets, recall, samples). Read-only: it files
 * nothing. Bucket meanings: scripts/lib/outlet-census.js header.
 *
 * Corpus: every data/review-texts file (flagged or not) when present, else reviews.json
 * (scored, unflagged reviews only, so a "gap" there can be a flagged file we hold;
 * the report says which corpus it used).
 *
 * Usage:
 *   node scripts/outlet-census.js --outlet=theatermania [--since=2021-06-01] [--refresh]
 *   node scripts/outlet-census.js --all [--print-gaps]   (GAP <showId> <url> lines, for CI runs)
 *   node scripts/outlet-census.js --summary              (markdown recall table from the reports)
 */

const fs = require('fs');
const path = require('path');
const { SOURCES } = require('./lib/outlet-census-sources');
const census = require('./lib/outlet-census');
const { parseSitemapXml } = require('./lib/outlet-listing-helpers');
const { urlKey } = require('./lib/outlet-feed-reconcile');
const { fetchViaSitemap } = require('./outlet-listing-poller');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'audit', 'outlet-census');
const CACHE_DIR = path.join(OUT_DIR, '.cache');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function parseArgs(argv) {
  const o = { since: '2021-06-01', refresh: false, outlets: [], concurrency: 6 };
  for (const a of argv) {
    if (a.startsWith('--outlet=')) o.outlets.push(...a.slice(9).split(','));
    else if (a === '--all') o.outlets.push(...Object.keys(SOURCES));
    else if (a.startsWith('--since=')) o.since = a.slice(8);
    else if (a === '--refresh') o.refresh = true;
    else if (a.startsWith('--concurrency=')) o.concurrency = Number(a.slice(14)) || 6;
    else if (a === '--print-gaps') o.printGaps = true;
    else if (a === '--summary') o.summary = true;
  }
  return o;
}

async function get(url, timeoutMs = 30000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

// ── enumerators ────────────────────────────────────────────────────────────────

async function enumerateWpJson(src, since) {
  const items = [];
  const notes = [];
  for (let page = 1; page < 500; page++) {
    const q = new URLSearchParams({ per_page: '100', page: String(page), after: `${since}T00:00:00`, orderby: 'date', order: 'desc', _fields: 'link,date,title,excerpt' });
    if (src.categories) q.set('categories', src.categories.join(','));
    for (const [k, v] of Object.entries(src.params || {})) q.set(k, String(v)); // custom taxonomies, e.g. PMC's vertical
    const { status, body } = await get(`${src.apiBase}?${q}`);
    if (status === 400 && page > 1) break; // past the last page
    if (status !== 200) { notes.push(`page ${page}: HTTP ${status}`); break; }
    const posts = JSON.parse(body);
    if (!Array.isArray(posts) || posts.length === 0) break;
    for (const p of posts) {
      if (src.linkFilter && !src.linkFilter.test(p.link || '')) continue;
      items.push({
        url: p.link,
        headline: census.decodeEntities(census.decodeEntities(String((p.title && p.title.rendered) || '')).replace(/<[^>]+>/g, '')).replace(/<[^>]+>/g, '').trim(),
        description: census.decodeEntities(String((p.excerpt && p.excerpt.rendered) || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 400),
        publishDate: String(p.date || '').slice(0, 10),
      });
    }
    if (posts.length < 100) break;
  }
  return { items, notes };
}

const SOURCE_LABEL = 'outlet-census';

async function fetchSitemapUrls(url, urlFilter) {
  const { status, body } = await get(url, 60000);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  if (/<sitemapindex/i.test(body)) {
    const children = [...body.matchAll(/<loc>(?:<!\[CDATA\[)?([^<\]]+)/g)].map((m) => m[1].trim());
    const out = [];
    for (const c of children) out.push(...await fetchSitemapUrls(c, urlFilter));
    return out;
  }
  return parseSitemapXml(body, new Date(0), urlFilter).map((i) => i.url);
}

async function enumerateSitemap(src, since) {
  const notes = [];
  const urls = [];
  if (src.kind === 'sitemap-years') {
    const y0 = Number(since.slice(0, 4));
    const items = [];
    for (let y = y0; y <= new Date().getFullYear(); y++) {
      // The poller's own fetcher (honest UA), direct only: the census never spends paid
      // scraper credit to enumerate (plan review 2026-10-28). Blocked years are reported.
      const got = await fetchViaSitemap(SOURCE_LABEL, { urlTemplate: () => src.urlTemplate(y), urlFilter: src.urlFilter },
        new Date(0), { proxyRetry: false });
      if (!got.length) notes.push(`${y}: no URLs (blocked or empty; see log)`);
      items.push(...got);
    }
    const seen = new Set();
    return { items: items.filter((i) => !seen.has(i.url) && seen.add(i.url)), notes };
  } else {
    urls.push(...await fetchSitemapUrls(src.url, src.urlFilter));
  }
  return { items: [...new Set(urls)].map((url) => ({ url })), notes };
}

/** Fill headline/date/description from each page, cached per URL across runs. */
async function fillMeta(outletId, items, { refresh, concurrency }) {
  const cachePath = path.join(CACHE_DIR, `${outletId}.meta.json`);
  let cache = {};
  if (!refresh) { try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ } }
  let fetched = 0; let failed = 0;
  await pool(items, concurrency, async (item) => {
    const k = urlKey(item.url);
    if (!cache[k]) {
      try {
        const { status, body } = await get(item.url);
        cache[k] = status === 200 ? census.extractPageMeta(body) : { error: `HTTP ${status}` };
      } catch (e) { cache[k] = { error: e.message }; }
      fetched++;
      if (cache[k].error) failed++;
      if (fetched % 100 === 0) {
        console.log(`  meta ${fetched} fetched (${failed} failed)`);
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(cache));
      }
    }
    Object.assign(item, cache[k]);
  });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return { fetched, failed };
}

// ── corpus ─────────────────────────────────────────────────────────────────────

function loadCorpus() {
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reviews.json'), 'utf8')).reviews;
  const rows = reviews.map((r) => ({ showId: r.showId, outletId: r.outletId, url: r.url, publishDate: r.publishDate, source: 'reviews.json' }));
  let kind = 'reviews.json';
  if (fs.existsSync(REVIEW_TEXTS_DIR)) {
    kind = 'review-texts';
    for (const showId of fs.readdirSync(REVIEW_TEXTS_DIR)) {
      const dir = path.join(REVIEW_TEXTS_DIR, showId);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          rows.push({ showId, outletId: d.outletId, url: d.url, altUrls: d.altUrls, publishDate: d.publishDate, source: 'review-texts', file: `${showId}/${f}`,
            flags: ['wrongProduction', 'wrongShow', 'isRoundupArticle'].filter((k) => d[k]) });
        } catch { /* unreadable file vouches for nothing */ }
      }
    }
  }
  return { rows, kind };
}

// ── main ───────────────────────────────────────────────────────────────────────

async function runOutlet(outletId, o, shared) {
  const src = SOURCES[outletId];
  if (!src) { console.error(`no census source for ${outletId}`); return null; }
  console.log(`\n== ${outletId} (${src.kind})`);
  const enumerated = src.kind === 'wp-json' ? await enumerateWpJson(src, o.since)
    : src.kind === 'unreadable' ? { items: [], notes: [`unreadable: ${src.reason}`] }
      : await enumerateSitemap(src, o.since);
  let { items } = enumerated;
  console.log(`  enumerated ${items.length} URLs`);
  let meta = null;
  if (src.needsMeta) meta = await fillMeta(outletId, items, o);
  if (src.headlineFromSlug) for (const i of items) if (!i.headline) Object.assign(i, { headline: census.slugHeadline(i.url), dateSoft: true });
  const sinceMs = Date.parse(o.since);
  const dated = items.filter((i) => !i.publishDate || Date.parse(i.publishDate) >= sinceMs);
  const undated = dated.filter((i) => !i.publishDate).length;
  items = dated;

  const ctx = shared.ctx;
  const results = items.map((it) => {
    const full = { ...it, outletId, sourceSaysReview: !!src.sourceSaysReview, requireNycSignal: !!src.requireNycSignal };
    return { ...full, ...census.bucketItem(full, ctx) };
  });

  const enumeratedKeys = new Set(enumerated.items.map((i) => urlKey(i.url)));
  const outletRows = shared.corpus.rows.filter((r) => r.outletId === outletId && shared.ctx.nycIds.has(r.showId));
  const seenRow = new Set();
  const uniqRows = outletRows.filter((r) => { const k = `${r.showId}|${r.url}`; if (seenRow.has(k)) return false; seenRow.add(k); return true; });
  const misses = census.corpusSideMisses(uniqRows, enumeratedKeys, { sinceMs });

  const summary = census.summarize(results);
  const sample = (b, n = 40) => results.filter((r) => r.bucket === b).slice(0, n).map((r) => ({ url: r.url, headline: r.headline, publishDate: r.publishDate, via: r.matchVia, held: r.held, matched: r.matchedIds, outOfWindow: r.outOfWindowIds }));
  const report = {
    outletId,
    generatedAt: new Date().toISOString(),
    since: o.since,
    source: { kind: src.kind, notes: enumerated.notes, enumerated: enumerated.items.length, inWindow: items.length, undated, meta },
    corpus: shared.corpus.kind,
    summary,
    corpusSide: { rowsInWindow: uniqRows.length, notEnumerated: misses.filter((m) => m.why === 'not-enumerated').length, noUrl: misses.filter((m) => m.why === 'no-url').length, samples: misses.slice(0, 40) },
    gaps: sample('gap', 500),
    heldAltUrl: results.filter((r) => r.bucket === 'held-alt-url').slice(0, 60).map((r) => ({ url: r.url, headline: r.headline, publishDate: r.publishDate, matched: r.matchedIds, heldUrls: r.altUrls })),
    misfiles: sample('misfile', 200),
    heldUnmatched: sample('held-unmatched', 200),
    ambiguous: sample('ambiguous', 100),
    catalogGaps: sample('catalog-gap', 200),
    outOfWindow: sample('out-of-window', 100),
  };
  // Misfiles print the held file paths: cloud-run-script discards written files, so stdout is
  // the only way a CI run with review-texts can hand back what a fix plan must move.
  for (const m of report.misfiles) {
    const files = uniqRows.filter((r) => r.file && [r.url, ...(r.altUrls || [])].some((u) => u && census.urlKey(u) === census.urlKey(m.url))).map((r) => r.file);
    console.log(`  MISFILE ${m.url} matched=${(m.matched || []).join(',')} files=${files.join(',') || '(reviews.json only)'}`);
  }
  if (o.printGaps) for (const g of report.gaps) console.log(`  GAP ${(g.matched || []).join(',')} ${g.url}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { outletId, generatedAt: report.generatedAt, since: o.since, source: src.kind,
    items: results.map((r) => ({ url: r.url, publishDate: r.publishDate || null, headline: r.headline || null, bucket: r.bucket })) };
  fs.writeFileSync(path.join(OUT_DIR, `${outletId}.manifest.json`), JSON.stringify(manifest, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, `${outletId}.report.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(`  buckets ${JSON.stringify(summary.counts)} recall=${summary.recall}`);
  console.log(`  corpus-side: ${uniqRows.length} held rows in window, ${report.corpusSide.notEnumerated} not enumerated, ${report.corpusSide.noUrl} without URL`);
  return report;
}

/** Markdown table of every report on disk (for docs/specs/outlet-census.md). */
function summaryTable() {
  const lines = ['| Outlet | Source | Corpus rows | Enumerated | Held | Held (other URL) | Gap | Misfile | Ambiguous | Catalog gap | Recall |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.report.json')).sort();
  const rows = files.map((f) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')));
  rows.sort((a, b) => (a.summary.recall == null) - (b.summary.recall == null) || (a.summary.recall ?? 0) - (b.summary.recall ?? 0));
  for (const r of rows) {
    const c = r.summary.counts || {};
    const src = r.source.kind === 'unreadable' ? r.source.notes[0] : r.source.enumerated ? r.source.kind : `${r.source.kind}: ${(r.source.notes || [])[0] || 'nothing listed'}`;
    lines.push(`| ${r.outletId} | ${src.replace(/\|/g, '/')} | ${r.corpusSide.rowsInWindow} | ${r.source.enumerated} | ${c.held || 0} | ${c['held-alt-url'] || 0} | ${c.gap || 0} | ${c.misfile || 0} | ${c.ambiguous || 0} | ${c['catalog-gap'] || 0} | ${r.summary.recall ?? 'n/a'} |`);
  }
  return lines.join('\n');
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/outlet-census.js --outlet=a,b | --all [--since=2021-06-01] [--refresh] [--concurrency=6] [--print-gaps]\n       node scripts/outlet-census.js --summary   (markdown table of the reports on disk)');
    return;
  }
  const o = parseArgs(process.argv.slice(2));
  if (o.summary) { console.log(summaryTable()); return 0; }
  if (o.outlets.length === 0) { console.error('usage: --outlet=<id>[,<id>] | --all  [--since=YYYY-MM-DD] [--refresh]'); return 2; }
  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const allShows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
  const nyc = allShows.filter(census.isNycShow);
  const corpus = loadCorpus();
  const ctx = { shows: nyc, nycIds: new Set(nyc.map((s) => s.id)), corpus: census.buildCorpusIndex(corpus.rows), outletShowUrls: census.buildOutletShowIndex(corpus.rows), nycVenues: census.nycVenuePhrases(allShows) };
  console.log(`corpus: ${corpus.kind} (${corpus.rows.length} rows), ${nyc.length} NYC shows`);
  let failed = 0;
  for (const id of o.outlets) {
    try { await runOutlet(id, o, { ctx, corpus }); } catch (e) { failed++; console.error(`  ${id} failed: ${e.message}`); }
  }
  return failed ? 1 : 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });

module.exports = { parseArgs };
