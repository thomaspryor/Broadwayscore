#!/usr/bin/env node
'use strict';
/**
 * BRO-5081 review fact-check, step 2: get the review page for each sampled row.
 * Order: live URL -> archive.org snapshot -> our stored fullText. Pages and the
 * extracted text are cached OUTSIDE the repo (copyrighted text never goes in a
 * public file): FACTCHECK_CACHE, default $TMPDIR/review-factcheck.
 *
 * Usage: node scripts/review-factcheck/fetch-pages.js [--sample=...] [--concurrency=6] [--only=WE-001,BW-002]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { extractArticleText, extractPublishDate } = require('../lib/article-extractor');
const { extractByline, extractJsonLdAuthor } = require('../lib/byline-extraction');

const ROOT = path.resolve(__dirname, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const SAMPLE = path.resolve(ROOT, args.sample || 'data/audit/review-factcheck/sample.json');
const CACHE = process.env.FACTCHECK_CACHE || path.join(os.tmpdir(), 'review-factcheck');
const CONC = Number(args.concurrency || 6);
const ARCHIVE_GAP_MS = Number(args['archive-gap-ms'] || 2500);
// --refetch=nonlive re-runs rows whose cached source is not a live page.
const REFETCH_NONLIVE = args.refetch === 'nonlive';
// web.archive.org is outside some sandboxes' egress policy (cloud sessions,
// 2026-10-11): --no-archive skips it instead of burning backoff time.
const NO_ARCHIVE = 'no-archive' in args;
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function curl(url) {
  return new Promise(resolve => {
    execFile('curl', ['-sSL', '--max-time', '40', '-A', UA, '-H', 'Accept-Language: en', '-w', '\n__HTTP__%{http_code} %{url_effective}', url],
      { maxBuffer: 30 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        const m = String(stdout || '').match(/\n__HTTP__(\d+) (\S*)$/);
        resolve({ status: m ? Number(m[1]) : 0, finalUrl: m ? m[2] : url, html: m ? stdout.slice(0, m.index) : '', error: err && !m ? String(err.message).slice(0, 200) : null });
      });
  });
}

const meta = (html, re) => { const m = html.match(re); return m ? m[1].trim() : null; };
function pageMeta(html, url) {
  return {
    title: meta(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    siteName: meta(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i) || meta(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name/i),
    metaAuthor: meta(html, /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i) || meta(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author/i),
    jsonLdAuthor: safe(() => extractJsonLdAuthor(html)),
    byline: safe(() => extractByline(html)),
    publishDate: safe(() => extractPublishDate(html, url)),
  };
}
function safe(fn) { try { const v = fn(); return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)); } catch { return null; } }
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const PAYWALL = /(subscribe to (continue|read)|already a subscriber|create a free account to continue|this article is for subscribers|sign in to continue reading|you have reached your (free )?article limit)/i;

function textOf(html, url) {
  let t = null;
  try { t = extractArticleText(html, host(url)); } catch { t = null; }
  return t || '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// archive.org answers 429 to bursts; back off and retry so a rate limit is
// never mistaken for "no snapshot".
async function archiveCurl(url) {
  for (let i = 0; i < 5; i++) {
    await sleep(ARCHIVE_GAP_MS);
    const r = await curl(url);
    if (r.status !== 429 && !/429 Too Many Requests/.test(r.html.slice(0, 300))) return r;
    await sleep(15000 * (i + 1));
  }
  return { status: 429, html: '', finalUrl: url };
}

async function wayback(url, publishDate) {
  if (NO_ARCHIVE) return null;
  const ts = String(publishDate || '').replace(/-/g, '').slice(0, 8) || '2015';
  const api = await archiveCurl(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${ts}`);
  if (api.status === 429) return { status: 429, html: '', archiveUrl: null, rateLimited: true };
  let snap = null;
  try { snap = JSON.parse(api.html).archived_snapshots.closest; } catch { snap = null; }
  if (!snap || !snap.available) return null;
  const raw = snap.url.replace(/\/web\/(\d+)\//, '/web/$1id_/');
  const r = await archiveCurl(raw);
  return r.status === 200 ? { ...r, archiveUrl: snap.url } : null;
}

async function getOne(item) {
  const outFile = path.join(CACHE, item.sampleId + '.json');
  if (fs.existsSync(outFile) && !ONLY) {
    const cached = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (!(REFETCH_NONLIVE && cached.source !== 'live' && item.url)) return cached;
  }
  const stored = item.reviewFile ? safeJson(path.join(ROOT, 'data/review-texts', item.showId, item.reviewFile)) : null;
  const rec = { sampleId: item.sampleId, url: item.url, attempts: [], source: null, sourceUrl: null, text: '', meta: null,
    // No full text stored: the aggregator excerpts are what the score was built from.
    storedText: stored ? (stored.fullText || [stored.dtliExcerpt, stored.bwwExcerpt, stored.showScoreExcerpt, stored.nycTheatreExcerpt, stored.playbillVerdictExcerpt].filter(Boolean).join('\n')) : '',
    storedTextKind: stored ? (stored.fullText ? 'fullText' : 'aggregator-excerpts') : null, storedMeta: stored ? { url: stored.url, publishDate: stored.publishDate, criticName: stored.criticName, outlet: stored.outlet, originalScore: stored.originalScore, archiveOrgUrl: stored.archiveOrgUrl || null, source: stored.source || null } : null };
  if (item.url) {
    const live = await curl(item.url);
    const t = live.status === 200 ? textOf(live.html, live.finalUrl) : '';
    rec.attempts.push({ kind: 'live', status: live.status, finalUrl: live.finalUrl, textLen: t.length, paywall: PAYWALL.test(live.html.slice(0, 400000)) });
    if (live.status === 200 && t.length >= 1200) {
      Object.assign(rec, { source: 'live', sourceUrl: live.finalUrl, text: t, meta: pageMeta(live.html, live.finalUrl) });
    } else {
      const wb = await wayback(item.url, item.publishDate);
      const wt = wb ? textOf(wb.html, item.url) : '';
      rec.attempts.push({ kind: 'archive', status: wb ? wb.status : null, archiveUrl: wb ? wb.archiveUrl : null, textLen: wt.length });
      if (wb && wb.archiveUrl && wt.length >= 1200) Object.assign(rec, { source: 'archive.org', sourceUrl: wb.archiveUrl, text: wt, meta: pageMeta(wb.html, item.url) });
      else if (live.status === 200 && t.length >= 400) Object.assign(rec, { source: 'live-short', sourceUrl: live.finalUrl, text: t, meta: pageMeta(live.html, live.finalUrl) });
    }
  }
  if (!rec.source && rec.storedTextKind === 'aggregator-excerpts' && rec.storedText.length > 0) Object.assign(rec, { source: 'stored-excerpts', sourceUrl: item.url || null, text: rec.storedText });
  if (!rec.source && rec.storedText.length >= 300) Object.assign(rec, { source: 'stored-fulltext', sourceUrl: rec.storedMeta.archiveOrgUrl || item.url || null, text: rec.storedText });
  if (!rec.source) rec.source = 'none';
  fs.writeFileSync(outFile, JSON.stringify(rec));
  return rec;
}
function safeJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).sample.filter(s => !ONLY || ONLY.has(s.sampleId));
  const queue = [...sample];
  const results = [];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const it = queue.shift();
      const r = await getOne(it);
      results.push(r);
      process.stderr.write(`${it.sampleId} ${r.source} ${r.text.length}\n`);
    }
  }));
  const bySource = {};
  for (const r of results) bySource[r.source] = (bySource[r.source] || 0) + 1;
  console.log(JSON.stringify({ cache: CACHE, total: results.length, bySource }, null, 2));
}
if (require.main === module) main();
