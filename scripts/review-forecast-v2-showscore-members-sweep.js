#!/usr/bin/env node
/**
 * review-forecast-v2-showscore-members-sweep.js (BRO-7347): rebuild a show's PRE-OPENING Show Score
 * from the dated member reviews its live page still lists. Show Score pages paginate member reviews
 * newest first (?page=N, about 8 per page); each carries datePublished and a 0-100 ratingValue.
 * We bisect to the page where dates cross opening night, read the pages from there to the oldest, and
 * keep ONLY reviews dated strictly before opening night. Stored: counts, mean and spread, no names or text.
 *
 * Every request goes through fetchPage() with { directOnly: true } (free, no paid tier): 0 paid fetches.
 * Usage: node scripts/review-forecast-v2-showscore-members-sweep.js --ids=a,b,c | --ids-from=<backtest.json> [--limit=N] [--max-pages-per-show=80]
 * Output (checkpointed per show, resumable): data/audit/review-forecast-v2-showscore-members.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/scraper');

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const OUT = arg('out', path.join(ROOT, 'data/audit/review-forecast-v2-showscore-members.json'));
const MAX_PAGES = +arg('max-pages-per-show', 80);
const LIMIT = +arg('limit', 100000);
const GAP_MS = +arg('gap-ms', 1000);
const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
const urls = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/show-score-urls.json'), 'utf8')).shows;
const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
let ids = arg('ids', null) ? arg('ids').split(',') : null;
if (!ids) { const f = arg('ids-from', null); if (!f) { console.error('--ids or --ids-from required'); process.exit(2); } ids = [...new Set(JSON.parse(fs.readFileSync(f, 'utf8')).predictionsWalkForward.map((p) => p.id))]; }
const SHARD = (arg('shard', '0/1')).split('/').map(Number);
ids = ids.filter((_, i) => i % SHARD[1] === SHARD[0]).slice(0, LIMIT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

/** member reviews on one page: [{date:'YYYY-MM-DD', rating}] (empty when the page is past the end). */
function parseMembers(html) {
  const out = [];
  const re = /"datePublished":"(\d{4}-\d{2}-\d{2})T[^"]*","reviewRating":\{[^}]*?"ratingValue":(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(html))) out.push({ date: m[1], rating: +m[2] });
  return out;
}
async function page(base, p) {
  await sleep(GAP_MS); requests += 1;
  try { const r = await fetchPage(p === 1 ? base : `${base}?page=${p}`, { directOnly: true, skipVerify: true }); return parseMembers(r.content || ''); } catch (e) { if (/404/.test(e.message)) return []; if (/40[13]|429|captcha|challenge/i.test(e.message)) { e.stop = true; } throw e; }
}

async function sweepShow(id) {
  const s = byId[id]; const base = urls[id];
  if (!s || !base) return { reason: 'no show or no Show Score url' };
  const open = s.openingDate;
  const cache = new Map(); const get = async (p) => { if (!cache.has(p)) cache.set(p, await page(base, p)); return cache.get(p); };
  // last non-empty page (exponential, then bisect)
  let hi = 1; while ((await get(hi)).length && hi < 4096) hi *= 2;
  let lo = hi / 2; if (hi === 1) return { reason: 'no member reviews listed' };
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if ((await get(mid)).length) lo = mid; else hi = mid; }
  const last = lo;
  // first page whose NEWEST review is before opening
  let a = 1; let b = last + 1;
  while (a < b) { const mid = Math.floor((a + b) / 2); const d = await get(mid); if (d.length && d[0].date < open) b = mid; else a = mid + 1; }
  const first = Math.max(1, a - 1); // the straddling page
  const pre = []; let newest = null; let pages = 0; let capped = false;
  for (let p = first; p <= last; p++) {
    if (pages >= MAX_PAGES) { capped = true; break; }
    pages += 1;
    for (const r of await get(p)) if (r.date < open) { pre.push(r.rating); if (!newest || r.date > newest) newest = r.date; }
  }
  const mean = pre.length ? pre.reduce((x, y) => x + y, 0) / pre.length : null;
  const sd = pre.length > 1 ? Math.sqrt(pre.reduce((x, y) => x + (y - mean) ** 2, 0) / (pre.length - 1)) : null;
  return { opening: open, lastPage: last, preOpeningCount: pre.length, newestPreOpeningReview: newest, preOpeningMean: mean == null ? null : Math.round(mean * 10) / 10, preOpeningSd: sd == null ? null : Math.round(sd * 10) / 10, pagesRead: pages, capped };
}

const state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { card: 'BRO-7347', note: 'Pre-opening Show Score member reviews (dates and ratings only) rebuilt from live paginated pages. Free direct fetches. No names or text stored.', paidFetches: 0, shows: {} };
const save = () => fs.writeFileSync(OUT, JSON.stringify({ ...state, directRequestsTotal: (state.directRequestsTotal || 0) }, null, 1));
(async () => {
  let n = 0;
  for (const id of ids) {
    if (state.shows[id]) continue;
    try { state.shows[id] = await sweepShow(id); } catch (e) { if (e.stop) { console.error(`bot wall or rate limit (${String(e.message).slice(0, 80)}): stopping, no bypass`); save(); process.exit(3); } state.shows[id] = { error: String(e.message).slice(0, 100) }; }
    state.directRequestsTotal = (state.directRequestsTotal || 0) + requests; requests = 0;
    n += 1; save();
    if (n % 5 === 0) console.error(`${n} shows, direct requests ${state.directRequestsTotal}`);
  }
  save();
  const v = Object.entries(state.shows);
  console.log(JSON.stringify({ shows: v.length, withPreOpening5plus: v.filter(([, x]) => x.preOpeningCount >= 5).length, directRequests: state.directRequestsTotal, paidFetches: 0 }));
  for (const [id, x] of v.slice(-12)) console.log(id, JSON.stringify(x));
})().catch((e) => { console.error(e); save(); process.exit(1); });
