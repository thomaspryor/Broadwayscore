#!/usr/bin/env node
/**
 * BRO-7780: compare every stored critic name with the byline the review page prints.
 *
 * A page's structured author (JSON-LD / meta / CMS account) can be whoever POSTED the article,
 * not the critic (TheaterMania's editor David Gordon, BRO-7745). This reads each stored review's
 * page (free direct fetch, then the newest archive.org copy) and records what every byline reader
 * says next to the stored name. Read-only: fixes go through a pending-fix plan.
 *
 *   node scripts/sweep-stored-bylines.js --outlets=theatermania --out=/tmp/tm.jsonl
 *   node scripts/sweep-stored-bylines.js --tiers=1,2 --per-outlet=8 --out=/tmp/sample.jsonl
 *   node scripts/sweep-stored-bylines.js --report=/tmp/tm.jsonl        (summary of a finished run)
 *
 * --delay-ms=N waits N ms between fetches per worker (slow, rate-limit-safe pace). --paid uses the scraper's paid tiers (paywalled outlets). Resumable: rows already in --out are skipped. --save-html=<dir> keeps each fetched page
 * (for building byline fixtures; never commit a full page).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

/** One row's verdict from the readers' answers. Pure; exported for the test. */
function classify(stored, page) {
  const { sameCriticName } = require('./lib/byline-from-text');
  if (page.fetchError) return 'fetch-failed';
  const name = page.pageByline;
  if (!name) return 'no-page-byline';
  if (!stored || /^unknown$/i.test(String(stored).trim())) return 'stored-missing';
  return sameCriticName(stored, name) ? 'match' : 'mismatch';
}

/** The fetched page's canonical/og:url names the same article as `url` (shared numeric id or 2+ slug words). */
function sameArticle(url, html) {
  const m = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i.exec(html) || /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)/i.exec(html);
  if (!m) return false;
  const words = (u) => new Set(String(u).toLowerCase().replace(/^https?:\/\/[^/]+/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^(?:www|com|html|news|reviews?|broadway|off|the|and)$/.test(w)));
  const a = words(url), b = words(m[1]);
  const ids = [...a].filter((w) => /^\d{4,}$/.test(w));
  if (ids.length) return ids.some((id) => b.has(id));
  return [...a].filter((w) => b.has(w)).length >= 2;
}

function readSignals(html, text, url, outletId) {
  const bx = require('./lib/byline-extraction');
  const { readPageByline } = require('./lib/page-byline');
  const { extractAuthorFromHtml } = require('./lib/content-quality');
  const safe = (fn) => { try { return fn() || null; } catch { return null; } };
  const page = safe(() => readPageByline({ html, text, url, outletId })) || {};
  return {
    pageByline: page.criticName || null,
    bylineConflict: page.bylineConflict || null,
    ingestReader: safe(() => extractAuthorFromHtml(html, text, { url, outletId })),
    laneReaderOld: safe(() => bx.extractByline(html)),
    jsonLd: safe(() => bx.extractJsonLdAuthor(html)),
    tmTag: safe(() => bx.extractTheaterManiaAuthorTag(html)),
  };
}

function report(file) {
  // A retried row is appended; the latest row per review wins.
  const latest = new Map();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); latest.set(r.key, r); }
  const rows = [...latest.values()];
  const by = {};
  for (const r of rows) {
    const o = (by[r.outletId] = by[r.outletId] || {});
    o[r.verdict] = (o[r.verdict] || 0) + 1;
  }
  console.log(`${rows.length} rows`);
  for (const [o, c] of Object.entries(by).sort()) console.log(`  ${o.padEnd(28)} ${JSON.stringify(c)}`);
  const mm = rows.filter((r) => r.verdict === 'mismatch');
  console.log(`\n${mm.length} mismatches:`);
  for (const r of mm) console.log(`  ${r.showId} | ${r.outletId} | stored "${r.stored}" | page "${r.pageByline}" (via ${r.via}) | ${r.url}`);
  return rows;
}

