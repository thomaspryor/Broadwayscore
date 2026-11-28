#!/usr/bin/env node
/**
 * review-forecast-london-audience.mjs (BRO-7380): London-first and out-of-town audience ratings as an input to the
 * review-score forecast RESEARCH backtest. Follow-up to BRO-7369, whose London coverage was 2 shows (only where a
 * Show Score page was already mapped) and whose out-of-town was untestable.
 *
 * Modes
 *   --summary   (default, offline) cohort counts, dated pre-Broadway audience coverage per source, and the backtest
 *               verdict if data/audit/review-forecast-inputs-v2-london-audience.json exists
 *   --plan      print each cohort show's candidate pages, no request
 *   --fetch     read the Show Score sitemaps (5 requests), then member ratings of every candidate page; checkpointed,
 *               resumable, writes data/audit/review-forecast-london-audience.json
 *   --merge     write data/audit/review-forecast-v2-earlier-audience-london.json = the BRO-7369 earlier-audience file
 *               plus these London and out-of-town sources; feed it to the backtest with
 *               node scripts/backtest-review-forecast-v2.mjs --earlier-audience=<that file> --out=data/audit/review-forecast-inputs-v2-london-audience.json
 *
 * Rules (card): fetchPage() with { directOnly: true } (free tier, no paid fetch), one worker, at most 1 request per
 * second (gap floored at 1000 ms), robots.txt respected (only sitemap-listed show pages and ?page=N), stop at the first
 * 403 / 429 / captcha, no bypass. Aggregates only (counts, mean, share at or below 60, newest and oldest date): no names,
 * no review text, no forecast values. Output stays in data/audit (not served).
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EA = require('../lib/review-forecast-v2-earlier-audience.js');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const OUT = arg('out', path.join(ROOT, 'data/audit/review-forecast-london-audience.json'));
const EA_PRIOR = path.join(ROOT, 'data/audit/review-forecast-v2-earlier-audience.json');
const MERGED = path.join(ROOT, 'data/audit/review-forecast-v2-earlier-audience-london.json');
const BACKTEST = path.join(ROOT, 'data/audit/review-forecast-inputs-v2-london-audience.json');
const SM_FILE = path.join(ROOT, 'data/audit/review-forecast-london-audience-sitemap-urls.json');
const GAP_MS = Math.max(1000, +arg('gap-ms', 1100));
const MAX_PAGES = +arg('max-pages-per-source', 40);
const PER_PAGE_GUESS = 8;
const SM_BASE = 'https://www.show-score.com/sitemap/';
const SM_CITIES = ['london', 'chicago', 'dc', 'la', 'sfo'];

const tk = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^(the|a)\s+/, '').replace(/[^a-z0-9]/g, '');
const slugKey = (u) => tk(u.split('/').pop().replace(/-/g, ' '));

// ---- cohorts -------------------------------------------------------------------------------------------------
const shows = J('data/shows.json').shows;
const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
const origins = J('data/show-origins.json').shows;
const urlsMapped = J('data/show-score-urls.json').shows;
const lbo = fs.existsSync(path.join(ROOT, 'data/audience-reviews-lbo.json')) ? J('data/audience-reviews-lbo.json') : {};
const prior = fs.existsSync(EA_PRIOR) ? J('data/audit/review-forecast-v2-earlier-audience.json') : { shows: {} };
const ids = Object.keys(prior.shows).filter((id) => byId[id] && origins[id]); // the BRO-7369 evaluated set
const isLondon = (id) => (origins[id].path || []).includes('london');
const isOOT = (id) => (origins[id].path || []).includes('regional-us');
const londonIds = ids.filter(isLondon);
const ootIds = ids.filter((i) => isOOT(i) && !isLondon(i));
const westEndByKey = new Map();
for (const s of shows) if (s.market === 'west-end') { const k = tk(s.title); if (!westEndByKey.has(k)) westEndByKey.set(k, []); westEndByKey.get(k).push(s); }
const regionalByKey = new Map();
for (const s of shows) if (s.market === 'regional') { const k = tk(s.title); if (!regionalByKey.has(k)) regionalByKey.set(k, []); regionalByKey.get(k).push(s); }
const earlierWE = (s) => (westEndByKey.get(tk(s.title)) || []).filter((w) => w.openingDate && w.openingDate < s.openingDate);

/** Dated London Box Office ratings (1-5 stars, held in data/audience-reviews-lbo.json) of an earlier West End run, scaled to 0-100, on or before the cutoff. */
function lboDated(s, cutoff) {
  const rows = [];
  for (const w of earlierWE(s)) for (const r of (lbo[w.id] && lbo[w.id].reviews) || []) if (r.date && r.date <= cutoff && r.rating >= 1 && r.rating <= 5) rows.push({ date: r.date, rating: r.rating * 20 });
  return rows;
}

