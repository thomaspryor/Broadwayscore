#!/usr/bin/env node
/**
 * Stage a city's local productions for a hub launch (BRO-6854), for cities with no Theatre-In-X roundup site.
 *
 *   node scripts/city-finder-stage.js run  --city=san-diego [--since=2026-05-01] [--cache=dir]   # find reviews per production -> data/audit/city-finder-stage-<city>.json
 *   node scripts/city-finder-stage.js emit --city=san-diego --id=bro-6854-sd [--min=3]           # staged JSON -> add-show actions JSON (feed to new-fix-plan.js --actions)
 *
 * Production sources: the BRO-6834 census (when the city has one), the config's extraProductions, and BroadwayWorld's
 * regional listing (open now / opening within a week), restricted to the city's allowlisted producing theatres.
 * Reviews come from scripts/lib/city-review-finder.js; census review URLs are kept as seeds.
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchPage, cleanup } = require('./lib/scraper');
const F = require('./lib/city-review-finder');
const { getFinder } = require('./lib/city-finder-config');
const { sanitizeVenueForWrite } = require('./lib/venue-classification');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const today = arg('today', new Date().toISOString().slice(0, 10));
const normUrl = (u) => String(u).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
const SLUG_YEAR = (d) => String(d).slice(0, 4);

const slugify = (t) => String(t).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function theatreOf(city, name) {
  const n = F.norm(name);
  return city.theatres.find((t) => [t.name, ...(t.aliases || [])].some((a) => F.hasPhrase(n, a) || F.hasPhrase(F.norm(a), n)));
}

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

async function listProductions(city, since, getPage) {
  const prods = [];
  const add = (p) => {
    const key = `${F.norm(p.title)}|${p.theatreKey}`;
    const dup = prods.find((x) => `${F.norm(x.title)}|${x.theatreKey}` === key && Math.abs(Date.parse(x.start) - Date.parse(p.start)) < 90 * 86400000);
    if (dup) { dup.seeds = [...(dup.seeds || []), ...(p.seeds || [])]; dup.image = dup.image || p.image; dup.bwwUrl = dup.bwwUrl || p.bwwUrl; dup.end = dup.end || p.end; return; }
    prods.push(p);
  };
  // 1. census
  let census = null;
  try { census = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', 'us-city-census-2026.json'), 'utf8')).cities[city.key]; } catch { /* none */ }
  for (const p of (census && census.productions) || []) {
    if (p.openingDate < since) continue;
    const t = theatreOf(city, p.theatre);
    if (!t) { console.error(`skip (theatre not on the ${city.key} allowlist, city unknown): ${p.title} @ ${p.theatre}`); continue; }
    add({ title: p.title, theatre: t.name, theatreKey: t.name, city: t.city, pro: t.pro, start: p.openingDate, startSource: 'census', end: null, seeds: (p.reviews || []).filter((r) => r.url).map((r) => ({ url: r.url, outlet: r.outlet, critic: r.critic || null, date: r.date || null })) });
  }
  // 2. config extras
  for (const p of city.extraProductions || []) {
    const t = theatreOf(city, p.theatre);
    add({ title: p.title, theatre: t.name, theatreKey: t.name, city: t.city, pro: t.pro, start: p.start, startSource: 'config', end: null, seeds: [] });
  }
  // 3. BroadwayWorld regional listing: open now or opening within 7 days, allowlisted theatres only
  for (let page = 1; page <= 15; page++) {
    const r = await getPage(`https://www.broadwayworld.com/${city.bwwRegion}/regionalshows/${page > 1 ? `?page=${page}` : ''}`);
    const rows = F.parseBwwRegionalShows((r && r.content) || '', city.bwwRegion);
    if (!rows.length) break;
    for (const s of rows) {
      if (!s.start || s.end < since || s.start > F.addDays(today, 7)) continue;
      const t = theatreOf(city, s.theatre);
      if (!t) continue;
      if (/tour|school|youth|jr\.?\b|concert|tree lighting|tbd/i.test(s.title)) continue;
      add({ title: s.title, theatre: t.name, theatreKey: t.name, city: t.city || s.city, pro: t.pro, start: s.start, startSource: 'bww', end: s.end, image: s.image, bwwUrl: s.bwwUrl, seeds: [] });
    }
  }
  return prods.sort((a, b) => a.start.localeCompare(b.start));
}

