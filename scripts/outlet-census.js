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
 *   --kind=serp,sitemap   only outlets of these source kinds;  --no-serp   skip the paid SERP kind
 *   --serp-budget=N       cap on SERP calls per run (default 1500)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { SOURCES, LONDON_SOURCES, sourceFromJson } = require('./lib/outlet-census-sources');
const census = require('./lib/outlet-census');
const { parseSitemapXml } = require('./lib/outlet-listing-helpers');
const { guardianItemIsReview } = require('./lib/we-major-recovery');
const { urlKey } = require('./lib/outlet-feed-reconcile');
const { fetchViaSitemap } = require('./outlet-listing-poller');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const BASE_OUT_DIR = path.join(ROOT, 'data', 'audit', 'outlet-census');
// London reports live in their own folder so outlet ids shared with NYC (guardian) never collide.
let OUT_DIR = BASE_OUT_DIR;
let CACHE_DIR = path.join(OUT_DIR, '.cache');
const ITEMS_TAG = 'CENSUS-ITEMS';
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function parseArgs(argv) {
  const o = { since: null, refresh: false, outlets: [], concurrency: 6, market: 'nyc', serpBudget: 1500, serpCalls: 0 };
  for (const a of argv) if (a.startsWith('--market=')) o.market = a.slice(9);
  const sources = o.market === 'london' ? LONDON_SOURCES : SOURCES;
  for (const a of argv) {
    if (a.startsWith('--outlet=')) o.outlets.push(...a.slice(9).split(','));
    else if (a === '--all') o.outlets.push(...Object.keys(sources));
    else if (a.startsWith('--kind=')) o.kinds = a.slice(7).split(',');
    else if (a.startsWith('--source=')) o.sourceJson = a.slice(9); // ad hoc source for one --outlet (CI probing)
    else if (a.startsWith('--until=')) o.until = a.slice(8);
    else if (a === '--emit-items') o.emitItems = true; // print enumerated items to stdout (CI hand-back)
    else if (a === '--enumerate-only') o.enumerateOnly = true;
    else if (a === '--from-cache') o.fromCache = true; // bucket the cached items, no network
    else if (a.startsWith('--items-in=')) o.itemsIn = a.slice(11); // a saved CI log with CENSUS-ITEMS lines
    else if (a.startsWith('--probe=')) o.probe = a.slice(8).split(',');
    else if (a.startsWith('--tier=')) o.tiers = a.slice(7).split(',').map(Number);
    else if (a.startsWith('--since=')) o.since = a.slice(8);
    else if (a === '--refresh') o.refresh = true;
    else if (a.startsWith('--concurrency=')) o.concurrency = Number(a.slice(14)) || 6;
    else if (a === '--print-gaps') o.printGaps = true;
    else if (a.startsWith('--serp-budget=')) o.serpBudget = Number(a.slice(14)) || 0;
    else if (a === '--no-serp') o.noSerp = true;
    else if (a === '--summary') o.summary = true;
  }
  if (!o.since) o.since = o.market === 'london' ? '2012-09-01' : '2021-06-01';
  o.sources = sources;
  return o;
}

async function get(url, timeoutMs = 30000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  let buf = Buffer.from(await res.arrayBuffer());
  // .xml.gz sitemaps arrive as gzip bytes (no Content-Encoding), so fetch does not inflate them.
  if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch { /* not gzip after all */ } }
  return { status: res.status, body: buf.toString('utf8'), headers: res.headers };
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
    // A dropped connection or a 429/5xx is retried twice (theater-life failed once on CI,
    // BRO-6514); a page that still fails ends the walk and marks the enumeration incomplete.
    let status = 0;
    let body = '';
    let err = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
      try { ({ status, body } = await get(`${src.apiBase}?${q}`)); err = null; } catch (e) { err = e; status = 0; }
      if (!census.isTransientFetch(status, err)) break;
    }
    // Unreachable from the first page: fail the outlet as before rather than write an empty report.
    if (err && page === 1) throw err;
    if (status === 400 && page > 1) break; // past the last page
    if (status !== 200) { notes.push(`page ${page}: ${err ? `fetch failed (${err.message})` : `HTTP ${status}`}`); break; }
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

