#!/usr/bin/env node
'use strict';

/**
 * BRO-7250: list a finder city's local professional productions (running now or opening in ~3 months) from the
 * producing theatres' seasons, before any review exists.
 *
 *   node scripts/city-season-sync.js --city=san-diego [--id=bro-7250-sd] [--apply] [--max=N] [--cache=<dir>] [--out=<actions.json>]
 *
 * Reads BroadwayWorld's regional listing plus each SEASON_SOURCES page (LLM-read, every row checked against the page
 * text, see scripts/lib/city-season.js), drops shows the hub already has, fetches real art into public/images/shows/<id>/
 * (a show with no usable image is skipped, never added imageless), and writes add-show actions for new-fix-plan.js
 * --actions. Without --apply nothing is written to disk except the report.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchPage, cleanup } = require('./lib/scraper');
const F = require('./lib/city-review-finder');
const S = require('./lib/city-season');
const { getFinder, SEASON_SOURCES } = require('./lib/city-finder-config');
const { pageToText, readSeasonPage } = require('./lib/season-page-reader');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => process.argv.includes(`--${k}`);
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

async function bwwRows(city, getPage) {
  const rows = [];
  for (let page = 1; page <= 15; page++) {
    const r = await getPage(`https://www.broadwayworld.com/${city.bwwRegion}/regionalshows/${page > 1 ? `?page=${page}` : ''}`);
    const got = F.parseBwwRegionalShows((r && r.content) || '', city.bwwRegion);
    if (!got.length) break;
    rows.push(...got);
  }
  return rows;
}

async function pageRows(city, getPage, log) {
  const out = [];
  for (const t of city.theatres) {
    const src = SEASON_SOURCES[t.name];
    for (const url of (src && src.pages) || []) {
      try {
        const r = await getPage(url);
        if (!r) { log.push(`page unreachable: ${t.name} ${url}`); continue; }
        const { text, links } = pageToText(r.content, r.finalUrl);
        if (text.length < 300) { log.push(`page too short: ${t.name} ${url}`); continue; }
        const llm = await readSeasonPage({ theatre: t.name, city: t.city || city.defaultCity, today, horizon: F.addDays(today, S.HORIZON_DAYS), text });
        const kept = S.fromPageRows(llm, { theatre: t, pageText: text, pageLinks: links, pageUrl: r.finalUrl, today });
        log.push(`${t.name}: ${llm.length} read, ${kept.length} kept`);
        out.push(...kept);
      } catch (e) { log.push(`page failed: ${t.name} ${url}: ${String(e.message).slice(0, 120)}`); }
    }
  }
  return out;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** First usable art for a row: the listing image, else the production page's og:image. Returns a Buffer or null. */
const seasonPages = new Set(Object.values(SEASON_SOURCES).flatMap((x) => x.pages || []));
async function findArt(row, getPage) {
  const cands = [row.image];
  // A season page's og:image is the theatre's site-wide banner; only a production-specific page can supply art.
  for (const u of [row.pageUrl].filter((x) => x && !/^https?:\/\/[^/]+\/?$/.test(x) && !seasonPages.has(x))) {
    const r = await getPage(u);
    const m = r && (/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(r.content) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(r.content));
    if (m) { try { cands.push(new URL(m[1].replace(/&amp;/g, '&'), r.finalUrl).href); } catch { /* skip */ } }
  }
  const sharp = require('sharp');
  for (const u of cands.filter(Boolean)) {
    try {
      const buf = await download(u);
      const meta = await sharp(buf).metadata();
      if ((meta.width || 0) >= 300 && (meta.height || 0) >= 200 && !/logo|placeholder|default/i.test(u)) return buf;
    } catch { /* next */ }
  }
  return null;
}