// ---- inventory (offline) ---------------------------------------------------------------------------------------
function inventory() {
  const ps = {};
  const add = (src, key) => { ps[src] = ps[src] || { londonFirst: 0, outOfTown: 0 }; ps[src][key] += 1; };
  for (const id of ids) {
    const s = byId[id]; const cutoff = EA.earlierCutoff(s);
    if (isLondon(id)) {
      const we = earlierWE(s);
      if (we.length) add('own west-end record (title match, opened before Broadway)', 'londonFirst');
      if (we.some((w) => urlsMapped[w.id])) add('show score london page already mapped (BRO-7369 source)', 'londonFirst');
      if (lboDated(s, cutoff).length) add('london box office user ratings dated by cutoff (held)', 'londonFirst');
    }
    if (isOOT(id) && (regionalByKey.get(tk(s.title)) || []).some((r) => r.openingDate && r.openingDate < s.openingDate)) add('own regional record (title match, opened before Broadway); no audience field on any regional record', 'outOfTown');
  }
  return { evaluatedSet: ids.length, londonFirst: londonIds.length, londonFirstPathStartsLondon: ids.filter((id) => origins[id].path[0] === 'london').length, outOfTown: ids.filter(isOOT).length, outOfTownNotLondon: ootIds.length, heldSources: ps };
}

// ---- sitemap candidates ------------------------------------------------------------------------------------------
let sitemapUrls = null; // { london: [...], regional: [...] }
function candidatesFor(id) {
  const s = byId[id]; const k = tk(s.title); const out = []; const seen = new Set();
  const add = (url, kind) => { if (url && !seen.has(url)) { seen.add(url); out.push({ url, kind }); } };
  if (isLondon(id)) {
    for (const w of earlierWE(s)) if (urlsMapped[w.id]) add(urlsMapped[w.id], 'london-mapped');
    for (const u of (sitemapUrls && sitemapUrls.london) || []) { if (slugKey(u.replace(/-(west-end|london)$/, '')) === k) add(u, 'london-sitemap'); }
  }
  if (isOOT(id) && k.length >= 4) for (const u of (sitemapUrls && sitemapUrls.regional) || []) { if (slugKey(u).startsWith(k)) add(u, 'regional-sitemap'); }
  return out;
}

