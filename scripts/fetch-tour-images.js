#!/usr/bin/env node
/**
 * fetch-tour-images.js (BRO-4726): give every national tour its own key art.
 *
 * fetch-show-images-auto.js skips tours (a title search hands them Broadway
 * or West End art), and a tour inherits its Broadway parent's art only when
 * the parent is plausibly the same production. This finds art tied to one of
 * the tour's own engagements (scripts/lib/tour-art.js): TodayTix listings
 * matched to its stops, then the presenters' event pages linked from its
 * Tours To You schedule. Each image must pass Gemini (this title, real key
 * art, not a placeholder or a photo) before it is archived as WebP under
 * public/images/shows/<tour-id>/ and written to shows.json, replacing any
 * inherited Broadway file. A role the tour already holds its own file for is
 * left alone, so art does not churn between runs.
 *
 * Run daily by .github/workflows/fetch-tour-schedules.yml, right after it
 * refreshes data/tour-schedules.json. A tour with nothing findable is tried
 * again after RETRY_DAYS (data/tour-art-attempts.json); --show ignores that.
 *
 * Usage:
 *   node scripts/fetch-tour-images.js              all running and upcoming tours
 *   node scripts/fetch-tour-images.js --show=ID    one tour (closed ones too)
 *   node scripts/fetch-tour-images.js --dry-run    verify and report, write nothing
 *     [--preview=DIR]                              with --dry-run: save the chosen images to DIR
 *   --max-minutes=N                                stop starting new tours after N minutes (default 25)
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { isTourShow, tourImageProblems } = require('./lib/tour-family');
const { TOUR_LOCATIONS } = require('./lib/todaytix-tour-tickets');
const { todaytixArt, stopEventPages, pageImageUrls, rolesForSize, rolesNeeded, archivedUnreferenced, attemptAction, landscapeCroppable, cropAllowed, descriptionNamesTitle, retryDue, RETRY_DAYS } = require('./lib/tour-art');
const { fetchSchedule } = require('./lib/tours-to-you');
const { isPlaceholderFile } = require('./lib/show-images');

const ROOT = path.join(__dirname, '..');
const SCHEDULES_PATH = path.join(ROOT, 'data', 'tour-schedules.json');
const { loadImageSources, saveImageSources } = require('./lib/image-sources-store');
// Tours searched with nothing found, so the next search waits RETRY_DAYS.
const ATTEMPTS_PATH = path.join(ROOT, 'data', 'tour-art-attempts.json');
const OUTPUT_DIR = path.join(ROOT, 'public', 'images', 'shows');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MAX_EVENT_PAGES = 8;
const PAGE_SIZE = 100;

async function fetchBuffer(url, accept = '*/*') {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchListings() {
  const rows = [];
  const failed = [];
  for (const id of Object.keys(TOUR_LOCATIONS).map(Number)) {
    try {
      for (let page = 0; page < 10; page++) {
        const data = JSON.parse((await fetchBuffer(`https://api.todaytix.com/api/v2/shows?location=${id}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, 'application/json')).toString('utf8'));
        const batch = Array.isArray(data?.data) ? data.data : [];
        rows.push(...batch.map(r => ({ ...r, _locationId: id })));
        if (batch.length < PAGE_SIZE) break;
      }
    } catch (e) {
      failed.push(id);
      console.log(`TodayTix location ${id}: ${e.message}`);
    }
  }
  return { rows, failed };
}

/** Download, size-check and Gemini-check one image. Returns {buffer, roles} or null. */
async function vet(url, tour, wantRoles, ctx, label) {
  const mayCrop = cropAllowed(tour);
  let buffer;
  try { buffer = await fetchBuffer(url, 'image/*'); } catch (e) { console.log(`    ${label}: download failed (${e.message})`); return null; }
  let meta;
  try { meta = await ctx.sharp(buffer).metadata(); } catch { console.log(`    ${label}: not an image`); return null; }
  let roles = rolesForSize(meta.width, meta.height).filter(r => wantRoles.includes(r));
  let cropped = false;
  // Presenter pages mostly offer a 1200x630 social banner, which fits no
  // role. Its centre square makes a thumbnail when the crop itself still
  // shows the title (checked below), and only for a tour with no thumbnail.
  if (!roles.length && mayCrop && wantRoles.includes('thumbnail') && landscapeCroppable(meta.width, meta.height)) {
    buffer = await ctx.sharp(buffer).resize({ width: meta.height, height: meta.height, fit: 'cover', position: 'centre' }).toBuffer();
    roles = ['thumbnail'];
    cropped = true;
  }
  if (!roles.length) { console.log(`    ${label}: ${meta.width}x${meta.height} fits none of ${wantRoles.join('/')}`); return null; }
  const png = await ctx.sharp(buffer).png().toBuffer();
  let v;
  try {
    v = await ctx.verifyImage(png, tour.title, { market: 'tour', mimeType: 'image/png', openingDate: tour.openingDate, rateLimiter: ctx.rateLimiter });
  } catch (e) { ctx.transient = true; console.log(`    ${label}: verify failed (${e.message})`); return null; }
  // A Gemini outage is not "no art": retry tomorrow, not after the backoff.
  if (v && (v.issues || []).includes('api_error')) { ctx.transient = true; console.log(`    ${label}: skipped, ${v.description}`); return null; }
  // Positive confirmation only: a tour's art replaces what it has now.
  if (!v || v.match !== true || (v.imageType && v.imageType !== 'promotional_art')) {
    console.log(`    ${label}: rejected (${v ? `${v.description} [${(v.issues || []).join(',')}]` : 'no verdict'})`);
    return null;
  }
  if (cropped && !(v.confidence === 'high' && descriptionNamesTitle(v.description, tour.title))) {
    console.log(`    ${label}: centre crop rejected, title not confirmed (${v.description})`);
    return null;
  }
  // One stop's dates or venue on the art would mislead on a tour page.
  const stamp = await ctx.detectEngagementStamp(png, { mimeType: 'image/png', rateLimiter: ctx.rateLimiter });
  if (stamp.stamped === null) ctx.transient = true;
  if (stamp.stamped !== false) {
    console.log(`    ${label}: rejected, ${stamp.stamped ? `stamped with one engagement (${stamp.text})` : `stamp check failed (${stamp.text})`}`);
    return null;
  }
  console.log(`    ${label}: ok ${meta.width}x${meta.height}${cropped ? ' centre crop' : ''} as ${roles.join('+')} (${v.description})`);
  return { buffer, roles, cropped };
}

async function archive(tour, role, buffer, ctx) {
  const rel = `/images/shows/${tour.id}/${role}.webp`;
  const abs = path.join(PUBLIC_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await ctx.sharp(buffer).webp({ quality: 85 }).toFile(tmp);
  if (isPlaceholderFile(tmp)) { fs.unlinkSync(tmp); return null; }
  fs.renameSync(tmp, abs);
  return rel;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log('fetch-tour-images.js [--show=ID] [--dry-run [--preview=DIR]] [--max-minutes=N]'); return; }
  const dryRun = argv.includes('--dry-run');
  const only = (argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;
  const previewDir = (argv.find(a => a.startsWith('--preview=')) || '').split('=')[1] || null;
  const maxMinutes = Number((argv.find(a => a.startsWith('--max-minutes=')) || '').split('=')[1]) || 25;
  const now = new Date();

  const { loadShows, saveShows } = require('./lib/shows-write-guard');
  const { verifyImage, detectEngagementStamp, createRateLimiter } = require('./lib/verify-image');
  const ctx = { sharp: require('sharp'), verifyImage, detectEngagementStamp, rateLimiter: createRateLimiter(15) }; // Gemini Flash RPM, as verify-image.js
  if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set: tour art is only written after Gemini confirms it.'); process.exit(1); }

  const snapshot = loadShows();
  const shows = snapshot.shows;
  const schedules = fs.existsSync(SCHEDULES_PATH) ? JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8')).tours || {} : {};
  const exists = p => fs.existsSync(path.join(PUBLIC_DIR, p));
  const open = shows.filter(s => isTourShow(s) && (only ? s.id === only : s.status !== 'closed'))
    .filter(t => rolesNeeded(t, exists).length);
  const sources = loadImageSources();
  // Point shows.json at own files an earlier run archived but failed to
  // record, before any search (and before backoff can skip the tour).
  let adopted = 0;
  for (const tour of open) {
    const roles = [];
    // The same file checks archive() and vet() apply, so a file damaged or
    // replaced since it was archived is not adopted.
    for (const r of archivedUnreferenced(tour, exists, sources[tour.id])) {
      const abs = path.join(PUBLIC_DIR, `/images/shows/${tour.id}/${r}.webp`);
      const meta = await ctx.sharp(abs).metadata().catch(() => ({}));
      if (isPlaceholderFile(abs) || !rolesForSize(meta.width, meta.height).includes(r)) {
        console.log(`  ${tour.id}: archived ${r} not adopted: placeholder or wrong shape (${meta.width}x${meta.height})`);
        continue;
      }
      roles.push(r);
    }
    if (!roles.length) continue;
    const next = { hero: null, ...(tour.images || {}) };
    for (const r of roles) next[r] = `/images/shows/${tour.id}/${r}.webp`;
    const problems = tourImageProblems({ ...tour, images: next }, shows);
    if (problems.length) { console.log(`  ${tour.id}: archived ${roles.join('+')} not adopted: ${problems.join('; ')}`); continue; }
    console.log(`  ${tour.id}: adopting archived ${roles.join('+')}`);
    adopted++;
    // Set in a dry run too (it never saves), so the search below sees the
    // adopted roles exactly as a real run would.
    tour.images = next;
    if (!dryRun) saveShows(snapshot);
  }
  if (adopted) console.log(`${adopted} tour(s) ${dryRun ? 'would adopt' : 'adopted'} already-archived art`);
  const targets = open.filter(t => rolesNeeded(t, exists).length);
  console.log(`${targets.length} tour(s) need their own art`);
  if (!targets.length) return;

  const { rows, failed } = await fetchListings();
  console.log(`TodayTix: ${rows.length} listings${failed.length ? `, locations failed: ${failed.join(',')}` : ''}`);
  const ttArt = todaytixArt(rows, targets, schedules);

  const attempts = fs.existsSync(ATTEMPTS_PATH) ? JSON.parse(fs.readFileSync(ATTEMPTS_PATH, 'utf8')) : {};
  // Written after every tour, so a killed run keeps the backoff records it made.
  const saveAttempts = () => { if (!dryRun) fs.writeFileSync(ATTEMPTS_PATH, JSON.stringify(attempts, null, 2) + '\n'); };
  // Backoff record after each tour's search (attemptAction has the rules).
  const settle = (id, { need, written, searched, result }) => {
    const action = attemptAction({ need, written, searched, transient: ctx.transient });
    if (action === 'clear') delete attempts[id];
    else if (action === 'backoff') attempts[id] = { triedAt: now.toISOString(), result };
    else if (ctx.transient) console.log(`    ${id}: Gemini errors this run, no backoff`);
    saveAttempts();
  };
  const deadline = Date.now() + maxMinutes * 60000;
  const report = [];
  let changed = 0;
  for (const tour of targets) {
    if (Date.now() > deadline) { report.push({ id: tour.id, result: 'later', why: `--max-minutes=${maxMinutes} reached` }); continue; }
    // A tour with nothing findable is searched again weekly, not daily: each
    // search is up to ~30 Gemini calls (code review).
    if (!only && !retryDue(attempts[tour.id], now)) { report.push({ id: tour.id, result: 'backoff', why: `no art found ${attempts[tour.id].triedAt.slice(0, 10)}; next try after ${RETRY_DAYS} days` }); continue; }
    const need = rolesNeeded(tour, exists);
    ctx.transient = false;
    console.log(`\n${tour.id}: needs ${need.join('+')}`);
    const got = {};
    const tryUrl = async (url, roles, label) => {
      const open = roles.filter(r => need.includes(r) && !got[r]);
      if (!url || !open.length) return;
      const ok = await vet(url, tour, open, ctx, label);
      if (ok) for (const r of ok.roles) if (!got[r]) got[r] = { buffer: ok.buffer, url, label, cropped: ok.cropped };
    };
    for (const c of ttArt[tour.id] || []) {
      if (need.every(r => got[r])) break;
      // Each TodayTix field is cut for its role; a portrait poster also makes
      // a usable thumbnail when the listing has no square.
      await tryUrl(c.thumbnail, ['thumbnail'], `${c.ref} square`);
      await tryUrl(c.poster, ['poster', 'thumbnail'], `${c.ref} poster`);
    }
    const stops = schedules[tour.id]?.stops || [];
    if (!need.every(r => got[r]) && stops.length) {
      const { html } = await fetchSchedule(tour);
      const pages = stopEventPages(html, stops).slice(0, MAX_EVENT_PAGES);
      for (const p of pages) {
        if (need.every(r => got[r])) break;
        let pageHtml;
        try { pageHtml = (await fetchBuffer(p.url, 'text/html')).toString('utf8'); } catch (e) { console.log(`    ${p.url}: ${e.message}`); continue; }
        for (const img of pageImageUrls(pageHtml, p.url).slice(0, 3)) {
          await tryUrl(img, ['poster', 'thumbnail'], `${p.city} ${new URL(p.url).hostname}`);
        }
      }
    }
    const roles = Object.keys(got);
    if (!roles.length) {
      // Back off only after a real search: a tour with no stops yet is tried
      // again the day its schedule arrives (the new tours from 2026-10-06).
      settle(tour.id, { need, searched: stops.length > 0, result: 'none' });
      report.push({ id: tour.id, result: 'none', why: stops.length ? 'no verified art on its TodayTix listings or stop pages' : 'no stop schedule yet (data/tour-schedules.json)' });
      continue;
    }
    // Check the planned paths before any file is written, so a refused tour
    // leaves nothing behind for the commit step (code review).
    const next = { hero: (tour.images || {}).hero || null, ...(tour.images || {}) };
    for (const r of roles) next[r] = `/images/shows/${tour.id}/${r}.webp`;
    const problems = tourImageProblems({ ...tour, images: next }, shows);
    if (problems.length) { settle(tour.id, { need, searched: true, result: 'refused' }); report.push({ id: tour.id, result: 'refused', why: problems.join('; ') }); continue; }
    const written = [];
    for (const r of roles) {
      if (dryRun) {
        // --preview=DIR writes the chosen files there for a look before a real run.
        if (previewDir) { fs.mkdirSync(previewDir, { recursive: true }); await ctx.sharp(got[r].buffer).webp({ quality: 85 }).toFile(path.join(previewDir, `${tour.id}-${r}.webp`)); }
        written.push(r);
        continue;
      }
      // The bytes Gemini checked are the bytes archived.
      if (await archive(tour, r, got[r].buffer, ctx)) written.push(r);
      else next[r] = (tour.images || {})[r] || null;
    }
    if (!written.length) { settle(tour.id, { need, searched: true, result: 'placeholder' }); report.push({ id: tour.id, result: 'none', why: 'chosen files were known placeholders' }); continue; }
    settle(tour.id, { need, written, searched: true, result: 'partial' });
    report.push({ id: tour.id, result: written.join('+'), why: written.map(r => got[r].label).join(' / ') });
    changed++;
    if (dryRun) continue;
    tour.images = next;
    // A crop is recorded under its own key: archive-show-images.js re-downloads
    // images.<role> sources unchecked, and the banner URL is not the crop.
    // The other key goes: a crop that replaces a plain source must not leave
    // that old URL for archive-show-images.js to restore, and vice versa.
    for (const r of written) {
      const entry = { ...(sources[tour.id] || {}) };
      const [key, other] = got[r].cropped ? [`${r}CroppedFrom`, r] : [r, `${r}CroppedFrom`];
      delete entry[other];
      entry[key] = got[r].url;
      sources[tour.id] = entry;
    }
    // Saved per tour, right after its files: a kill between the two leaves at
    // most one tour's files unreferenced, which the next run rewrites.
    saveShows(snapshot);
    saveImageSources(sources);
  }

  console.log('\n=== Tour art ===');
  for (const r of report) console.log(`${r.id.padEnd(55)} ${r.result.padEnd(16)} ${r.why}`);
  if (dryRun) { console.log(`\n(dry run: ${changed} tour(s) would change, nothing written)`); return; }
  saveAttempts();
  console.log(`\n${changed} tour(s) updated`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
