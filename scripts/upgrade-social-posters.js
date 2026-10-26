#!/usr/bin/env node
/**
 * Full-size posters for recent shows (BRO-6393).
 *
 * Social cards (scripts/social-autopost/art.js) need a portrait poster at least
 * 440 px wide, and the owner's rule is never to post without one. Many site
 * posters are 160-200 px thumbnails, so this finds a larger original for every
 * show that opened since --since (default 2026-09-01) or opens in the next
 * --ahead days (default 14), shows the social ledger holds for want of a poster
 * first. Sources, in order:
 *
 *   1. TodayTix: the catalogue (New York + London) matched by title, for shows
 *      with no todaytixId; the show's own 480x720 posterMedia.
 *   2. The official site's images (og:image, twitter:image, <img>), and when the
 *      official URL is the venue's home page, the show's page on it.
 *   3. Mezzanine/theaterdiary originals (data/mezzanine-image-cache.json).
 *
 * A candidate must be a portrait poster >= 440 px wide at its native size
 * (never upscaled) and pass the same Gemini vision check art.js uses. The
 * winner is recorded as the show's poster source in data/image-sources.json
 * (art.js reads it first) and the site poster file is re-written from it,
 * sharper, at the site's 480 px cap.
 *
 *   node scripts/upgrade-social-posters.js --report          # count shows with no usable poster (no writes)
 *   node scripts/upgrade-social-posters.js                   # find + record posters for those shows
 *   node scripts/upgrade-social-posters.js --show=ID         # one show
 *   options: --since=YYYY-MM-DD --ahead=N --limit=N --dry-run (find, do not write)
 * Env: GEMINI_API_KEY (vision check; without it nothing is recorded).
 */

const fs = require('fs');
const path = require('path');
const { loadImageSources, saveImageSources } = require('./lib/image-sources-store');
const { todaytixApiArtEligible } = require('./lib/image-fetch-selection');
const { isUsablePoster, candidatesFor, loadBuffer, checkArt, originalUrl, originalVariants } = require('./social-autopost/art');
const { todaytixMarket } = require('./lib/todaytix-market');
const { normalizeTitle } = require('./lib/title-match');
const { pickMezzanineCandidate, buildVenueCityIndex, isRejectedImage, imagePathOwner } = require('./lib/image-source-match');
const { buildSourceIndex, addToSourceIndex, sourceConflict } = require('./lib/shared-image-source');
const { IMAGE_WIDTH_CAPS, writeVariant } = require('./lib/show-image-caps');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_FILE = path.join(ROOT, 'data', 'social-autopost-ledger.json');
const MEZZ_CACHE = path.join(ROOT, 'data', 'mezzanine-image-cache.json');
const DAY = 864e5;
const MAX_DOWNLOADS_PER_SHOW = 20;
const FETCH_TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const args = process.argv.slice(2);
const arg = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = name => args.includes(`--${name}`);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/**
 * Pure: shows to check, held-for-poster ids first, then shows opening soonest,
 * then the most recent openings. Exported for tests.
 */
function selectTargets(shows, { since, now, aheadDays = 14, waiting = {}, only = null }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const until = new Date(now + aheadDays * DAY).toISOString().slice(0, 10);
  const picked = shows.filter(s => {
    if (!s || !s.id) return false;
    if (only) return s.id === only;
    if (waiting[s.id]) return true;
    if (!s.openingDate || s.provisional || s.cancelledBeforeOpening) return false;
    if (['cancelled', 'canceled', 'postponed'].includes(s.status)) return false;
    const d = String(s.openingDate).slice(0, 10);
    return d >= since && d <= until;
  });
  const rank = s => (waiting[s.id] ? 0 : String(s.openingDate).slice(0, 10) > today ? 1 : 2);
  return picked.sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 1 ? String(a.openingDate).localeCompare(String(b.openingDate)) : String(b.openingDate).localeCompare(String(a.openingDate))));
}