// Guardian Content API (BRO-6488): section stage, reviews tone, one month per window so
// no query passes the API's page cap. Guardian and Observer share the stream and split on
// fields.publication; the month results are cached so a run asking for both pays once.
const guardianMonths = new Map();
async function enumerateGuardian(src, since, until) {
  const key = process.env.GUARDIAN_API_KEY || 'test';
  const items = [];
  const notes = [];
  const start = new Date(`${since.slice(0, 7)}-01T00:00:00Z`);
  const end = until ? new Date(until) : new Date();
  for (let d = start; d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const from = d.toISOString().slice(0, 10);
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const mk = `${src.query || ''}|${from}`;
    if (!guardianMonths.has(mk)) {
      const got = [];
      for (let page = 1; page < 20; page++) {
        const q = new URLSearchParams({ section: 'stage', tag: 'tone/reviews', 'from-date': from, 'to-date': to, 'page-size': '200', page: String(page),
          'order-by': 'oldest', 'show-fields': 'headline,standfirst,publication,byline,starRating', 'api-key': key, ...(src.params || {}) });
        let r;
        try { r = await get(`https://content.guardianapis.com/search?${q}`); } catch (e) { notes.push(`${from} p${page}: ${e.message}`); break; }
        if (r.status !== 200) { notes.push(`${from} p${page}: HTTP ${r.status}`); break; }
        const resp = JSON.parse(r.body).response || {};
        got.push(...(resp.results || []));
        if (key === 'test') await new Promise((ok) => setTimeout(ok, 1100)); // the public test key allows ~1 call/s
        if (!resp.pages || page >= resp.pages) break;
      }
      guardianMonths.set(mk, got);
    }
    for (const g of guardianMonths.get(mk)) {
      const f = g.fields || {};
      if (src.publication && !src.publication.test(f.publication || '')) continue;
      // News and blog pieces before 2013 carry tone/reviews too (BRO-6503): those the shared
      // predicate rejects fall back to the headline classifier (runOutlet drops theatreblog and
      // readers' reviews, cached items included).
      items.push({ url: g.webUrl, headline: census.decodeEntities(f.headline || g.webTitle || ''),
        description: census.decodeEntities(String(f.standfirst || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 400),
        publishDate: String(g.webPublicationDate || '').slice(0, 10), byline: f.byline || null, publication: f.publication || null,
        ...(guardianItemIsReview(g) ? {} : { sourceSaysReview: false }) });
    }
  }
  return { items, notes };
}

const SOURCE_LABEL = 'outlet-census';

async function fetchSitemapUrls(url, urlFilter, opts = {}) {
  const { status, body: raw } = await get(url, 60000);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  // CDATA-wrapped and entity-escaped <loc>s (Yoast, Arc) parse like plain ones.
  const body = raw.replace(/<!\[CDATA\[\s*([^\]]*?)\s*\]\]>/g, '$1').replace(/&amp;/g, '&');
  if (/<sitemapindex/i.test(body)) {
    // childFilter prunes an index to the children that can hold in-window reviews (a RegExp,
    // or a function of the child URL and since: Daily Beast lists one child per day back to 2008).
    const cf = opts.childFilter;
    const children = [...body.matchAll(/<loc>([^<]+)/g)].map((m) => m[1].trim())
      .filter((c) => !cf || (typeof cf === 'function' ? cf(c, opts.since) : cf.test(c)));
    const out = [];
    await pool(children, opts.childConcurrency || 1, async (c) => {
      try { out.push(...await fetchSitemapUrls(c, urlFilter, opts)); } catch (e) { console.log(`  child ${c}: ${e.message}`); (opts.notes || []).push(`child ${c}: ${e.message}`); }
    });
    return out;
  }
  // A URL last modified before the window was published before it too.
  return parseSitemapXml(body, opts.since ? new Date(opts.since) : new Date(0), urlFilter);
}

/** {yyyy} {mm} {dd} in a sitemap URL template, stepped by year, month or day from since. */
function datedSitemapUrls(template, step, since, until) {
  const out = [];
  const end = until ? new Date(until) : new Date();
  let d = new Date(`${since}T00:00:00Z`);
  if (step !== 'day') d = new Date(Date.UTC(d.getUTCFullYear(), step === 'year' ? 0 : d.getUTCMonth(), 1));
  while (d <= end) {
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    out.push(template.replace(/\{yyyy\}/g, yyyy).replace(/\{mm\}/g, mm).replace(/\{m\}/g, String(d.getUTCMonth() + 1)).replace(/\{dd\}/g, dd));
    d = step === 'year' ? new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1)) : step === 'month' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) : new Date(d.getTime() + 86400000);
  }
  return out;
}

