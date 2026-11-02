#!/usr/bin/env node
/**
 * Multi-source review finder CLI (BRO-6854): city hubs without a Theatre-In-X roundup site.
 *
 *   node scripts/city-finder.js find --city=san-diego --title="Cyrano" --theatre="The Old Globe" --start=2026-07-23 [--end=...]
 *   node scripts/city-finder.js recall --city=san-diego [--limit=N]    # run the finder on the BRO-6834 census productions and compare with the census review URLs
 *   node scripts/city-finder.js enumerate --city=san-diego             # BroadwayWorld regional listing -> current/upcoming productions
 *
 * All fetching goes through fetchPage(). --cache=<dir> memoises responses on disk (re-runs cost nothing).
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchPage, cleanup } = require('./lib/scraper');
const F = require('./lib/city-review-finder');
const { getFinder } = require('./lib/city-finder-config');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const today = arg('today', new Date().toISOString().slice(0, 10));

function makeFetch(cacheDir) {
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  return async (url) => {
    const f = cacheDir && path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex') + '.json');
    if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    let r = null;
    try { const p = await fetchPage(url, { skipVerify: true }); r = p && p.content ? { content: p.content, finalUrl: p.finalUrl || p.url || url } : null; } catch { r = null; }
    if (f && r) fs.writeFileSync(f, JSON.stringify(r));
    return r;
  };
}

async function main() {
  const cmd = process.argv[2];
  const city = getFinder(arg('city', 'san-diego'));
  const fetch = makeFetch(arg('cache', null));
  const dayCacheFile = path.join(ROOT, 'data', 'audit', `city-finder-days-${city.key}.json`);
  let dayCache = {};
  try { dayCache = JSON.parse(fs.readFileSync(dayCacheFile, 'utf8')); } catch { /* none yet */ }
  const ctx = F.makeContext({ fetch, today, dayCache, saveDayCache: (c) => fs.writeFileSync(dayCacheFile, JSON.stringify(c)) });

  if (cmd === 'find') {
    const prod = { title: arg('title'), theatre: arg('theatre', ''), start: arg('start'), end: arg('end', null), aliases: [] };
    const res = await F.findReviews(prod, city, ctx);
    console.log(JSON.stringify(res, null, 1));
  } else if (cmd === 'recall') {
    const census = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', 'us-city-census-2026.json'), 'utf8')).cities[city.key];
    const limit = Number(arg('limit', 999));
    const rows = [];
    let truth = 0; let hit = 0; let extra = 0;
    for (const p of census.productions.slice(0, limit)) {
      const prod = { title: p.title, theatre: p.theatre, start: p.openingDate, end: null, aliases: [] };
      const res = await F.findReviews(prod, city, ctx);
      const have = new Set(res.reviews.map((r) => r.url.replace(/\/$/, '')));
      const want = p.reviews.filter((r) => r.url).map((r) => r.url.replace(/\/$/, ''));
      const got = want.filter((u) => have.has(u));
      truth += want.length; hit += got.length; extra += [...have].filter((u) => !want.includes(u)).length;
      rows.push({ title: p.title, want: want.length, got: got.length, found: res.reviews.length, missed: want.filter((u) => !have.has(u)), extra: [...have].filter((u) => !want.includes(u)), rejected: res.rejected.length });
      console.log(`${p.title.slice(0, 36).padEnd(36)} census ${want.length} matched ${got.length} found ${res.reviews.length} (${res.log.join(' ')})`);
    }
    console.log(`RECALL ${hit}/${truth} (${Math.round(100 * hit / truth)}%), extra finds ${extra}`);
    fs.writeFileSync(path.join(ROOT, 'data', 'audit', `city-finder-recall-${city.key}.json`), JSON.stringify({ on: today, hit, truth, extra, rows }, null, 1) + '\n');
  } else if (cmd === 'enumerate') {
    const out = [];
    for (let page = 1; page <= 15; page++) {
      const r = await fetch(`https://www.broadwayworld.com/${city.bwwRegion}/regionalshows/${page > 1 ? `?page=${page}` : ''}`);
      const rows = F.parseBwwRegionalShows((r && r.content) || '', city.bwwRegion);
      const fresh = rows.filter((x) => !out.some((o) => o.bwwUrl === x.bwwUrl));
      if (!fresh.length) break;
      out.push(...fresh);
    }
    console.log(JSON.stringify(out, null, 1));
  } else {
    console.error('usage: city-finder.js find|recall|enumerate --city=<key>');
    process.exitCode = 2;
  }
  await cleanup();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