/** Pure: shows opened in [since, today], the population the acceptance count is over. */
function openedSince(shows, since, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  return shows.filter(s => s && s.openingDate && !s.provisional && !s.cancelledBeforeOpening
    && !['cancelled', 'canceled', 'postponed'].includes(s.status)
    && String(s.openingDate).slice(0, 10) >= since && String(s.openingDate).slice(0, 10) <= today);
}

/** Pure: image URLs on an HTML page (og/twitter image, JSON-LD image, <img> src/srcset largest). Exported for tests. */
function extractPageImages(html, baseUrl) {
  if (!html) return [];
  const found = [];
  const push = (raw) => {
    if (!raw) return;
    const s = String(raw).trim().replace(/&amp;/g, '&');
    if (!s || s.startsWith('data:')) return;
    try { found.push(new URL(s, baseUrl).toString()); } catch { /* not a URL */ }
  };
  for (const re of [
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/gi,
    /"image"\s*:\s*"([^"]+)"/gi,
  ]) for (const m of html.matchAll(re)) push(m[1]);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcset = /\b(?:data-)?srcset=["']([^"']+)["']/i.exec(tag);
    if (srcset) {
      const best = srcset[1].split(',').map(p => p.trim().split(/\s+/))
        .map(([u, d]) => ({ u, w: parseInt(d, 10) || 0 })).sort((a, b) => b.w - a.w)[0];
      if (best) push(best.u);
    }
    const src = /\b(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i.exec(tag);
    if (src) push(src[1]);
  }
  return [...new Set(found)].filter(u => /^https?:/i.test(u) && !/\.(svg|gif)(\?|$)/i.test(u) && !/logo|icon|favicon|sprite|avatar/i.test(u));
}

/** Pure: links on a venue home page that look like this show's page. Exported for tests. */
function showPageLinks(html, baseUrl, title) {
  if (!html) return [];
  const words = normalizeTitle(title).split(' ').filter(w => w.length > 2 && !['the', 'and'].includes(w));
  if (!words.length) return [];
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let abs;
    try { abs = new URL(m[1], baseUrl); } catch { continue; }
    if (abs.hostname !== new URL(baseUrl).hostname) continue;
    const hay = normalizeTitle(`${decodeURIComponent(abs.pathname).replace(/[-_/]/g, ' ')} ${m[2].replace(/<[^>]+>/g, ' ')}`);
    if (words.every(w => hay.includes(w))) out.push(abs.toString());
  }
  return [...new Set(out)].slice(0, 3);
}

/** Pure: is this official URL just a site's home page (venue site, not a show page)? */
function isHomePage(url) {
  try { return /^\/?(index\.\w+)?$/.test(new URL(url).pathname); } catch { return false; }
}

// ---- sources ----

