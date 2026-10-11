#!/usr/bin/env node
'use strict';
/**
 * BRO-5081 class sweep (critic byline): every review that counts on the live
 * site and whose file was CREATED by the legacy LLM web-search step (source
 * 'web-search', Feb 2026 backfill). That step invents bylines: 6 of 38 sampled
 * rows named the wrong critic, vs 6 of 262 for every other source. For each
 * row with a URL, fetch the page and read the byline from page metadata
 * (JSON-LD author, meta author, byline markup). Prints rows whose page names a
 * different critic, plus which sibling file (if any) already carries the
 * page's critic for the same URL.
 *
 * Usage: node scripts/review-factcheck/sweep-web-search-bylines.js [--concurrency=8] [--limit=N]
 *   -> $FACTCHECK_CACHE/web-search-bylines.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { extractByline, extractJsonLdAuthor } = require('../lib/byline-extraction');
const { foldDiacritics } = require('../lib/title-match');
const { extractPublishDate } = require('../lib/article-extractor');

const ROOT = path.resolve(__dirname, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const CACHE = process.env.FACTCHECK_CACHE || path.join(os.tmpdir(), 'review-factcheck');
const CONC = Number(args.concurrency || 8);
const LIMIT = Number(args.limit || 0);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const curl = url => new Promise(res => execFile('curl', ['-sSL', '--max-time', '30', '-A', UA, '-w', '\n__HTTP__%{http_code}', url], { maxBuffer: 30 << 20, encoding: 'utf8' }, (e, out) => {
  const m = String(out || '').match(/\n__HTTP__(\d+)$/);
  res({ status: m ? Number(m[1]) : 0, html: m ? out.slice(0, m.index) : '' });
}));

const normName = s => foldDiacritics(String(s || '')).toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Page bylines from metadata only (never body prose). Pure. */
function pageBylines(html) {
  const out = [];
  const add = v => { if (v && typeof v === 'string' && v.length < 120) out.push(v.trim()); };
  try { add(extractJsonLdAuthor(html)); } catch { /* malformed JSON-LD */ }
  const meta = (html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author/i) || [])[1];
  add(meta);
  const parsely = (html.match(/<meta[^>]+name=["']parsely-author["'][^>]+content=["']([^"']+)/i) || [])[1];
  add(parsely);
  try { add(extractByline(html)); } catch { /* no byline markup */ }
  return [...new Set(out)];
}

/** 'match' | 'different' | 'unknown' for our critic vs the page bylines. Pure. */
function compareByline(ours, bylines) {
  const o = normName(ours);
  if (!o || !bylines.length) return 'unknown';
  const toks = o.split(' ');
  const surname = toks[toks.length - 1];
  const names = bylines.map(normName).filter(b => b && b.split(' ').length >= 2 && !/staff|editor|team|admin|contributor|reporter|news|desk/.test(b));
  if (!names.length) return 'unknown';
  if (names.some(b => b.includes(o) || (surname.length > 2 && b.split(' ').includes(surname)))) return 'match';
  return 'different';
}

/**
 * Our date vs the page's. 'wrong' only when the page date is near the show's
 * opening (within 45 days) and ours is more than 7 days from it: a page date
 * far from opening is usually a CMS migration stamp (Vulture 2018, NY Daily
 * News 2015), never evidence. Pure.
 */
function judgeDate(ours, pageDate, openingDate, bylineVerdict) {
  if (bylineVerdict === 'off-topic-page' || bylineVerdict === 'unreachable') return 'n/a';
  const p = Date.parse(String(pageDate || '').slice(0, 10));
  const o = Date.parse(String(ours || ''));
  const open = Date.parse(String(openingDate || ''));
  if (!Number.isFinite(p) || !Number.isFinite(open)) return 'unknown';
  if (Math.abs(p - open) > 45 * 864e5) return 'unknown';
  if (!Number.isFinite(o)) return 'missing';
  return Math.abs(p - o) > 7 * 864e5 ? 'wrong' : 'ok';
}

/** Does the page title or URL slug name the show? Pure. */
function pageIsAboutShow(title, url, showTitle) {
  const words = normName(showTitle).split(' ').filter(w => w.length >= 3 && !['the', 'and'].includes(w));
  if (!words.length) return true;
  const hay = normName(title) + ' ' + normName(String(url || '').replace(/[-_/]+/g, ' '));
  return words.filter(w => hay.includes(w)).length >= Math.ceil(words.length / 2);
}

async function main() {
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8')).reviews;
  const showsArr = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
  const showTitles = new Map(showsArr.map(s => [s.id, s.title]));
  const showOpen = new Map(showsArr.map(s => [s.id, s.openingDate]));
  const rows = [];
  const dirCache = new Map();
  for (const r of reviews) {
    if (!r.url) continue;
    const dir = path.join(ROOT, 'data/review-texts', r.showId);
    if (!dirCache.has(r.showId)) {
      const files = [];
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.json')) continue; try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); files.push({ f, d: { outletId: j.outletId, criticName: j.criticName, source: j.source, url: j.url, duplicateOf: j.duplicateOf, publishDate: j.publishDate } }); } catch { /* skip */ } }
      dirCache.set(r.showId, files);
    }
    const files = dirCache.get(r.showId);
    const own = files.find(x => x.d.outletId === r.outletId && x.d.criticName === r.criticName && !x.d.duplicateOf) || files.find(x => x.d.outletId === r.outletId && x.d.criticName === r.criticName);
    if (!own || own.d.source !== 'web-search') continue;
    const siblings = files.filter(x => x !== own && x.d.url && x.d.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') === r.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')).map(x => ({ file: x.f, criticName: x.d.criticName, source: x.d.source, duplicateOf: x.d.duplicateOf || null }));
    rows.push({ showId: r.showId, showTitle: (showTitles.get(r.showId) || ''), openingDate: showOpen.get(r.showId) || null, publishDate: own.d.publishDate || null, file: own.f, outletId: r.outletId, criticName: r.criticName, url: r.url, score: r.assignedScore, siblings });
  }
  // --recheck=different re-fetches only rows a previous run called different.
  let todo = LIMIT ? rows.slice(0, LIMIT) : rows;
  if (args.recheck) {
    const prev = JSON.parse(fs.readFileSync(path.join(CACHE, 'web-search-bylines.json'), 'utf8'));
    const keep = new Set(prev.filter(p => p.verdict === args.recheck).map(p => p.showId + '/' + p.file));
    const rest = prev.filter(p => p.verdict !== args.recheck);
    todo = rows.filter(r => keep.has(r.showId + '/' + r.file));
    rows.length = 0; rest.forEach(p => rows.push(p));
  }
  const out = args.recheck ? [...rows] : [];
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < todo.length) {
      const row = todo[i++];
      const r = await curl(row.url);
      const bylines = r.status === 200 ? pageBylines(r.html) : [];
      let verdict = r.status === 200 ? compareByline(row.criticName, bylines) : 'unreachable';
      const title = r.status === 200 ? ((r.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim() : '';
      // A byline only counts if the page is about this show: a stored URL that
      // now serves another article (THR American Buffalo -> a Met Ball piece)
      // would otherwise "correct" the critic to that article's author.
      if (verdict === 'different' && !pageIsAboutShow(title, row.url, row.showTitle)) verdict = 'off-topic-page';
      const sib = verdict === 'different' ? row.siblings.find(s => compareByline(s.criticName, bylines) === 'match') : null;
      let pageDate = null;
      try { pageDate = r.status === 200 ? extractPublishDate(r.html, row.url) : null; } catch { pageDate = null; }
      out.push({ ...row, status: r.status, bylines, verdict, siblingWithPageCritic: sib || null, pageDate, pageTitle: title.slice(0, 160),
        dateVerdict: judgeDate(row.publishDate, pageDate, row.openingDate, verdict) });
    }
  }));
  fs.writeFileSync(path.join(CACHE, 'web-search-bylines.json'), JSON.stringify(out, null, 1));
  const tally = {};
  for (const o of out) tally[o.verdict] = (tally[o.verdict] || 0) + 1;
  const dates = {};
  for (const o of out) dates[o.dateVerdict] = (dates[o.dateVerdict] || 0) + 1;
  console.log(JSON.stringify({ rows: out.length, tally, dates, differentWithSibling: out.filter(o => o.siblingWithPageCritic).length }));
}
if (require.main === module) main();
module.exports = { pageBylines, compareByline, normName, pageIsAboutShow, judgeDate };
