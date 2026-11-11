#!/usr/bin/env node
/**
 * review-forecast-v2-earlier-audience-sweep.js (BRO-7369): for each Broadway opening, find Show Score
 * MEMBER ratings of an EARLIER production (a separate Off-Broadway page) that are dated before the Broadway
 * first preview. Research only; writes aggregates (counts, mean, share at or below 60, newest/oldest date),
 * never names or text. Ratings an earlier run left on a page the Broadway run shares are taken from the
 * BRO-7347 member pull (data/audit/review-forecast-v2-showscore-members.json), with no new request.
 *
 * Rules (card BRO-7369): one worker, at most 1 request per second (the gap is floored at 1000 ms),
 * robots.txt respected (only /off-broadway-shows/<slug> and ?page=N, neither disallowed), fetchPage with
 * { directOnly: true } (free tier, 0 paid fetches), stop at the first 403, 429 or captcha, no bypass.
 *
 * Usage: node scripts/review-forecast-v2-earlier-audience-sweep.js --ids=a,b,c | --ids-from=<backtest.json>
 *          [--limit=N] [--max-pages-per-source=20] [--no-guess] [--plan]
 *   --plan   print each show's candidate pages and make no request
 * Output (checkpointed per show, resumable): data/audit/review-forecast-v2-earlier-audience.json
 */
'use strict';
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const EA = require('./lib/review-forecast-v2-earlier-audience.js');
const RF = require('./lib/review-forecast.js');

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const OUT = arg('out', path.join(ROOT, 'data/audit/review-forecast-v2-earlier-audience.json'));
const MAX_PAGES = +arg('max-pages-per-source', 20);
const LIMIT = +arg('limit', 100000);
const GAP_MS = Math.max(1000, +arg('gap-ms', 1100)); // the card's ceiling is 1 request per second: never go below
const PLAN = flag('plan');
const GUESS = !flag('no-guess');
const PER_PAGE_GUESS = 8;

const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const shows = J('data/shows.json').shows;
const urls = J('data/show-score-urls.json').shows;
const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
const memRaw = fs.existsSync(path.join(ROOT, 'data/audit/review-forecast-v2-showscore-members.json')) ? J('data/audit/review-forecast-v2-showscore-members.json').shows : {};

let ids = arg('ids', null) ? arg('ids').split(',') : null;
if (!ids) { const f = arg('ids-from', null); if (!f) { console.error('--ids or --ids-from required'); process.exit(2); } ids = [...new Set(JSON.parse(fs.readFileSync(f, 'utf8')).predictionsWalkForward.map((p) => p.id))]; }
ids = ids.slice(0, LIMIT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (t) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const OFF = 'https://www.show-score.com/off-broadway-shows/';

/** Candidate separate pages for a Broadway show: mapped earlier non-Broadway productions, then guessed Off-Broadway slugs. */
function candidates(s) {
  const k = RF.titleKey(s.title); const out = []; const seen = new Set([urls[s.id]].filter(Boolean));
  const add = (url, kind, ref) => { if (url && !seen.has(url)) { seen.add(url); out.push({ url, kind, ref }); } };
  for (const q of shows) {
    if (q.id === s.id || q.category === 'broadway' || !q.openingDate || q.openingDate >= s.openingDate || RF.titleKey(q.title) !== k) continue;
    if (urls[q.id]) add(urls[q.id], 'mapped', q.id);
  }
  if (GUESS) { const sl = slugify(s.title); add(OFF + sl, 'guess', null); if (/^the-/.test(sl)) add(OFF + sl.slice(4), 'guess', null); }
  return out;
}

let fetchPage = null; let requests = 0;
async function getHtml(u) {
  await sleep(GAP_MS); requests += 1;
  try {
    const r = await fetchPage(u, { directOnly: true, skipVerify: true });
    const c = r.content || '';
    if (/captcha|are you a robot|cf-challenge|just a moment\.\.\./i.test(c.slice(0, 20000)) && !/"aggregateRating"/.test(c)) { const e = new Error('captcha or bot wall'); e.stop = true; throw e; }
    return c;
  } catch (e) {
    if (/404|not found/i.test(e.message)) return null;
    if (/40[13]|429|captcha|challenge|bot wall|blocked/i.test(e.message)) e.stop = true;
    throw e;
  }
}
const pageName = EA.pageName;

async function sweepSource(s, c, cutoff) {
  const h1 = await getHtml(c.url);
  if (h1 == null) return { ...c, reason: 'page not found' };
  const name = pageName(h1);
  const verified = !!name && (RF.titleKey(name) === RF.titleKey(s.title) || RF.titleKey(name.replace(/^the\s+/i, '')) === RF.titleKey(s.title.replace(/^the\s+/i, '')));
  if (!verified) return { ...c, verified: false, pageName: name, reason: 'page title does not match the show' };
  const p1 = EA.parseMembers(h1);
  const total = (/"aggregateRating":\{[^}]*?"reviewCount":(\d+)/.exec(h1) || [])[1];
  if (!p1.length) return { ...c, verified: true, reason: 'no member reviews listed', listed: total ? +total : null };
  const cache = new Map([[1, p1]]);
  const get = async (p) => { if (!cache.has(p)) { const h = await getHtml(`${c.url}?page=${p}`); cache.set(p, h == null ? [] : EA.parseMembers(h)); } return cache.get(p); };
  const est = Math.max(2, Math.ceil((total ? +total : 0) / PER_PAGE_GUESS));
  let lo = 1; let hi;
  if ((await get(est)).length) { lo = est; hi = est * 2; while ((await get(hi)).length) { lo = hi; hi *= 2; if (hi > 400) break; } } else hi = est;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((await get(mid)).length) lo = mid; else hi = mid; }
  const kept = []; let pages = 0; let capped = false; let reachedCutoff = false;
  for (let pg = lo; pg >= 1; pg--) { // oldest page first: the earlier run sits at the end of the list
    if (pages >= MAX_PAGES) { capped = true; break; }
    pages += 1;
    const rows = await get(pg);
    for (const r of rows) if (r.date <= cutoff) kept.push(r);
    if (rows.some((r) => r.date > cutoff)) { reachedCutoff = true; break; }
  }
  return { ...c, verified: true, listed: total ? +total : null, lastPage: lo, pagesRead: pages, capped, reachedCutoff, ...EA.summarize(kept, cutoff) };
}

