#!/usr/bin/env node
/**
 * review-forecast-v2-wayback-sweep.js (BRO-7347): for each Broadway show, find the
 * newest Wayback capture of its Show Score page dated BEFORE opening night and read
 * the aggregate audience score and review count off that capture. Research only.
 *
 * Every request goes through fetchPage() (scripts/lib/scraper.js):
 *   - capture lookup: archive.org availability API, { directOnly: true } = free, no paid tier
 *   - capture read:   web.archive.org snapshot, normal chain (Scrapingdog/ScrapingBee) = 1 paid fetch
 * Paid fetches are counted and capped (--max-paid, default 150; the card's ceiling is ~300).
 * Only aggregate numbers (score, review count, capture timestamp) are written: no review text.
 *
 * Usage:
 *   node scripts/review-forecast-v2-wayback-sweep.js --ids-from=<backtest.json> [--limit=N] [--max-paid=150] [--lookup-only]
 * Output (checkpointed after every show, resumable): data/audit/review-forecast-v2-wayback-audience.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/scraper');
const { archiveSnapshotFetchUrl } = require('./lib/archive-snapshot-url');

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const OUT = arg('out', path.join(ROOT, 'data/audit/review-forecast-v2-wayback-audience.json'));
const MAX_PAID = +arg('max-paid', 150);
const LIMIT = +arg('limit', 100000);
const LOOKUP_ONLY = flag('lookup-only');
const OFFSETS = [-3, -10, -24, -45]; // look-up targets, days relative to opening night; every hit is kept only if dated before opening

const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
const urls = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/show-score-urls.json'), 'utf8')).shows;
const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
const idsFrom = arg('ids-from', null);
if (!idsFrom) { console.error('--ids-from=<review-forecast-backtest json> is required'); process.exit(2); }
const ids = [...new Set(JSON.parse(fs.readFileSync(idsFrom, 'utf8')).predictionsWalkForward.map((p) => p.id))].slice(0, LIMIT);

const stamp = (iso, off) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + off); return t.toISOString().slice(0, 10).replace(/-/g, ''); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let paid = 0;

async function lookup(pageUrl, ts) {
  const q = `https://archive.org/wayback/available?url=${encodeURIComponent(pageUrl)}&timestamp=${ts}`;
  const r = await fetchPage(q, { directOnly: true, skipVerify: true });
  const j = JSON.parse(r.content);
  const c = j.archived_snapshots && j.archived_snapshots.closest;
  return c && c.available && /^\d{14}$/.test(c.timestamp) ? c.timestamp : null;
}

/** aggregateRating JSON-LD of the show itself (first block), as Show Score prints it. */
function parseShowScore(html) {
  const m = /"aggregateRating":\{"bestRating":(\d+),"worstRating":\d+,"ratingValue":(\d+(?:\.\d+)?),"reviewCount":(\d+)/.exec(html);
  if (!m) return null;
  return { score: +m[2], max: +m[1], reviewCount: +m[3] };
}

const state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { card: 'BRO-7347', note: 'Aggregate Show Score numbers read from Wayback captures dated before opening night. No review text.', shows: {} };
const save = () => { state.paidFetches = (state.paidFetches || 0); fs.writeFileSync(OUT, JSON.stringify(state, null, 1)); };
paid = state.paidFetches || 0;

(async () => {
  let n = 0;
  for (const id of ids) {
    if (state.shows[id] && state.shows[id].done) continue;
    const s = byId[id];
    const rec = { opening: s && s.openingDate, url: urls[id] || null, captures: [], done: true };
    state.shows[id] = rec;
    if (!s) { rec.reason = 'unknown show'; save(); continue; }
    // stored url first; otherwise the two slugs Show Score uses (plain title, title + "-broadway"). Free lookups only.
    const tslug = String(s.title || '').toLowerCase().replace(/&/g, 'and').replace(/['\u2019]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const cands = urls[id] ? [urls[id]] : [`https://www.show-score.com/broadway-shows/${tslug}`, `https://www.show-score.com/broadway-shows/${tslug}-broadway`];
    const open = s.openingDate.replace(/-/g, '');
    const seen = new Map(); // timestamp -> page url
    for (const pageUrl of cands) {
      for (const off of OFFSETS) {
        let ts = null;
        try { ts = await lookup(pageUrl, stamp(s.openingDate, off)); } catch (e) { rec.lookupError = String(e.message).slice(0, 120); }
        await sleep(1100);
        if (ts && ts.slice(0, 8) < open && !seen.has(ts)) seen.set(ts, pageUrl);
      }
      if (seen.size) break;
    }
    const caps = [...seen.keys()].sort();
    rec.captureTimestampsBeforeOpening = caps;
    const best = caps[caps.length - 1]; // newest capture still before opening
    const pageUrl = best ? seen.get(best) : null; rec.url = pageUrl || rec.url;
    if (best && !LOOKUP_ONLY) {
      if (paid >= MAX_PAID) { rec.done = false; delete state.shows[id]; console.error(`paid cap ${MAX_PAID} reached, stopping`); break; }
      paid += 1; state.paidFetches = paid;
      try {
        const r = await fetchPage(archiveSnapshotFetchUrl(pageUrl, best), { skipVerify: true });
        const parsed = parseShowScore(r.content || '');
        rec.captures.push({ timestamp: best, via: r.source, ...(parsed || { parseFailed: true }) });
      } catch (e) { rec.captures.push({ timestamp: best, error: String(e.message).slice(0, 120) }); }
    }
    n += 1; save();
    if (n % 10 === 0) console.error(`${n} shows done, paid fetches ${paid}, with a pre-opening capture so far: ${Object.values(state.shows).filter((v) => v.captureTimestampsBeforeOpening && v.captureTimestampsBeforeOpening.length).length}`);
  }
  save();
  const v = Object.values(state.shows);
  console.log(JSON.stringify({ shows: v.length, withUrl: v.filter((x) => x.url).length, withCaptureBeforeOpening: v.filter((x) => x.captureTimestampsBeforeOpening && x.captureTimestampsBeforeOpening.length).length,
    parsed: v.filter((x) => x.captures.some((c) => c.score != null)).length, paidFetches: paid }));
})().catch((e) => { console.error(e); save(); process.exit(1); });