async function enumerateSitemap(src, since) {
  const notes = [];
  if (src.kind === 'sitemap-years') {
    const y0 = Number(since.slice(0, 4));
    const items = [];
    for (let y = y0; y <= new Date().getFullYear(); y++) {
      // The poller's own fetcher (honest UA), direct only: the census never spends paid
      // scraper credit to enumerate (plan review 2026-10-28). Blocked years are reported.
      const got = await fetchViaSitemap(SOURCE_LABEL, { urlTemplate: () => src.urlTemplate(y), urlFilter: src.urlFilter },
        new Date(0), { proxyRetry: !!src.proxyRetry });
      if (!got.length) notes.push(`${y}: no URLs (blocked or empty; see log)`);
      items.push(...got);
    }
    const seen = new Set();
    return { items: items.filter((i) => !seen.has(i.url) && seen.add(i.url)), notes };
  } else if (src.kind === 'sitemap-dated') {
    const items = [];
    const maps = datedSitemapUrls(src.template, src.step || 'month', since, src.until);
    let empty = 0;
    await pool(maps, src.concurrency || 4, async (u) => {
      try {
        const got = await fetchSitemapUrls(u, src.urlFilter, { childFilter: src.childFilter });
        if (!got.length) empty++;
        // The sitemap's own period stands in for the date until page meta replaces it.
        const period = /(\d{4})[-/]?(\d{2})?[-/]?(\d{2})?/.exec(u.replace(/^https?:\/\/[^/]+/, '')) || [];
        for (const g of got) items.push({ url: g.url, lastmod: g.publishDate || null, sitemap: u, periodDate: period[1] ? `${period[1]}-${period[2] || '01'}-${period[3] || '01'}` : null });
      } catch (e) { empty++; if (notes.length < 30) notes.push(`${u}: ${e.message}`); }
    });
    notes.push(`${maps.length} sitemaps, ${empty} empty or failed`);
    const seen = new Set();
    return { items: items.filter((i) => !seen.has(i.url) && seen.add(i.url)), notes };
  } else {
    const got = [];
    for (const u of [].concat(src.url)) {
      got.push(...await fetchSitemapUrls(u, src.urlFilter, { childFilter: src.childFilter, since, notes, childConcurrency: src.childConcurrency }));
    }
    const seen = new Set();
    return { items: got.filter((i) => !seen.has(i.url) && seen.add(i.url)).map((g) => ({ url: g.url, lastmod: g.publishDate || null })), notes };
  }
}

/**
 * Wayback CDX rows ([original, timestamp]) to census items: one per canonical https URL,
 * earliest capture as a soft period date (a capture is on or after publication). Free
 * enumeration for outlets whose own sitemap starts late (The Stage: 2021-10).
 */
function cdxItems(rows, src) {
  const byUrl = new Map();
  for (const [orig, ts] of rows) {
    if (!orig || !/^\d{8}/.test(ts || '')) continue;
    let u;
    try { u = new URL(/^https?:/i.test(orig) ? orig : `https://${orig}`); } catch { continue; }
    const host = src.cdxHost || u.hostname.replace(/^www\./, '');
    const url = `https://${src.cdxCanonicalHost || `www.${host}`}${u.pathname.replace(/\/+$/, '')}`;
    if (src.urlFilter && !src.urlFilter.test(url)) continue;
    const d = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    const prev = byUrl.get(url);
    if (!prev || d < prev.periodDate) byUrl.set(url, { url, lastmod: null, periodDate: d, via: 'wayback-cdx' });
  }
  return [...byUrl.values()];
}

