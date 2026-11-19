#!/usr/bin/env node
/**
 * Apply hand-verified regional key art (BRO-7265).
 *
 *   node scripts/apply-verified-key-art.js --manifest=<file.json> [--dry-run] [--actions-out=<file.json>]
 *
 * For regional shows the automatic chain (fetch-show-images-auto.js ->
 * fetchFromRegionalVenue) finds nothing when the producing company is not the
 * venue, the page has no og:image, or the venue is not in
 * scripts/lib/regional-image-venues.js. A person then finds the production's
 * own page (theatre/producer site, its ticket page, or its theatreWashington
 * listing) and records it in a manifest:
 *
 *   { "entries": [ { "showId": "...", "page": "https://<production page>",
 *                    "image": "https://<art shown on that page>", "note": "..." } ] }
 *
 * Every entry is a person's verdict that the image is THIS production's key art
 * (title, company and dates checked against the show). This script never
 * searches or guesses: it downloads exactly the listed image, writes the same
 * poster/thumbnail/hero formats as the automatic regional path
 * (scripts/lib/regional-key-art.js), records the page as the files' source in
 * data/image-sources.json, and writes the shows.json `images` data-edit actions
 * (private data) for `node scripts/new-fix-plan.js --actions=<file>`.
 * Exit: 0 all applied, 1 an entry was refused or failed, 2 bad arguments/data.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { regionalLocalPaths, writeRegionalFormats } = require('./lib/regional-key-art');

const ROOT = path.join(__dirname, '..');
const USAGE = 'Usage: node scripts/apply-verified-key-art.js --manifest=<file.json> [--dry-run] [--actions-out=<file.json>]';
const MIN_WIDTH = 400; // the automatic regional path's floor (fetchFromRegionalVenue)

/** Why an entry cannot be applied, or null. Pure. */
function entryProblem(entry, show) {
  if (!entry || typeof entry !== 'object') return 'entry is not an object';
  if (!show) return `show ${entry.showId} not in shows.json`;
  if (show.category !== 'regional') return `${show.id} is ${show.category || 'uncategorised'}, not regional`;
  for (const k of ['page', 'image']) {
    if (typeof entry[k] !== 'string' || !/^https:\/\/\S+$/i.test(entry[k])) return `${k} must be an https URL`;
  }
  const rejected = Array.isArray(show.rejectedImageUrls) ? show.rejectedImageUrls : [];
  if (rejected.includes(entry.image) || rejected.includes(entry.page)) return 'image or page is in the show\'s rejectedImageUrls';
  return null;
}

/** The shows.json images data-edit for one show, or null when its paths already match. Pure. */
function imagesAction(show, note) {
  const newValue = regionalLocalPaths(show.id);
  const oldValue = show.images && typeof show.images === 'object' ? show.images : null;
  if (oldValue && ['poster', 'thumbnail', 'hero'].every((k) => oldValue[k] === newValue[k])) return null;
  return {
    type: 'data-edit', file: 'shows.json', showId: show.id, field: 'images', oldValue, newValue,
    description: `${show.id}: key art from the production's own page (${note || 'hand-verified'}), BRO-7265`,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const get = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  const manifestPath = get('manifest');
  if (!manifestPath) { console.error(USAGE); return 2; }
  const dryRun = argv.includes('--dry-run');
  let manifest; let shows;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
    shows = Array.isArray(raw) ? raw : raw.shows;
  } catch (e) { console.error(e.message); return 2; }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!entries.length) { console.error('manifest has no entries'); return 2; }

  const sharp = require('sharp');
  const { recordImageSource } = require('./lib/image-sources-store');
  const byId = new Map(shows.map((s) => [s.id, s]));
  const actions = [];
  let failed = 0;
  for (const entry of entries) {
    const show = byId.get(entry && entry.showId);
    const problem = entryProblem(entry, show);
    if (problem) { console.log(`REFUSED ${entry && entry.showId}: ${problem}`); failed++; continue; }
    try {
      const res = await fetch(entry.image, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard key-art)' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`image HTTP ${res.status}`);
      if (!/^https:\/\//i.test(res.url || entry.image)) throw new Error(`redirected off https: ${res.url}`);
      if (!/^image\//i.test(res.headers.get('content-type') || '')) throw new Error(`not an image: ${res.headers.get('content-type')}`);
      if (Number(res.headers.get('content-length') || 0) > 25 * 1024 * 1024) throw new Error('image over 25MB');
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 25 * 1024 * 1024) throw new Error('image over 25MB');
      const meta = await sharp(buffer).metadata();
      if (!meta.width || meta.width < MIN_WIDTH) throw new Error(`image too small (${meta.width}px < ${MIN_WIDTH})`);
      if (!dryRun) {
        await writeRegionalFormats(sharp, buffer, path.join(ROOT, 'public', 'images', 'shows', show.id));
        recordImageSource(show.id, ['poster', 'thumbnail', 'hero'], entry.page);
      }
      const action = imagesAction(show, entry.note);
      if (action) actions.push(action);
      console.log(`${dryRun ? 'WOULD APPLY' : 'APPLIED'} ${show.id} (${meta.width}x${meta.height}) from ${entry.page}${action ? '' : ' [paths unchanged]'}`);
    } catch (e) {
      console.log(`FAILED ${show.id}: ${e.message}`);
      failed++;
    }
  }
  const out = get('actions-out');
  if (out && !dryRun) fs.writeFileSync(path.resolve(out), JSON.stringify(actions, null, 2) + '\n');
  console.log(`${actions.length} images edit(s) for the fix plan${out ? ` -> ${out}` : ''}; ${failed} refused/failed`);
  return failed ? 1 : 0;
}

if (require.main === module) main().then((c) => { process.exitCode = c; });
module.exports = { entryProblem, imagesAction, main };
