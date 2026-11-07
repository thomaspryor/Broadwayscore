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
 *          [--recheck=<verdict>] [--fetcher=curl|fetchpage] [--time-budget-min=N] [--retry-fetched]
 *   -> $FACTCHECK_CACHE/web-search-bylines.json
 *
 * BRO-5090: --fetcher=fetchpage reads pages through scripts/lib/scraper.js
 * fetchPage (Bright Data / ScrapingBee / Scrapingdog, CI secrets) instead of
 * plain curl, for the paywalled hosts (NYT, WSJ, WaPo) that refuse curl.
 * With --recheck, --limit caps how many of the rechecked rows are fetched
 * this run; rows not fetched keep their previous entry.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { extractByline, extractJsonLdAuthor } = require('../lib/byline-extraction');
const { foldDiacritics } = require('../lib/title-match');
const { extractPublishDate } = require('../lib/article-extractor');

const ROOT = path.resolve(__dirname, '..', '..');
/** --k=v -> {k: 'v'}; a bare --flag -> {flag: true} (it used to parse as undefined). Pure. */
function parseArgs(argv) {
  return Object.fromEntries(argv.map(a => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  }));
}
const args = parseArgs(process.argv.slice(2));
const CACHE = process.env.FACTCHECK_CACHE || path.join(os.tmpdir(), 'review-factcheck');
const CONC = Number(args.concurrency || 8);
const LIMIT = Number(args.limit || 0);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const TIME_BUDGET_MS = Number(args['time-budget-min'] || 0) * 60e3;

const curl = url => new Promise(res => execFile('curl', ['-sSL', '--max-time', '30', '-A', UA, '-w', '\n__HTTP__%{http_code}', url], { maxBuffer: 30 << 20, encoding: 'utf8' }, (e, out) => {
  const m = String(out || '').match(/\n__HTTP__(\d+)$/);
  res({ status: m ? Number(m[1]) : 0, html: m ? out.slice(0, m.index) : '' });
}));

/**
 * fetchPage as a curl-shaped result. A throw (every tier missed) is
 * unreachable (status 0); non-HTML formats keep status 200 but carry no meta
 * tags, so their byline reads 'unknown'.
 */
async function viaFetchPage(url) {
  const { fetchPage } = require('../lib/scraper');
  try {
    const r = await fetchPage(url);
    const html = String((r && r.content) || '');
    // A challenge/soft-404 shell is not the page: count it as unreachable.
    let garbage = false;
    try { garbage = !!require('../lib/scraper').isChallengeOrGarbage(html); } catch { garbage = false; }
    if (garbage) return { status: 0, html: '', fetchedVia: 'fetchPage-challenge' };
    return html.trim() ? { status: 200, html, fetchedVia: r.source || 'fetchPage', format: r.format || null } : { status: 0, html: '', fetchedVia: 'fetchPage-empty' };
  } catch (e) {
    // Every tier missed. Ask the site itself: a 404/410 means the stored url
    // does not exist (BRO-5090: 95 Washington Post urls the web-search step
    // invented, e.g. a GUID ending ...2a1b3c4d5e6f), not that we were blocked.
    const direct = await directStatus(url);
    return { status: isDeadStatus(direct) ? direct : 0, html: '', fetchedVia: 'fetchPage-failed', directStatus: direct, error: String(e && e.message || e).slice(0, 120) };
  }
}

/** HTTP status the site returns to a plain GET (redirects followed), or 0. */
async function directStatus(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    return res.status;
  } catch { return 0; }
}

/** 404/410 from the site: the page does not exist. Pure. */
function isDeadStatus(status) {
  return status === 404 || status === 410;
}

/** Verdict for a page we could not read: 'dead-url' (site says no such page) or 'unreachable'. Pure. */
function unreadVerdict(status) {
  return isDeadStatus(status) ? 'dead-url' : 'unreachable';
}

/**
 * Merge a recheck pass into the previous results. Rows fetched this run
 * replace their old entry; rows not fetched keep it, except a rechecked row
 * that no longer counts on the site (renamed, excluded, deleted), which is
 * marked 'not-live' so it stops reading as unreachable. Pure.
 * @param {object[]} prev previous web-search-bylines.json rows
 * @param {object[]} fetched rows produced this run
 * @param {Set<string>} liveKeys showId/file keys of current live web-search rows
 * @param {string} recheck the verdict being rechecked
 */
function mergeRecheck(prev, fetched, liveKeys, recheck) {
  const k = r => r.showId + '/' + r.file;
  const done = new Map(fetched.map(r => [k(r), r]));
  return prev.map(p => {
    if (done.has(k(p))) return done.get(k(p));
    if (p.verdict === recheck && !liveKeys.has(k(p))) return { ...p, verdict: 'not-live', dateVerdict: 'n/a' };
    return p;
  });
}

