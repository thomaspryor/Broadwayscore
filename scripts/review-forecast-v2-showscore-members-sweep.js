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
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage: node scripts/review-forecast-v2-showscore-members-sweep.js --ids-from=<json> [--limit=N] (BRO-7347 research sweep; writes data/audit/review-forecast-v2-showscore-members.json)'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/scraper');

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const OUT = arg('out', path.join(ROOT, 'data/audit/review-forecast-v2-showscore-members.json'));
const MAX_PAGES = +arg('max-pages-per-show', 12);
const LIMIT = +arg('limit', 100000);
const GAP_MS = +arg('gap-ms', 1100);
const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
const urls = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/show-score-urls.json'), 'utf8')).shows;
const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
let ids = arg('ids', null) ? arg('ids').split(',') : null;
if (!ids) { const f = arg('ids-from', null); if (!f) { console.error('--ids or --ids-from required'); process.exit(2); } ids = [...new Set(JSON.parse(fs.readFileSync(f, 'utf8')).predictionsWalkForward.map((p) => p.id))]; }
const SHARD = (arg('shard', '0/1')).split('/').map(Number);
ids = ids.filter((_, i) => i % SHARD[1] === SHARD[0]).slice(0, LIMIT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
const hints = {}; // page-1 listed review count per show url, used only to guess the last page

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
  try { const r = await fetchPage(p === 1 ? base : `${base}?page=${p}`, { directOnly: true, skipVerify: true }); if (p === 1) { const m = /"aggregateRating":\{[^}]*?"reviewCount":(\d+)/.exec(r.content || ''); if (m) hints[base] = +m[1]; } return parseMembers(r.content || ''); } catch (e) { if (/404/.test(e.message)) return []; if (/40[13]|429|captcha|challenge/i.test(e.message)) { e.stop = true; } throw e; }
}

const LAG = 3; // days, same lag the model uses: only reviews dated on or before opening minus LAG count
const PER_PAGE_GUESS = 8;
const PREVIEW_SLACK = 14; // days before the Broadway first preview
const median = (v) => { const s = [...v].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const avg = (v) => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const addDays = (iso, d) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

/** Walk from the END of the list (oldest reviews first), stepping back toward newer pages until dates pass the cutoff. */
async function sweepShow(id) {
  const s = byId[id]; const base = urls[id];
  if (!s || !base) return { reason: 'no show or no Show Score url' };
  const cutoff = addDays(s.openingDate, -LAG);
  const cache = new Map(); const get = async (p) => { if (!cache.has(p)) cache.set(p, await page(base, p)); return cache.get(p); };
  const p1 = await get(1);
  if (!p1.length) return { reason: 'no member reviews listed' };
  // last page: estimate from the listed review count, then confirm with at most a few probes
  // binary probe: lo = a page known non-empty, hi = a page known empty; start at the estimate, double to bracket, then bisect
  const est = Math.max(2, Math.ceil((hints[base] || 0) / PER_PAGE_GUESS));
  let lo = 1; let hi = null;
  if ((await get(est)).length) { lo = est; hi = est * 2; while ((await get(hi)).length) { lo = hi; hi *= 2; if (hi > 400) break; } } else hi = est;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((await get(mid)).length) lo = mid; else hi = mid; }
  const last = lo;
  const previewFloor = s.previewsStartDate ? addDays(s.previewsStartDate, -PREVIEW_SLACK) : null; // member reviews older than this are an earlier run on a shared page
  const kept = []; const earlier = []; let pages = 0; let capped = false; let reachedCutoff = false;
  for (let pg = last; pg >= 1; pg--) {
    if (pages >= MAX_PAGES) { capped = true; break; }
    pages += 1;
    const rows = await get(pg);
    const older = rows.filter((r) => r.date <= cutoff);
    for (const r of older) (previewFloor && r.date < previewFloor ? earlier : kept).push(r);
    if (older.length < rows.length) { reachedCutoff = true; break; } // page holds reviews past the cutoff: nothing newer is needed
  }
  kept.sort((x, y) => (x.date < y.date ? -1 : 1));
  const rt = kept.map((r) => r.rating);
  const first20 = rt.slice(0, 20); const rest = rt.slice(20);
  const days = kept.length ? Math.round((new Date(kept[kept.length - 1].date) - new Date(kept[0].date)) / 864e5) : null;
  return {
    opening: s.openingDate, cutoff, previewsStart: s.previewsStartDate || null, gapNewestToCutoffDays: kept.length ? Math.round((new Date(cutoff) - new Date(kept[kept.length - 1].date)) / 864e5) : null,
    earlierRunN: earlier.length, earlierRunMean: r1(avg(earlier.map((r) => r.rating))), earlierRunNewest: earlier.length ? earlier.map((r) => r.date).sort().pop() : null, lastPage: last, n: rt.length, newest: kept.length ? kept[kept.length - 1].date : null, oldest: kept.length ? kept[0].date : null,
    mean: r1(avg(rt)), median: r1(median(rt)), shareGe90: rt.length ? r1(rt.filter((x) => x >= 90).length / rt.length) : null, shareLe60: rt.length ? r1(rt.filter((x) => x <= 60).length / rt.length) : null,
    meanFirst20: r1(avg(first20)), meanRest: rest.length ? r1(avg(rest)) : null, daysCovered: days, pagesRead: pages, capped, reachedCutoff,
  };
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
  console.log(JSON.stringify({ shows: v.length, withPreOpening5plus: v.filter(([, x]) => x.n >= 5).length, directRequests: state.directRequestsTotal, paidFetches: 0 }));
  for (const [id, x] of v.slice(-12)) console.log(id, JSON.stringify(x));
})().catch((e) => { console.error(e); save(); process.exit(1); });