async function run() {
  const city = getFinder(arg('city', 'san-diego'));
  const since = arg('since', '2026-05-01');
  const getPage = makeFetch(arg('cache', null));
  const dayCacheFile = path.join(ROOT, 'data', 'audit', `city-finder-days-${city.key}.json`);
  let dayCache = {};
  try { dayCache = JSON.parse(fs.readFileSync(dayCacheFile, 'utf8')); } catch { /* none */ }
  const ctx = F.makeContext({ getPage, today, dayCache, saveDayCache: (c) => fs.writeFileSync(dayCacheFile, JSON.stringify(c)) });
  const prods = await listProductions(city, since, getPage);
  console.error(`productions: ${prods.length}`);
  const out = [];
  for (const p of prods) {
    const res = await F.findReviews({ title: p.title, theatre: p.theatre, start: p.start, end: p.end, aliases: (theatreOf(city, p.theatre) || {}).aliases || [] }, city, ctx);
    const byUrl = new Map();
    for (const s of p.seeds || []) byUrl.set(normUrl(s.url), { url: s.url, outlet: s.outlet, critic: s.critic, date: s.date, source: 'census' });
    for (const r of res.reviews) byUrl.set(normUrl(r.url), { url: r.url, outlet: r.outlet, outletId: r.outletId, critic: r.critic, date: r.date, headline: r.headline, source: 'finder' });
    const reviews = [...byUrl.values()];
    const dates = reviews.map((r) => r.date).filter(Boolean).sort();
    out.push({ ...p, seeds: undefined, reviews, rejected: res.rejected.map((x) => ({ url: x.url, reason: x.reason })), firstReview: dates[0] || null });
    console.error(`${p.start} ${p.title.slice(0, 34).padEnd(34)} ${p.theatre.slice(0, 22).padEnd(22)} reviews ${reviews.length} (finder ${res.reviews.length})`);
  }
  const file = path.join(ROOT, 'data', 'audit', `city-finder-stage-${city.key}.json`);
  fs.writeFileSync(file, JSON.stringify({ city: city.key, on: today, since, productions: out }, null, 1) + '\n');
  console.error(`wrote ${path.relative(ROOT, file)}`);
  await cleanup();
}

function emit() {
  const city = getFinder(arg('city', 'san-diego'));
  const min = Number(arg('min', 3));
  const staged = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', `city-finder-stage-${city.key}.json`), 'utf8'));
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')).shows;
  const taken = new Set(shows.map((s) => s.id));
  const pf = path.join(ROOT, 'data', 'pending-fixes');
  for (const f of fs.readdirSync(pf)) { if (f.startsWith(`${arg('id', '~')}`)) continue; try { for (const a of JSON.parse(fs.readFileSync(path.join(pf, f), 'utf8')).plan.actions || []) if (a.show) taken.add(a.show.id); } catch { /* skip */ } }
  const hubs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city-hubs.json'), 'utf8'));
  const hubEntry = Object.entries(hubs.hubs).find(([, h]) => h.finder && h.finder.key === city.key);
  if (!hubEntry) throw new Error(`no data/city-hubs.json entry with finder.key=${city.key}`);
  const [hubSlug, hub] = hubEntry;
  const actions = [];
  const skipped = [];
  const haveProd = new Set(shows.filter((s) => s.localOnly).map((s) => `${F.norm(s.title)}|${F.norm(s.venue || '').split(' ').slice(0, 2).join(' ')}`));
  for (const p of staged.productions) {
    if (haveProd.has(`${F.norm(p.title)}|${F.norm(p.theatre).split(' ').slice(0, 2).join(' ')}`)) { skipped.push(`${p.title} (already a show)`); continue; }
    const openNow = p.end && p.end >= today && p.start <= today;
    if (p.reviews.length < min && !(openNow && p.reviews.length >= 2)) { skipped.push(`${p.title} (${p.reviews.length} reviews)`); continue; }
    const opening = p.firstReview && p.firstReview < p.start && p.startSource !== 'bww' ? p.firstReview : p.start;
    let id = `${slugify(p.title)}-regional-${SLUG_YEAR(opening)}`;
    if (taken.has(id)) id = `${slugify(p.title)}-${slugify(p.theatre).replace(/^the-/, '').split('-').slice(0, /^the /i.test(p.theatre) || !/^la /i.test(p.theatre) ? 1 : 2).join('')}-regional-${SLUG_YEAR(opening)}`;
    if (taken.has(id)) { skipped.push(`${p.title} (id taken)`); continue; }
    taken.add(id);
    const closed = p.end ? p.end < today : (Date.parse(today) - Date.parse(opening)) / 86400000 > 42;
    const show = {
      id, title: p.title, slug: id,
      venue: sanitizeVenueForWrite(`${p.theatre}, ${p.city || city.defaultCity || 'San Diego'}, ${city.state}`),
      status: closed ? 'closed' : 'open',
      type: /\b(musical|rent|hairspray|mean girls|cher show|rock of ages|guys and dolls|come from away|evan hansen|seussical|spongebob|most happy fella|american rhythm|we will rock you|carrie|charlie and the chocolate factory)\b/i.test(p.title) ? 'musical' : 'play',
      category: 'regional', market: 'regional',
      openingDate: opening,
      openingDateSource: p.startSource === 'census' ? 'census-earliest-review-date' : p.startSource === 'bww' ? 'broadwayworld-regional-listing' : 'earliest-review-date',
      discoverySource: hub.discoverySource,
      localOnly: true, city: hubSlug,
      discoveredAt: today,
      evidenceUrls: [p.bwwUrl, ...p.reviews.slice(0, 2).map((r) => r.url)].filter(Boolean).slice(0, 3),
    };
    if (p.end) show.closingDate = p.end;
    if (p.image) show.image = p.image;
    actions.push({ type: 'add-show', show, description: `add ${id}` });
  }
  const out = arg('out', path.join('/tmp', `${arg('id', 'plan')}-actions.json`));
  fs.writeFileSync(out, JSON.stringify(actions, null, 1) + '\n');
  console.log(`${actions.length} add-show actions -> ${out}; skipped ${skipped.length}: ${skipped.slice(0, 12).join('; ')}`);
}

const cmd = process.argv[2];
if (cmd === 'run') run().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === 'emit') emit();
else { console.error('usage: city-finder-stage.js run|emit --city=<key>'); process.exit(2); }