async function writeArt(id, buf) {
  const sharp = require('sharp');
  const dir = path.join(ROOT, 'public', 'images', 'shows', id);
  fs.mkdirSync(dir, { recursive: true });
  await sharp(buf).resize(480, 720, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toFile(path.join(dir, 'poster.webp'));
  await sharp(buf).resize(300, 450, { fit: 'cover', position: 'attention' }).webp({ quality: 80 }).toFile(path.join(dir, 'thumbnail.webp'));
  return { poster: `/images/shows/${id}/poster.webp`, thumbnail: `/images/shows/${id}/thumbnail.webp` };
}

async function main() {
  const city = getFinder(arg('city', 'san-diego'));
  const planId = arg('id', 'bro-7250');
  const getPage = makeFetch(arg('cache', null));
  const log = [];
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')).shows;
  const hubs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city-hubs.json'), 'utf8'));
  const hubEntry = Object.entries(hubs.hubs).find(([, h]) => h.finder && h.finder.key === city.key);
  if (!hubEntry) throw new Error(`no data/city-hubs.json entry with finder.key=${city.key}`);
  const [hubSlug, hub] = hubEntry;
  const hubShows = shows.filter((s) => s.city === hubSlug);

  const taken = new Set(shows.map((s) => s.id));
  const pending = [];
  let retired = () => false;
  try { retired = require('./lib/retired-show-ids').isRetiredId; } catch { /* registry missing */ }
  const pf = path.join(ROOT, 'data', 'pending-fixes');
  if (fs.existsSync(pf)) {
    const plans = [];
    for (const f of fs.readdirSync(pf)) { if (f.startsWith(planId)) continue; try { plans.push(JSON.parse(fs.readFileSync(path.join(pf, f), 'utf8'))); } catch { /* skip */ } }
    for (const sh of S.pendingShows(plans)) { taken.add(sh.id); pending.push(sh); }
  }

  const bwwAll = await bwwRows(city, getPage);
  if (!bwwAll.length) log.push('WARN: BroadwayWorld listing returned no rows');
  const bww = S.fromBwwRows(bwwAll, city, today);
  const pages = await pageRows(city, getPage, log);
  const rows = S.mergeSeason([bww, pages]);

  const actions = [];
  const report = { city: city.key, today, read: { bww: bww.length, pages: pages.length }, added: [], existing: [], skipped: [] };
  const cands = [];
  for (const row of rows) {
    const have = S.findExisting(row, [...hubShows, ...pending]);
    if (have) { report.existing.push(`${row.title} (${have.id})`); continue; }
    const id = S.showId(row, taken);
    if (!id || retired(id)) { report.skipped.push(`${row.title}: id taken or retired`); continue; }
    if (cands.length >= (Number(arg('max', 0)) || Infinity) + 2) { report.skipped.push(`${row.title}: over the per-run cap`); continue; } // before the art download; +2 spare for banner rejects
    const art = await findArt(row, getPage);
    if (!art) { report.skipped.push(`${row.title}: no real image`); continue; }
    taken.add(id);
    cands.push({ row, id, art, hash: crypto.createHash('sha1').update(art).digest('hex') });
  }
  // One banner shared by several productions is the theatre's site-wide image, not that show's art.
  const perHash = {};
  for (const c of cands) perHash[c.hash] = (perHash[c.hash] || 0) + 1;
  const max = Number(arg('max', 0)) || Infinity; // per-run cap (daily job): the rest wait for the next run
  for (const c of cands) {
    if (actions.length >= max) { report.skipped.push(`${c.row.title}: over the per-run cap`); continue; }
    if (perHash[c.hash] > 1) { report.skipped.push(`${c.row.title}: image shared with another production (site-wide banner)`); continue; }
    const show = S.buildShow(c.row, { id: c.id, hubSlug, hub, city, today });
    show.images = flag('apply') ? await writeArt(c.id, c.art) : { poster: `/images/shows/${c.id}/poster.webp`, thumbnail: `/images/shows/${c.id}/thumbnail.webp` };
    actions.push({ type: 'add-show', show, description: `add ${c.id}` });
    report.added.push({ id: c.id, title: c.row.title, theatre: c.row.theatre, start: c.row.start, end: c.row.end, sources: c.row.sources });
  }
  const out = arg('out', path.join(process.env.TMPDIR || '/tmp', `${planId}-actions.json`));
  if (flag('apply')) fs.writeFileSync(out, JSON.stringify(actions, null, 1) + '\n');
  fs.mkdirSync(path.join(ROOT, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'audit', `city-season-${city.key}.json`), JSON.stringify({ ...report, log }, null, 1) + '\n');
  console.log(log.join('\n'));
  console.log(`${city.key}: ${report.added.length} new (${flag('apply') ? `actions -> ${out}` : 'dry run'}), ${report.existing.length} already on the hub, ${report.skipped.length} skipped`);
  for (const a of report.added) console.log(`  + ${a.title} @ ${a.theatre} ${a.start}..${a.end} [${a.sources.join('+')}]`);
  for (const s of report.skipped) console.log(`  - ${s}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => cleanup && cleanup());
module.exports = { main };