// ---- network ------------------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fetchPage = null; let requests = 0;
async function getRaw(u) {
  await sleep(GAP_MS); requests += 1;
  try {
    const r = await fetchPage(u, { directOnly: true, skipVerify: true });
    const c = r.content || '';
    if (/captcha|are you a robot|cf-challenge|just a moment\.\.\./i.test(c.slice(0, 20000)) && !/"aggregateRating"|<urlset|<sitemapindex/.test(c)) { const e = new Error('captcha or bot wall'); e.stop = true; throw e; }
    return c;
  } catch (e) {
    if (/404|not found/i.test(e.message)) return null;
    if (/40[13]|429|captcha|challenge|bot wall|blocked/i.test(e.message)) e.stop = true;
    throw e;
  }
}
const REGION = '(?:NYC|London|DC|Washington|LA|Los Angeles|Chicago|SF|San Francisco|Bay Area|Orange County|OC)';
function pageName(html) {
  const m = new RegExp(`<title>\\s*Show Score \\| (.*?)\\s*(?:\\([^)]*\\)\\s*)?${REGION}\\b`, 'i').exec(html || '');
  return m ? m[1].replace(/&amp;/g, '&').replace(/\s*\([^)]*\)\s*$/, '').trim() : null;
}
async function loadSitemaps() {
  const london = []; const regional = [];
  for (const c of SM_CITIES) {
    const x = await getRaw(`${SM_BASE}${c}.xml`);
    for (const u of (x || '').match(/<loc>[^<]+/g) || []) {
      const v = u.slice(5);
      if (c === 'london' && /\/uk\/london\/(?:west-end|off-west-end)-shows\//.test(v)) london.push(v);
      else if (c !== 'london' && /\/us\/\w+\/theatre-shows\//.test(v)) regional.push(v);
    }
  }
  sitemapUrls = { london, regional };
  fs.writeFileSync(SM_FILE, JSON.stringify({ card: 'BRO-7380', note: 'Show page URLs listed in the Show Score sitemaps (no ratings).', fetchedAt: new Date().toISOString().slice(0, 10), counts: { london: london.length, regional: regional.length }, london, regional }));
}

async function sweepSource(s, c, cutoff) {
  const h1 = await getRaw(c.url);
  if (h1 == null) return { ...c, reason: 'page not found' };
  const name = pageName(h1);
  if (!name || tk(name) !== tk(s.title)) return { ...c, verified: false, pageName: name, reason: 'page title does not match the show' };
  const p1 = EA.parseMembers(h1);
  const total = (/"aggregateRating":\{[^}]*?"reviewCount":(\d+)/.exec(h1) || [])[1];
  if (!p1.length) return { ...c, verified: true, reason: 'no dated member ratings on the page', listed: total ? +total : null };
  const cache = new Map([[1, p1]]);
  const get = async (p) => { if (!cache.has(p)) { const h = await getRaw(`${c.url}?page=${p}`); cache.set(p, h == null ? [] : EA.parseMembers(h)); } return cache.get(p); };
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
  const s = byId[id]; const cutoff = EA.earlierCutoff(s);
  const sources = [];
  for (const c of candidatesFor(id)) sources.push(await sweepSource(s, c, cutoff));
  const lb = lboDated(s, cutoff);
  if (lb.length) sources.push({ kind: 'lbo-held', verified: true, ...EA.summarize(lb, cutoff) });
  return { cohort: isLondon(id) ? 'london-first' : 'out-of-town', opening: s.openingDate, previewsStart: s.previewsStartDate || null, cutoff, sources, pooled: EA.pool(sources) };
}

// ---- modes --------------------------------------------------------------------------------------------------------------
const loadState = () => (fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { card: 'BRO-7380', note: 'London-first and out-of-town audience ratings dated before the Broadway first preview (Show Score member pages found through the Show Score sitemaps, plus held London Box Office ratings). Aggregates only: no names, no text. Free direct fetches, 1 worker, at most 1 request per second.', paidFetches: 0, directRequestsTotal: 0, sitemap: null, shows: {} });
const loadSm = () => { if (fs.existsSync(SM_FILE)) sitemapUrls = JSON.parse(fs.readFileSync(SM_FILE, 'utf8')); };
const order = [...londonIds, ...ootIds];

if (flag('plan')) {
  loadSm();
  if (!sitemapUrls) { console.error('no sitemap file yet: run --fetch first'); process.exit(2); }
  let n = 0;
  for (const id of order) { const c = candidatesFor(id); if (c.length) n++; console.log(isLondon(id) ? 'L' : 'O', id, c.map((x) => x.url.replace('https://www.show-score.com', '')).join(' ')); }
  console.log(`${n} of ${order.length} shows have a candidate page`);
} else if (flag('fetch')) {
  const state = loadState();
  const save = () => fs.writeFileSync(OUT, JSON.stringify(state, null, 1));
  (async () => {
    ({ fetchPage } = require('../lib/scraper'));
    try { if (fs.existsSync(SM_FILE)) loadSm(); else await loadSitemaps(); } catch (e) { console.error(`sitemap read failed (${String(e.message).slice(0, 80)}): stopping`); process.exit(e.stop ? 3 : 1); }
    state.sitemap = { london: sitemapUrls.london.length, regional: sitemapUrls.regional.length };
    let n = 0; let errs = 0;
    for (const id of order) {
      if (state.shows[id]) continue;
      try { state.shows[id] = await sweepShow(id); errs = 0; } catch (e) {
        if (e.stop) { console.error(`bot wall or rate limit (${String(e.message).slice(0, 80)}) at ${id}: stopping, no bypass`); state.directRequestsTotal += requests; save(); process.exit(3); }
        state.shows[id] = { error: String(e.message).slice(0, 160) }; errs += 1;
        if (errs >= 5) { console.error('5 consecutive errors: stopping'); state.directRequestsTotal += requests; save(); process.exit(1); }
      }
      state.directRequestsTotal += requests; requests = 0; n += 1; save();
      if (n % 10 === 0) console.error(`${n} shows, direct requests ${state.directRequestsTotal}`);
    }
    state.directRequestsTotal += requests; save();
    const v = Object.values(state.shows);
    console.log(JSON.stringify({ shows: v.length, withRatings: v.filter((x) => x.pooled).length, directRequests: state.directRequestsTotal, paidFetches: 0 }));
  })().catch((e) => { console.error(e); process.exit(1); });
} else if (flag('merge')) {
  const st = loadState(); const merged = JSON.parse(JSON.stringify(prior));
  merged.card = 'BRO-7369+BRO-7380'; merged.note = `${prior.note} Merged with the BRO-7380 London-first and out-of-town sources.`;
  let added = 0;
  for (const [id, rec] of Object.entries(st.shows)) {
    if (!rec || !rec.sources) continue;
    const m = merged.shows[id] || (merged.shows[id] = { opening: rec.opening, previewsStart: rec.previewsStart, cutoff: rec.cutoff, sources: [] });
    const have = new Set((m.sources || []).map((x) => x.url).filter(Boolean));
    for (const x of rec.sources) {
      if (x.url && have.has(x.url)) continue;
      const twin = (m.sources || []).find((q) => q.n > 0 && q.n === x.n && q.mean === x.mean && q.newest === x.newest);
      m.sources.push(twin ? { ...x, duplicateOf: twin.url || twin.kind } : x); added += 1;
    }
    const live = m.sources.filter((x) => !x.duplicateOf);
    m.pooled = EA.pool(live); m.confirmedPooled = EA.pool(live.filter((x) => x.kind !== 'guess'));
  }
  fs.writeFileSync(MERGED, JSON.stringify(merged, null, 1));
  console.log(`merged ${added} new sources into ${path.relative(ROOT, MERGED)}`);
} else {
  const inv = inventory(); const st = loadState();
  const by = { 'london-first': { evaluated: londonIds.length, withDatedRating: 0, bySource: {} }, 'out-of-town': { evaluated: ootIds.length, withDatedRating: 0, bySource: {} } };
  for (const [id, rec] of Object.entries(st.shows)) {
    if (!rec || !rec.sources) continue;
    const g = by[isLondon(id) ? 'london-first' : 'out-of-town'];
    const live = rec.sources.filter((x) => x.n > 0);
    if (live.length) g.withDatedRating += 1;
    for (const x of live) g.bySource[x.kind] = (g.bySource[x.kind] || 0) + 1;
  }
  const priorAny = londonIds.filter((id) => prior.shows[id] && prior.shows[id].pooled).length;
  const priorLondonPage = londonIds.filter((id) => ((prior.shows[id] && prior.shows[id].sources) || []).some((x) => x.n > 0 && /\/uk\/london\//.test(x.url || ''))).length;
  const out = { card: 'BRO-7380', cohorts: inv, sweep: st.sitemap ? by : 'not fetched yet (run --fetch)', bro7369: { londonFirstWithAnyEarlierAudience: priorAny, londonFirstWithLondonPage: priorLondonPage }, requests: { direct: st.directRequestsTotal, paid: st.paidFetches } };
  out.backtest = fs.existsSync(BACKTEST) ? (J('data/audit/review-forecast-inputs-v2-london-audience.json').earlierAudience || {}).londonAudience || 'backtest file has no londonAudience block' : 'not run yet';
  console.log(JSON.stringify(out, null, 2));
}