async function enumerateCdx(src, since, until) {
  const notes = [];
  const rows = [];
  const y1 = Number((until || src.until || new Date().toISOString()).slice(0, 4));
  for (const prefix of src.prefixes) {
    for (let y = Number(since.slice(0, 4)); y <= y1; y++) {
      const q = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(prefix)}&matchType=prefix&collapse=urlkey&fl=original,timestamp&filter=statuscode:200&from=${y}&to=${y}&output=json`;
      let got = null;
      for (let attempt = 0; attempt < 3 && !got; attempt++) {
        try {
          const { status, body } = await get(q, 180000);
          if (status === 200) got = body.trim() ? JSON.parse(body).slice(1) : [];
          else if (attempt === 2) notes.push(`${prefix} ${y}: HTTP ${status}`);
        } catch (e) { if (attempt === 2) notes.push(`${prefix} ${y}: ${e.message}`); }
        if (!got) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      }
      if (got) rows.push(...got);
    }
  }
  const items = cdxItems(rows, src).filter((i) => i.periodDate >= since);
  notes.push(`wayback cdx: ${rows.length} captures, ${items.length} URLs`);
  return { items, notes };
}

/**
 * Site-scoped Google search per calendar quarter (BRO-6485): for outlets whose site,
 * sitemaps and API all refuse the census client (403s, challenge pages). Each query is
 * date-windowed so an old production's review cannot surface for a new one; a SERP
 * date is only Google's guess, so items carry the window midpoint as a soft date when
 * neither the URL nor the snippet dates them. Paid: serpQuery runs ScrapingDog first;
 * --serp-budget caps the calls per run.
 */
async function enumerateSerp(src, since, o) {
  const { serpQuery } = require('./lib/url-discovery');
  const notes = [];
  const byUrl = new Map();
  const seen = new Set();
  const maxPages = src.maxPages || 5;
  let calls = 0; let capHits = 0;
  const finish = () => {
    const suffixes = census.commonTitleSuffixes([...byUrl.values()].map((i) => i.rawTitle));
    const items = [...byUrl.values()].map(({ rawTitle, ...i }) => ({ ...i, headline: census.cleanSerpTitle(rawTitle, suffixes) }));
    if (capHits) notes.push(`page cap ${maxPages} hit in ${capHits} quarter-queries (more results not read)`);
    return { items, notes, calls };
  };
  for (const window of census.quarterWindows(since)) {
    for (const query of src.queries) {
      for (let page = 0; page < maxPages; page++) {
        if (o.serpCalls >= o.serpBudget) { notes.push(`serp budget ${o.serpBudget} reached`); return finish(); }
        o.serpCalls++; calls++;
        const results = await serpQuery(query, { dateRange: window, page, nbResults: 10, log: () => {} });
        if (results == null) { notes.push(`no SERP provider for "${query}"`); return finish(); }
        let fresh = 0;
        for (const r of results) {
          if (!r.url) continue;
          const k = urlKey(r.url);
          if (seen.has(k)) continue;
          seen.add(k); fresh++;
          if (src.urlFilter && !src.urlFilter.test(r.url)) continue;
          byUrl.set(k, { url: r.url, rawTitle: r.title, description: String(r.snippet || '').slice(0, 400), ...census.serpItemDate(r, window) });
        }
        // Stop on a short page (Google sometimes returns 9 of 10, so under 8) or Google repeating
        // itself, counted before urlFilter so a page of off-topic hits does not end the quarter.
        // A full last page means more remain: noted, and the run counts as incomplete.
        if (results.length < 8 || fresh === 0) break;
        if (page === maxPages - 1) capHits++;
      }
    }
  }
  notes.push(`${calls} SERP calls`);
  return finish();
}

/** Fill headline/date/description from each page, cached per URL across runs. */
async function fillMeta(outletId, items, { refresh, concurrency }) {
  const cachePath = path.join(CACHE_DIR, `${outletId}.meta.json`);
  let cache = {};
  if (!refresh) { try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ } }
  let fetched = 0; let failed = 0;
  await pool(items, concurrency, async (item) => {
    const k = urlKey(item.url);
    // Entries cached before reviewAuthor existed are re-read once (BRO-6485).
    if (!cache[k] || (!cache[k].error && !('reviewAuthor' in cache[k]))) {
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
    const m = cache[k];
    for (const [key, v] of Object.entries(m)) {
      if (key === 'dateSoft' && m.publishDate == null) continue; // a kept lastmod date stays soft
      if (v != null || item[key] == null) item[key] = v;
    }
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

/** Items one CI run handed back (--emit-items), keyed by outlet: gzip+base64 chunks. */
function readEmittedItems(file) {
  const parts = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = new RegExp(`${ITEMS_TAG} (\\S+) (\\d+)/(\\d+) (\\S+)`).exec(line);
    if (!m) continue;
    // A new 1/n chunk starts a fresh emission: the latest run wins, never a mix of two.
    if (!parts.has(m[1]) || m[2] === '1') parts.set(m[1], { n: Number(m[3]), chunks: [] });
    parts.get(m[1]).chunks[Number(m[2]) - 1] = m[4];
  }
  const out = {};
  for (const [id, p] of parts) {
    if (p.chunks.filter(Boolean).length !== p.n) { console.error(`  ${id}: ${p.chunks.filter(Boolean).length}/${p.n} chunks, skipped`); continue; }
    try { out[id] = JSON.parse(zlib.gunzipSync(Buffer.from(p.chunks.join(''), 'base64')).toString('utf8')); }
    catch (e) { console.error(`  ${id}: unreadable items (${e.message}), skipped`); }
  }
  return out;
}

function emitItems(outletId, payload) {
  const b64 = zlib.gzipSync(Buffer.from(JSON.stringify(payload))).toString('base64');
  const size = 20000; // well under the Actions log line limit
  const n = Math.max(1, Math.ceil(b64.length / size));
  for (let i = 0; i < n; i++) console.log(`${ITEMS_TAG} ${outletId} ${i + 1}/${n} ${b64.slice(i * size, (i + 1) * size)}`);
}

async function enumerateOutlet(outletId, src, o) {
  if (src.kind === 'wp-json') return enumerateWpJson(src, o.since);
  if (src.kind === 'guardian-api') return enumerateGuardian(src, o.since, o.until);
  if (src.kind === 'unreadable') return { items: [], notes: [`unreadable: ${src.reason}`] };
  if (src.kind === 'cdx') return enumerateCdx(src, o.since, o.until);
  if (src.kind === 'serp') return enumerateSerp(src, o.since, o);
  if (src.kind === 'composite') {
    // Several sources for one outlet (sitemap + Wayback for the years the sitemap lacks);
    // the first source to list a URL wins, so live sitemap dates beat capture dates.
    const seen = new Set(); const items = []; const notes = [];
    for (const part of src.parts) {
      const got = await enumerateOutlet(outletId, { ...src, ...part, parts: undefined }, o);
      notes.push(...got.notes.map((n) => `${part.kind}: ${n}`));
      for (const it of got.items) { const k = urlKey(it.url); if (!seen.has(k)) { seen.add(k); items.push(it); } }
    }
    return { items, notes };
  }
  return enumerateSitemap({ ...src, until: o.until }, o.since);
}

async function runOutlet(outletId, o, shared) {
  let src = o.sources[outletId];
  if (o.sourceJson) src = sourceFromJson(JSON.parse(o.sourceJson));
  if (!src) { console.error(`no census source for ${outletId} (market ${o.market})`); return null; }
  console.log(`\n== ${outletId} (${src.kind})`);
  const itemsPath = path.join(CACHE_DIR, `${outletId}.items.json`);
  let enumerated;
  if (o.fromCache || (shared.imported && shared.imported[outletId])) {
    enumerated = (shared.imported && shared.imported[outletId]) || JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
    console.log(`  ${enumerated.items.length} items from ${shared.imported && shared.imported[outletId] ? 'the CI hand-back' : 'cache'}`);
  } else {
    enumerated = await enumerateOutlet(outletId, src, o);
    console.log(`  enumerated ${enumerated.items.length} URLs`);
    if (src.needsMeta) enumerated.meta = await fillMeta(outletId, enumerated.items, o);
  }
  // Pages that would not give meta keep the sitemap's period or lastmod as a soft date.
  const bulkDays = census.bulkLastmodDays(enumerated.items);
  if (bulkDays.size) console.log(`  lastmod ignored on bulk re-touch day(s) ${[...bulkDays].join(', ')}`);
  for (const i of enumerated.items) {
    if (i.lastmod && bulkDays.has(String(i.lastmod).slice(0, 10))) i.lastmod = null;
    if (!i.headline && (src.headlineFromSlug || src.needsMeta)) Object.assign(i, { headline: census.slugHeadline(i.url), headlineFromSlug: true });
    if (!i.publishDate && (i.periodDate || i.lastmod)) Object.assign(i, { publishDate: i.periodDate || String(i.lastmod).slice(0, 10), dateSoft: true });
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!o.fromCache) fs.writeFileSync(itemsPath, JSON.stringify(enumerated));
  if (o.emitItems) emitItems(outletId, enumerated);
  if (o.enumerateOnly) return { outletId, enumerated: enumerated.items.length };
  if (!shared.ctx) return null;
  let { items } = enumerated;
  // Guardian theatreblog posts and readers' reviews / round-ups are never one critic's review
  // (BRO-6503). Filtered here so --from-cache and --items-in runs saved earlier drop them too.
  if (src.kind === 'guardian-api') items = items.filter((i) => !/\/theatreblog\//.test(i.url || '') && !/\b(round ?up|readers?'? reviews?)\b/i.test(i.headline || ''));
  const sinceMs = Date.parse(o.since);
  const dated = items.filter((i) => !i.publishDate || Date.parse(i.publishDate) >= sinceMs);
  const undated = dated.filter((i) => !i.publishDate).length;
  items = dated;

  const ctx = shared.ctx;
  const corpusIds = new Set([outletId, ...(src.corpusOutletIds || [])]);
  const outletRows = shared.corpus.rows.filter((r) => corpusIds.has(r.outletId) && ctx.nycIds.has(r.showId));
  // Outlets that kept an article number across a URL migration: held URL by that number.
  const idRe = src.urlId ? new RegExp(src.urlId) : null;
  const heldById = new Map();
  if (idRe) for (const r of outletRows) { const m = r.url && idRe.exec(r.url); if (m) heldById.set(m[1], census.urlKey(r.url)); }
  const results = items.map((it) => {
    const idm = idRe && idRe.exec(it.url);
    const aliasKey = idm ? heldById.get(idm[1]) : undefined;
    // requireReviewAuthor: the source path mixes reviews with listings; only a page naming its critic counts.
    const sourceSaysReview = !!src.sourceSaysReview && it.sourceSaysReview !== false && (!src.requireReviewAuthor || !!it.reviewAuthor);
    const full = { ...it, aliasKey, outletId, sourceSaysReview, requireNycSignal: !!src.requireNycSignal };
    return { ...full, ...census.bucketItem(full, ctx) };
  });

  const enumeratedKeys = new Set(enumerated.items.map((i) => urlKey(i.url)));
  for (const r of results) if (r.aliasKey) enumeratedKeys.add(r.aliasKey);
  const seenRow = new Set();
  const uniqRows = outletRows.filter((r) => { const k = `${r.showId}|${r.url}`; if (seenRow.has(k)) return false; seenRow.add(k); return true; });
  const misses = census.corpusSideMisses(uniqRows, enumeratedKeys, { sinceMs, untilMs: o.until ? Date.parse(o.until) + 86400000 : Infinity });

  const summary = census.summarize(results);
  // Per season (September to August): the coverage table the card asks for.
  const seasons = {};
  for (const r of results) {
    const k = census.seasonOf(r.publishDate);
    seasons[k] = seasons[k] || {};
    seasons[k][r.bucket] = (seasons[k][r.bucket] || 0) + 1;
  }
  const sample = (b, n = 40) => results.filter((r) => r.bucket === b).slice(0, n).map((r) => ({ url: r.url, headline: r.headline, publishDate: r.publishDate, dateSoft: r.dateSoft || undefined, via: r.matchVia, held: r.held, matched: r.matchedIds, outOfWindow: r.outOfWindowIds, itemMarket: r.itemMarket, venueHint: r.venueHint || undefined }));
  const report = {
    outletId,
    market: o.market,
    generatedAt: new Date().toISOString(),
    since: o.since,
    source: { kind: src.kind, notes: enumerated.notes, incomplete: census.isIncompleteEnumeration(enumerated.notes), enumerated: enumerated.items.length, inWindow: items.length, undated, meta: enumerated.meta || null },
    corpus: shared.corpus.kind,
    summary,
    seasons,
    corpusSide: { rowsInWindow: uniqRows.length, notEnumerated: misses.filter((m) => m.why === 'not-enumerated').length, noUrl: misses.filter((m) => m.why === 'no-url').length, samples: misses.slice(0, 40) },
    gaps: sample('gap', 2000),
    heldAltUrl: results.filter((r) => r.bucket === 'held-alt-url').slice(0, 60).map((r) => ({ url: r.url, headline: r.headline, publishDate: r.publishDate, matched: r.matchedIds, heldUrls: r.altUrls })),
    misfiles: sample('misfile', 300),
    heldUnmatched: sample('held-unmatched', 300),
    ambiguous: sample('ambiguous', 200),
    catalogGaps: sample('catalog-gap', 3000),
    otherMarketReviews: sample('other-market-review', 5000),
    outOfWindow: sample('out-of-window', 300),
  };
  // Misfiles print the held file paths: cloud-run-script discards written files, so stdout is
  // the only way a CI run with review-texts can hand back what a fix plan must move.
  for (const m of report.misfiles) {
    const files = uniqRows.filter((r) => r.file && [r.url, ...(r.altUrls || [])].some((u) => u && census.urlKey(u) === census.urlKey(m.url))).map((r) => r.file);
    console.log(`  MISFILE ${m.url} matched=${(m.matched || []).join(',')} files=${files.join(',') || '(reviews.json only)'}`);
  }
  if (o.printGaps) for (const g of report.gaps) console.log(`  GAP ${(g.matched || []).join(',')} ${g.url}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { outletId, market: o.market, generatedAt: report.generatedAt, since: o.since, source: src.kind,
    items: results.map((r) => ({ url: r.url, publishDate: r.publishDate || null, dateSoft: r.dateSoft || undefined, headline: r.headline || null, bucket: r.bucket,
      matched: r.matchedIds && r.matchedIds.length ? r.matchedIds : undefined, itemMarket: r.itemMarket, venueHint: r.venueHint || undefined })) };
  fs.writeFileSync(path.join(OUT_DIR, `${outletId}.manifest.json`), JSON.stringify(manifest, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, `${outletId}.report.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(`  buckets ${JSON.stringify(summary.counts)} recall=${summary.recall}${report.source.incomplete ? ' (INCOMPLETE: ' + enumerated.notes.join('; ') + ')' : ''}`);
  console.log(`  corpus-side: ${uniqRows.length} held rows in window, ${report.corpusSide.notEnumerated} not enumerated, ${report.corpusSide.noUrl} without URL`);
  return report;
}

/** --probe: status, size and the first URLs of each address, to configure a source from CI. */
async function probe(urls) {
  for (const u of urls) {
    try {
      const { status, body } = await get(u, 45000);
      const locs = [...body.matchAll(/<loc>(?:<!\[CDATA\[)?([^<\]]+)/g)].map((m) => m[1].trim());
      const rev = locs.filter((l) => /review/i.test(l));
      console.log(`PROBE ${status} ${u} bytes=${body.length} locs=${locs.length} review-locs=${rev.length} index=${/<sitemapindex/i.test(body)}`);
      console.log(`  head: ${body.slice(0, 500).replace(/\s+/g, ' ')}`);
      if (/<sitemapindex/i.test(body)) console.log(`  children: ${locs.slice(0, 15).join(' ')} ... ${locs.slice(-15).join(' ')}`);
      else console.log(`  sample: ${(rev.length ? rev : locs).slice(0, 8).join(' ')} ... ${(rev.length ? rev : locs).slice(-4).join(' ')}`);
      const lm = [...body.matchAll(/<lastmod>([^<]+)/g)].map((m) => m[1]);
      if (lm.length) console.log(`  lastmod: ${lm[0]} .. ${lm[lm.length - 1]}`);
    } catch (e) { console.log(`PROBE ERR ${u} ${e.message}`); }
  }
}

/** Markdown table of every report on disk (for docs/specs/outlet-census.md). */
function summaryTable(market = 'nyc') {
  const london = market === 'london';
  const head = ['Outlet', 'Source', 'Corpus rows', 'Enumerated', 'Held', 'Held (other URL)', 'Gap', 'Misfile', 'Ambiguous', 'Catalog gap', ...(london ? ['Other market'] : []), 'Recall'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.report.json')).sort();
  const rows = files.map((f) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')));
  rows.sort((a, b) => (a.summary.recall == null) - (b.summary.recall == null) || (a.summary.recall ?? 0) - (b.summary.recall ?? 0));
  for (const r of rows) {
    const c = r.summary.counts || {};
    const src = (r.source.kind === 'unreadable' ? r.source.notes[0] : r.source.enumerated ? r.source.kind : `${r.source.kind}: ${(r.source.notes || [])[0] || 'nothing listed'}`)
      + (r.source.incomplete ? ' (incomplete)' : '');
    const cells = [r.outletId, src.replace(/\|/g, '/'), r.corpusSide.rowsInWindow, r.source.enumerated, c.held || 0, c['held-alt-url'] || 0, c.gap || 0, c.misfile || 0, c.ambiguous || 0, c['catalog-gap'] || 0,
      ...(london ? [c['other-market-review'] || 0] : []), r.summary.recall ?? 'n/a'];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

/** Per outlet and season: published (every review item), held, gap, misfile, catalog gap, ambiguous. */
function seasonTable() {
  const lines = ['| Outlet | Season | Reviews listed | Held | Gap | Misfile | Ambiguous | Catalog gap | Other market |', '|---|---|---|---|---|---|---|---|---|'];
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.report.json')).sort();
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
    for (const [season, c] of Object.entries(r.seasons || {}).sort()) {
      const listed = Object.entries(c).filter(([b]) => !['not-review', 'out-of-window'].includes(b)).reduce((n, [, v]) => n + v, 0);
      lines.push(`| ${r.outletId} | ${season} | ${listed} | ${(c.held || 0) + (c['held-alt-url'] || 0)} | ${c.gap || 0} | ${c.misfile || 0} | ${c.ambiguous || 0} | ${c['catalog-gap'] || 0} | ${c['other-market-review'] || 0} |`);
    }
  }
  return lines.join('\n');
}

/** Catalog gaps and other-market reviews across every London report, by market, venue and year. */
function catalogGapSummary() {
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.report.json'));
  const entries = [];
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
    for (const g of [...(r.catalogGaps || []), ...(r.otherMarketReviews || [])]) entries.push({ ...g, outletId: r.outletId });
  }
  return census.groupCatalogGaps(entries);
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log([
      'Usage: node scripts/outlet-census.js --outlet=a,b | --all [--market=nyc|london] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--refresh] [--concurrency=6] [--print-gaps]',
      '       --kind=serp,sitemap  only outlets of these source kinds;  --no-serp  skip the paid SERP kind;  --serp-budget=N  SERP call cap (default 1500)',
      '       --tier=1,2         with --all: only outlets of these registry tiers',
      '       --emit-items       print the enumerated items as CENSUS-ITEMS lines (CI hand-back)',
      '       --enumerate-only   enumerate and cache, no bucketing',
      '       --items-in=FILE    bucket the CENSUS-ITEMS lines of a saved CI log (no network)',
      '       --from-cache       bucket the cached items (no network)',
      '       --source=JSON      ad hoc source for one --outlet (string regexes)',
      '       --probe=url,url    print status, size and sample locs of each URL',
      '       --summary          markdown tables of the reports on disk (with --market=london: seasons and catalog gaps too)',
    ].join('\n'));
    return 0;
  }
  const o = parseArgs(process.argv.slice(2));
  if (o.market === 'london') { OUT_DIR = path.join(BASE_OUT_DIR, 'london'); CACHE_DIR = path.join(OUT_DIR, '.cache'); }
  if (o.probe) { await probe(o.probe); return 0; }
  if (o.summary) {
    console.log(summaryTable(o.market));
    if (o.market === 'london') {
      console.log(`\n${seasonTable()}`);
      const g = catalogGapSummary();
      fs.writeFileSync(path.join(OUT_DIR, 'catalog-gaps.json'), JSON.stringify(g, null, 2) + '\n');
      console.log(`\n${census.catalogGapMarkdown(g)}`);
    }
    return 0;
  }
  if (o.kinds) o.outlets = o.outlets.filter((id) => o.sources[id] && o.kinds.includes(o.sources[id].kind));
  if (o.noSerp) o.outlets = o.outlets.filter((id) => o.sources[id] && o.sources[id].kind !== 'serp');
  if (o.tiers) o.outlets = o.outlets.filter((id) => o.tiers.includes(o.sources[id] && o.sources[id].tier));
  const imported = o.itemsIn ? readEmittedItems(o.itemsIn) : null;
  if (imported && o.outlets.length === 0) o.outlets = Object.keys(imported);
  if (o.outlets.length === 0) { console.error('usage: --outlet=<id>[,<id>] | --all  [--market=london] [--since=YYYY-MM-DD] [--refresh]'); return 2; }
  let ctx = null;
  let corpus = null;
  if (!o.enumerateOnly) {
    const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
    const allShows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
    const shows = allShows.filter((s) => census.isMarketShow(s, o.market));
    corpus = loadCorpus();
    ctx = { market: o.market, shows, nycIds: new Set(shows.map((s) => s.id)), corpus: census.buildCorpusIndex(corpus.rows), outletShowUrls: census.buildOutletShowIndex(corpus.rows), nycVenues: census.nycVenuePhrases(allShows, o.market) };
    console.log(`corpus: ${corpus.kind} (${corpus.rows.length} rows), ${shows.length} ${o.market} shows`);
  }
  let failed = 0;
  for (const id of o.outlets) {
    try { await runOutlet(id, o, { ctx, corpus, imported }); } catch (e) { failed++; console.error(`  ${id} failed: ${e.message}`); }
  }
  return failed ? 1 : 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });

module.exports = { parseArgs, readEmittedItems, emitItems, datedSitemapUrls, cdxItems };