let ttCatalogue = null;
async function todaytixCatalogue() {
  if (ttCatalogue) return ttCatalogue;
  ttCatalogue = { nyc: [], london: [] };
  for (const [loc, market] of [[1, 'nyc'], [2, 'london']]) {
    for (let offset = 0; offset < 2000; offset += 100) {
      try {
        const res = await fetch(`https://api.todaytix.com/api/v2/shows?location=${loc}&limit=100&offset=${offset}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) break;
        const j = await res.json();
        const data = j.data || [];
        for (const s of data) ttCatalogue[market].push({ id: s.id, name: s.displayName || s.name, poster: s.images && s.images.productMedia && s.images.productMedia.posterImage && s.images.productMedia.posterImage.file && s.images.productMedia.posterImage.file.url });
        if (!data.length || offset + data.length >= ((j.pagination && j.pagination.total) || 0)) break;
      } catch { break; }
    }
  }
  console.log(`   TodayTix catalogue: ${ttCatalogue.nyc.length} NYC + ${ttCatalogue.london.length} London shows`);
  return ttCatalogue;
}

/** Pure: catalogue rows whose normalized title equals the show's. Exported for tests. */
function matchCatalogue(rows, title) {
  const want = normalizeTitle(title);
  return (rows || []).filter(r => r.name && normalizeTitle(r.name) === want);
}

const TODAYTIX_CATEGORIES = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);

async function todaytixCandidates(show) {
  const out = [];
  const ids = [];
  if (show.todaytixId) ids.push(show.todaytixId);
  else if (TODAYTIX_CATEGORIES.has(show.category) && todaytixApiArtEligible(show)) {
    // The catalogue lists productions on sale now, in New York and London only: a
    // tour, regional or long-closed row's title match is another production.
    const cat = await todaytixCatalogue();
    for (const r of matchCatalogue(cat[todaytixMarket(show)], show.title)) {
      ids.push(r.id);
      if (r.poster) out.push({ url: originalUrl(r.poster.startsWith('//') ? `https:${r.poster}` : r.poster), source: `todaytix catalogue #${r.id}` });
    }
  }
  for (const id of ids) {
    try {
      const res = await fetch(`https://api.todaytix.com/api/v2/shows/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      const media = ((await res.json()).data || {}).posterMedia;
      if (media && media.imageUrl) out.unshift({ url: originalUrl(media.imageUrl), source: `todaytix #${id}` });
    } catch { /* next */ }
  }
  return out;
}

async function pageHtml(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (res.ok) {
      const t = await res.text();
      if (t.length > 2000) return t;
    }
  } catch { /* fall through to the scraper chain */ }
  try {
    const { fetchPage } = require('./lib/scraper');
    const r = await fetchPage(url);
    return r && r.content;
  } catch { return null; }
}

async function officialSiteCandidates(show) {
  if (!show.officialUrl) return [];
  const home = await pageHtml(show.officialUrl);
  if (!home) return [];
  // A venue home page carries every current and upcoming show's poster, so only
  // the show's own page on it is used, never the home page's images.
  if (!isHomePage(show.officialUrl)) return extractPageImages(home, show.officialUrl).map(u => ({ url: u, source: `official site ${show.officialUrl}` }));
  const out = [];
  for (const p of showPageLinks(home, show.officialUrl, show.title)) {
    const html = await pageHtml(p);
    for (const u of extractPageImages(html, p)) out.push({ url: u, source: `venue page ${p}` });
  }
  return out;
}

let mezz = null;
function mezzanineCandidates(show, shows) {
  if (!mezz) {
    const norm = s => String(s || '').toLowerCase().replace(/['‘’“”!:,.;\-–—&+()]/g, '').replace(/\s+/g, ' ').replace(/^the\s+/, '').trim();
    const byTitle = new Map();
    for (const r of (readJson(MEZZ_CACHE, {}).records || [])) {
      if (!r.name || !r.artUrl) continue;
      const k = norm(r.name);
      if (!byTitle.has(k)) byTitle.set(k, []);
      byTitle.get(k).push(r);
    }
    mezz = { norm, byTitle, venueCity: buildVenueCityIndex(shows) };
  }
  const { candidate } = pickMezzanineCandidate(show, mezz.byTitle.get(mezz.norm(show.title)) || [], mezz.venueCity);
  return candidate ? [{ url: candidate.artUrl, source: `mezzanine (${candidate.theater || 'no venue'})` }] : [];
}

// ---- measuring ----

async function measure(buf) {
  try { const m = await require('sharp')(buf).metadata(); return { width: m.width, height: m.height }; } catch { return null; }
}

/** The best poster art.js would find now, by size only (no vision check). */
async function currentPoster(show, sources) {
  let best = null;
  for (const c of candidatesFor(show, sources)) {
    const buf = await loadBuffer(c);
    const m = buf && await measure(buf);
    if (!m) continue;
    const where = c.url || (c.file ? path.relative(ROOT, c.file) : `todaytix ${c.todaytixId}`);
    if (isUsablePoster(m)) return { usable: true, ...m, where, url: c.url || null, buf };
    if (!best || m.width > best.width) best = { usable: false, ...m, where };
  }
  return best || { usable: false, width: 0, height: 0, where: 'no poster on file' };
}

async function download(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 5000 ? buf : null;
  } catch { return null; }
}

/** Find, size-check and vision-check a full-size poster. Returns {url, buf, width, height, source} or null. */
async function findPoster(show, ctx) {
  const tried = new Set();
  let downloads = 0;
  for (const [name, get] of [
    ['todaytix', () => todaytixCandidates(show)],
    ['official/venue site', () => officialSiteCandidates(show)],
    ['mezzanine', () => mezzanineCandidates(show, ctx.shows)],
  ]) {
    let cands = [];
    try { cands = await get(); } catch (e) { console.log(`   ✗ ${name}: ${e.message}`); }
    for (const c of cands) {
      for (const url of originalVariants(c.url)) {
        if (tried.has(url) || downloads >= MAX_DOWNLOADS_PER_SHOW) continue;
        tried.add(url);
        if (isRejectedImage({ poster: url }, show)) { console.log(`   ✗ ${url}: in rejectedImageUrls`); continue; }
        const conflict = sourceConflict(show.id, url, ctx.sourceIndex, ctx.shows);
        if (conflict) { console.log(`   ✗ ${url}: ${conflict.reason}${conflict.owner ? ` by ${conflict.owner}` : ''}`); continue; }
        downloads++;
        const buf = await download(url);
        const m = buf && await measure(buf);
        if (!m) continue;
        if (!isUsablePoster(m)) { if (m.width >= 200) console.log(`   · ${c.source}: ${m.width}x${m.height} not a >=440px portrait poster`); continue; }
        const png = await require('sharp')(buf).rotate().png().toBuffer();
        const verdict = await ctx.check(show, png);
        if (!verdict.ok) { console.log(`   ✗ ${c.source}: ${m.width}x${m.height} art not confirmed (${verdict.reason})`); continue; }
        return { url, buf, ...m, source: c.source };
      }
    }
  }
  return null;
}

/** Record the poster source and re-write the site poster from it (never enlarged). */
/**
 * Record the poster source and re-write the site poster from it (never enlarged).
 * image-sources.json describes the file each show serves, so the source is only
 * recorded together with a re-written file of the show's OWN folder; the map is
 * re-read just before the write so a concurrent writer's entries survive.
 */
async function applyPoster(show, found, { record = true } = {}) {
  const local = show.images && show.images.poster;
  if (!local || !local.startsWith('/')) return 'skipped (no local poster file to re-write)';
  if (imagePathOwner(local) !== show.id) return `skipped (poster file belongs to ${imagePathOwner(local) || 'no show'})`;
  const abs = path.join(ROOT, 'public', local);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const sharp = require('sharp');
  const width = Math.min(found.width, IMAGE_WIDTH_CAPS.poster);
  const existing = fs.existsSync(abs) ? await measure(fs.readFileSync(abs)) : null;
  // Same art (record=false): only re-write when sharper. New art: always re-write.
  if (!record && existing && existing.width >= width) return `nothing to do (site poster already ${existing.width}px)`;
  let img = sharp(found.buf).rotate().resize({ width, withoutEnlargement: true });
  img = ext === 'webp' ? img.webp({ quality: 82 }) : ext === 'png' ? img.png() : img.jpeg({ quality: 85, mozjpeg: true });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, await img.toBuffer());
  await writeVariant(abs, { force: true });
  if (record) {
    const fresh = loadImageSources();
    fresh[show.id] = { ...(fresh[show.id] || {}), poster: found.url };
    saveImageSources(fresh);
  }
  return `${record ? 'source recorded, ' : ''}site poster re-written ${existing ? `${existing.width}px -> ` : ''}${width}px`;
}

const USAGE = `upgrade-social-posters.js — full-size posters for recent shows (BRO-6393).

Usage:
  node scripts/upgrade-social-posters.js --report     count shows with no usable poster (no writes)
  node scripts/upgrade-social-posters.js              find + record posters
  node scripts/upgrade-social-posters.js --show=ID    one show
  options: --since=YYYY-MM-DD --ahead=N --limit=N --dry-run
  node scripts/upgrade-social-posters.js --help, -h   print this usage and exit
`;

async function main() {
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const now = Date.now();
  const since = arg('since') || '2026-09-01';
  const showsRaw = readJson(path.join(ROOT, 'data', 'shows.json'), null);
  if (!showsRaw) throw new Error('data/shows.json missing');
  const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
  const sources = loadImageSources();
  const waiting = ((readJson(LEDGER_FILE, {}) || {})._meta || {}).waitingForPoster || {};

  if (flag('report')) {
    const pop = openedSince(shows, since, now);
    const missing = [];
    for (const s of pop) {
      const p = await currentPoster(s, sources);
      if (!p.usable) missing.push({ id: s.id, best: `${p.width}x${p.height}`, where: p.where });
    }
    for (const m of missing) console.log(`  no usable poster: ${m.id} (best ${m.best}, ${m.where})`);
    console.log(`[posters] ${pop.length} shows opened ${since}..today; ${missing.length} have no portrait poster >=440px (size check only; the vision check runs at post time)`);
    return;
  }

  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is needed: no poster is recorded without the vision check');
  const dryRun = flag('dry-run');
  const targets = selectTargets(shows, { since, now, aheadDays: Number(arg('ahead') || 14), waiting, only: arg('show') });
  const limit = Number(arg('limit') || 0) || Infinity;
  const ctx = { shows, sourceIndex: buildSourceIndex(sources, shows), check: (show, png) => checkArt(show, png, { strict: true }) };
  let checked = 0, fixed = 0, sharpened = 0;
  const stillMissing = [];
  for (const show of targets) {
    if (checked >= limit) break;
    const cur = await currentPoster(show, sources);
    const recorded = (sources[show.id] || {}).poster;
    if (cur.usable && cur.url && recorded && cur.url !== recorded && originalVariants(recorded).includes(cur.url)) {
      // The recorded source was a resized copy of this same file: record the original
      // and re-sharpen the site poster (same art, so no vision check needed). Contentful
      // transform params alone are not recorded (art.js and the archiver strip those already);
      // the site poster is still re-sharpened from the master.
      console.log(`\n[posters] ${show.id}: original of the recorded poster is ${cur.width}x${cur.height}: ${cur.url}`);
      if (!dryRun) console.log(`   ${await applyPoster(show, cur, { record: cur.url !== originalUrl(recorded) })}`);
      sharpened++;
      continue;
    }
    // A held show whose poster is big enough failed the vision check: search anyway.
    if (cur.usable && !waiting[show.id]) continue;
    checked++;
    console.log(`\n[posters] ${show.id} (${show.openingDate}${waiting[show.id] ? ', held by social' : ''}): best now ${cur.width}x${cur.height}`);
    const found = await findPoster(show, ctx);
    if (!found) { stillMissing.push(show.id); console.log('   none found'); continue; }
    console.log(`   ✓ ${found.width}x${found.height} from ${found.source}: ${found.url}`);
    if (dryRun) continue;
    const what = await applyPoster(show, found); // writes per show: an interrupted run keeps what it found
    if (what.startsWith('source recorded')) { fixed++; addToSourceIndex(ctx.sourceIndex, show.id, found.url); }
    console.log(`   ${what}`);
  }
  console.log(`\n[posters] ${sharpened} recorded source(s) had a full-size original (recorded where the path differs, site poster re-sharpened where smaller); checked ${checked} show(s) without a usable poster: found ${checked - stillMissing.length}${dryRun ? ' (dry run, nothing written)' : `, recorded ${fixed}`}; still missing ${stillMissing.length}${stillMissing.length ? `: ${stillMissing.join(', ')}` : ''}`);
}

if (require.main === module) {
  main().catch(err => { console.error(`[posters] ${err.stack || err.message}`); process.exit(1); });
}

module.exports = { selectTargets, openedSince, extractPageImages, showPageLinks, isHomePage, matchCatalogue };