async function sweepShow(id) {
  const s = byId[id];
  if (!s) return { reason: 'no such show' };
  const cutoff = EA.earlierCutoff(s);
  const sources = [];
  const m = memRaw[id]; // earlier-run ratings on the page the Broadway run shares (BRO-7347 pull; 14-day slack before the first preview)
  if (m && m.earlierRunN > 0) sources.push({ kind: 'shared-page', url: urls[id] || null, verified: true, n: m.earlierRunN, mean: m.earlierRunMean, newest: m.earlierRunNewest, shareLe60: null });
  for (const c of candidates(s)) {
    const r = await sweepSource(s, c, cutoff);
    // a guessed Off-Broadway slug can redirect to the very page the Broadway run shares: same n, mean and newest date means the same ratings, count them once
    const twin = sources.find((q) => q.n > 0 && q.n === r.n && q.mean === r.mean && q.newest === r.newest);
    if (twin) { r.duplicateOf = twin.url; }
    sources.push(r);
  }
  const live = sources.filter((x) => !x.duplicateOf);
  return { opening: s.openingDate, previewsStart: s.previewsStartDate || null, cutoff, sources, pooled: EA.pool(live), confirmedPooled: EA.pool(live.filter((x) => x.kind !== 'guess')) };
}

if (PLAN) {
  let withC = 0;
  for (const id of ids) { const s = byId[id]; if (!s) continue; const c = candidates(s); const sh = memRaw[id] && memRaw[id].earlierRunN > 0; if (c.length || sh) withC++; console.log(id, sh ? 'shared-page' : '', c.map((x) => `${x.kind}:${x.url.replace('https://www.show-score.com', '')}`).join(' ')); }
  console.log(`planned: ${ids.length} shows, up to ${ids.reduce((a, id) => a + (byId[id] ? candidates(byId[id]).length : 0), 0)} page-1 requests plus pagination`);
  process.exit(0);
}

const state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { card: 'BRO-7369', note: 'Earlier-production Show Score member ratings dated before the Broadway first preview. Aggregates only: no names, no text. Free direct fetches, 1 worker, at most 1 request per second.', paidFetches: 0, directRequestsTotal: 0, shows: {} };
const save = () => fs.writeFileSync(OUT, JSON.stringify(state, null, 1));
(async () => {
  ({ fetchPage } = require('./lib/scraper'));
  let n = 0; let errs = 0;
  for (const id of ids) {
    if (state.shows[id]) continue;
    try { state.shows[id] = await sweepShow(id); errs = 0; } catch (e) {
      if (e.stop) { console.error(`bot wall or rate limit (${String(e.message).slice(0, 80)}) at ${id}: stopping, no bypass`); state.directRequestsTotal += requests; save(); process.exit(3); }
      state.shows[id] = { error: String(e.message).slice(0, 160) }; errs += 1;
      if (errs >= 5) { console.error('5 consecutive errors: stopping'); state.directRequestsTotal += requests; save(); process.exit(1); }
    }
    state.directRequestsTotal += requests; requests = 0; n += 1; save();
    if (n % 10 === 0) console.error(`${n} shows, direct requests ${state.directRequestsTotal}`);
  }
  save();
  const v = Object.values(state.shows);
  console.log(JSON.stringify({ shows: v.length, withEarlierRatings: v.filter((x) => x.pooled).length, directRequests: state.directRequestsTotal, paidFetches: 0 }));
})().catch((e) => { console.error(e); save(); process.exit(1); });