/** Did a fetchPage pass already try this row (failed, or read and still undecided)? Pure. */
function alreadyTriedByFetchPage(row) {
  const via = String(row && row.fetchedVia || '');
  return via !== '' && via !== 'curl';
}

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
  if (['off-topic-page', 'unreachable', 'dead-url'].includes(bylineVerdict)) return 'n/a';
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
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.json')) continue; try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); files.push({ f, d: { outletId: j.outletId, criticName: j.criticName, source: j.source, url: j.url, duplicateOf: j.duplicateOf, publishDate: j.publishDate, textLen: String(j.fullText || '').trim().length, contentTier: j.contentTier || null } }); } catch { /* skip */ } }
      dirCache.set(r.showId, files);
    }
    const files = dirCache.get(r.showId);
    const own = files.find(x => x.d.outletId === r.outletId && x.d.criticName === r.criticName && !x.d.duplicateOf) || files.find(x => x.d.outletId === r.outletId && x.d.criticName === r.criticName);
    if (!own || own.d.source !== 'web-search') continue;
    const siblings = files.filter(x => x !== own && x.d.url && x.d.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') === r.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')).map(x => ({ file: x.f, criticName: x.d.criticName, source: x.d.source, duplicateOf: x.d.duplicateOf || null }));
    rows.push({ showId: r.showId, showTitle: (showTitles.get(r.showId) || ''), openingDate: showOpen.get(r.showId) || null, publishDate: own.d.publishDate || null, file: own.f, outletId: r.outletId, criticName: r.criticName, url: r.url, score: r.assignedScore, textLen: own.d.textLen, contentTier: own.d.contentTier, siblings });
  }
  // --recheck=<verdict> re-fetches only rows a previous run gave that verdict.
  let todo = LIMIT ? rows.slice(0, LIMIT) : rows;
  let prev = null;
  if (args.recheck) {
    prev = JSON.parse(fs.readFileSync(path.join(CACHE, 'web-search-bylines.json'), 'utf8'));
    // A row fetchPage already failed on stays 'unreachable'; without this the
    // next run would spend its limit/time budget on the same hard failures
    // first and never reach the untried rows. --retry-fetched re-tries them.
    const keep = new Set(prev.filter(p => p.verdict === args.recheck && (args['retry-fetched'] || !alreadyTriedByFetchPage(p))).map(p => p.showId + '/' + p.file));
    todo = rows.filter(r => keep.has(r.showId + '/' + r.file));
    if (LIMIT) todo = todo.slice(0, LIMIT);
  }
  const fetcher = args.fetcher === 'fetchpage' ? viaFetchPage : curl;
  const started = Date.now();
  const fetched = [];
  // Checkpoint every 50 fetched rows so a crash late in a run keeps what it paid for.
  const liveKeys = new Set(rows.map(r => r.showId + '/' + r.file));
  const save = () => fs.writeFileSync(path.join(CACHE, 'web-search-bylines.json'), JSON.stringify(prev ? mergeRecheck(prev, fetched, liveKeys, args.recheck) : fetched, null, 1));
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < todo.length) {
      if (TIME_BUDGET_MS && Date.now() - started > TIME_BUDGET_MS) return;
      const row = todo[i++];
      const r = await fetcher(row.url);
      const bylines = r.status === 200 ? pageBylines(r.html) : [];
      let verdict = r.status === 200 ? compareByline(row.criticName, bylines) : unreadVerdict(r.status);
      const title = r.status === 200 ? ((r.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim() : '';
      // A byline only counts if the page is about this show: a stored URL that
      // now serves another article (THR American Buffalo -> a Met Ball piece)
      // would otherwise "correct" the critic to that article's author.
      if (verdict === 'different' && !pageIsAboutShow(title, row.url, row.showTitle)) verdict = 'off-topic-page';
      const sib = verdict === 'different' ? row.siblings.find(s => compareByline(s.criticName, bylines) === 'match') : null;
      let pageDate = null;
      try { pageDate = r.status === 200 ? extractPublishDate(r.html, row.url) : null; } catch { pageDate = null; }
      fetched.push({ ...row, status: r.status, fetchedVia: r.fetchedVia || 'curl', bylines, verdict, siblingWithPageCritic: sib || null, pageDate, pageTitle: title.slice(0, 160),
        dateVerdict: judgeDate(row.publishDate, pageDate, row.openingDate, verdict) });
      if (fetched.length % 50 === 0) save();
    }
  }));
  const merged = prev ? mergeRecheck(prev, fetched, liveKeys, args.recheck) : fetched;
  // Refresh the stored-text fields on every row (old curl-pass rows predate
  // them), so the text-collection target list reads the files as they are now.
  const byKey = new Map(rows.map(r => [r.showId + '/' + r.file, r]));
  const out = merged.map(o => { const cur = byKey.get(o.showId + '/' + o.file); return cur ? { ...o, textLen: cur.textLen, contentTier: cur.contentTier } : o; });
  fs.writeFileSync(path.join(CACHE, 'web-search-bylines.json'), JSON.stringify(out, null, 1));
  const tally = {};
  for (const o of out) tally[o.verdict] = (tally[o.verdict] || 0) + 1;
  const dates = {};
  for (const o of out) dates[o.dateVerdict] = (dates[o.dateVerdict] || 0) + 1;
  const fetchedTally = {};
  for (const o of fetched) fetchedTally[o.verdict] = (fetchedTally[o.verdict] || 0) + 1;
  let spend = null;
  if (args.fetcher === 'fetchpage') { try { spend = require('../lib/scraper').getScraperStats(); } catch { spend = null; } }
  console.log(JSON.stringify({ rows: out.length, fetched: fetched.length, queued: todo.length, fetchedTally, tally, dates, differentWithSibling: out.filter(o => o.siblingWithPageCritic).length, spend }));
  if (args.fetcher === 'fetchpage') { try { await require('../lib/scraper').cleanup(); } catch { /* best effort */ } }
}
if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
module.exports = { pageBylines, compareByline, normName, pageIsAboutShow, judgeDate, mergeRecheck, alreadyTriedByFetchPage, unreadVerdict, parseArgs };