async function main() {
  if (require('./lib/cli-help').hasHelpFlag(process.argv.slice(2))) { require('./lib/cli-help').exitOnHelp(module); return; }
  if (args.report) { report(args.report); return; }
  const out = args.out;
  if (!out) { console.error('--out=<file.jsonl> is required'); process.exit(2); }
  const reviews = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'reviews.json'), 'utf8')).reviews;
  let outlets = args.outlets ? new Set(String(args.outlets).split(',')) : null;
  if (!outlets && args.tiers) {
    const tiers = new Set(String(args.tiers).split(',').map(Number));
    const reg = require('../data/outlet-registry.json');
    const list = Array.isArray(reg.outlets) ? reg.outlets : Object.entries(reg.outlets || reg).map(([id, v]) => ({ id, ...v }));
    outlets = new Set(list.filter((o) => tiers.has(o.tier)).map((o) => o.id));
  }
  if (!outlets) { console.error('--outlets=a,b or --tiers=1,2 is required'); process.exit(2); }
  const perOutlet = args['per-outlet'] ? Number(args['per-outlet']) : Infinity;

  const done = new Set();
  const failedKeys = new Set();
  if (fs.existsSync(out)) {
    for (const l of fs.readFileSync(out, 'utf8').split('\n')) {
      if (!l) continue;
      const row = JSON.parse(l);
      done.add(row.key);
      if (row.verdict === 'fetch-failed') failedKeys.add(row.key); else failedKeys.delete(row.key);
    }
  }
  const picked = {};
  const queue = [];
  // Newest first, so a sample sees the current template.
  // --url-match=<substring>: only reviews whose url contains it (one page, e.g. a known bad row).
  const urlMatch = typeof args['url-match'] === 'string' ? args['url-match'] : null;
  const sorted = reviews.filter((r) => r && r.url && outlets.has(r.outletId) && (!urlMatch || r.url.includes(urlMatch)))
    .sort((a, b) => String(b.publishDate || '').localeCompare(String(a.publishDate || '')));
  const seenUrl = new Set();
  for (const r of sorted) {
    const key = `${r.showId}|${r.outletId}|${r.url}`;
    if (seenUrl.has(key)) continue;
    seenUrl.add(key);
    picked[r.outletId] = (picked[r.outletId] || 0) + 1;
    if (picked[r.outletId] > perOutlet) continue;
    if (!done.has(key)) queue.push({ key, r });
    else if (args['retry-failed'] && failedKeys.has(key)) queue.push({ key, r });
  }
  console.log(`${queue.length} pages to read (${done.size} already in ${out})`);

  const { fetchPage } = require('./lib/scraper');
  const { fetchWithArchiveFallback } = require('./lib/fetch-archive-fallback');
  const { extractArticleTextFromUrl } = require('./lib/article-extractor');
  const saveDir = typeof args['save-html'] === 'string' ? args['save-html'] : null;
  if (saveDir) fs.mkdirSync(saveDir, { recursive: true });
  const quiet = () => {};
  const concurrency = Number(args.concurrency || 4);
  const delayMs = Number(args['delay-ms'] || 0);
  let i = 0;
  let n = 0;
  async function worker() {
    while (i < queue.length) {
      const { key, r } = queue[i++];
      // BRO-7792: --delay-ms=N spaces fetches per worker (TheaterMania rate-limited the full sweep at default speed).
      if (delayMs && n > 0) await new Promise((res) => setTimeout(res, delayMs));
      const row = { key, showId: r.showId, outletId: r.outletId, url: r.url, stored: r.criticName || null };
      try {
        const log = console.log; console.log = quiet;
        let got;
        try {
          // --follow-redirects: an old url that redirects to the article's new address (TheaterMania's
          // /broadway/reviews/<slug>_<id>.html) is read there; the page must name the same article.
          // --paid: the scraper's full fallback chain (paid tiers) for paywalled / bot-blocked outlets.
          got = await fetchWithArchiveFallback(r.url, { fetchPageFn: (u) => fetchPage(u, { ...(args.paid ? {} : { directOnly: true }), ...(args['follow-redirects'] ? { skipVerify: true } : {}) }) });
          if (got && got.html && args['follow-redirects'] && !sameArticle(r.url, got.html)) throw new Error('redirected to a different page');
        } finally { console.log = log; }
        if (!got || !got.html) throw new Error((got && got.error) || 'no html');
        row.via = got.via === 'archive' ? 'archive' : 'live';
        let text = '';
        try { text = extractArticleTextFromUrl(got.html, r.url) || ''; } catch { text = ''; }
        Object.assign(row, readSignals(got.html, text, r.url, r.outletId));
        if (saveDir) fs.writeFileSync(path.join(saveDir, require('./lib/byline-fixture-strip').savedPageName(r.outletId, r.url)), got.html);
      } catch (e) {
        row.fetchError = String(e && e.message || e).slice(0, 120);
      }
      row.verdict = classify(row.stored, row);
      fs.appendFileSync(out, JSON.stringify(row) + '\n');
      if (++n % 25 === 0) console.log(`  ${n}/${queue.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  report(out);
}

module.exports = { classify, readSignals, sameArticle };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
