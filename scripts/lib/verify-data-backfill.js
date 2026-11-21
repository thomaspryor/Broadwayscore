#!/usr/bin/env node
/**
 * Read-only acceptance for show, image and scored-review backfills (BRO-5266).
 * Usage: node scripts/lib/verify-data-backfill.js --show=ID[,ID] [--images] [--reviews=N] [--type=TYPE]
 * --type (BRO-6506): every listed show must carry that type (a type correction,
 * where "show found" alone passed before the fix landed).
 * A city-hub slug from data/city-hubs.json (e.g. washington-dc) with --images checks that
 * hub's dual-model image audit instead (BRO-7265): no confirmed `image:` item left open in
 * data/audit/city-hub-dual/<hub>/triage.json or its scorecard.json, and every item marked
 * fixed has a real poster on disk. Untriaged image flags print as warnings.
 * Exit: 0 expectations met, 1 unmet, 2 invalid arguments or unreadable data.
 * Live state belongs in this on-demand probe, never in blocking unit tests.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasRealImage, imageOnDisk } = require('./show-images.js');
const { hasHelpFlag } = require('./cli-help.js');

// BRO-6716: a card filed `--show=all` meaning "every show". The id regex accepted it as
// a literal id, so the check could only ever print "FAIL all: show missing" and the
// card bounced. Selector words are never show ids; refuse them as invalid arguments.
const RESERVED_SELECTOR_IDS = new Set(['all', 'any', 'every', 'none']);

function parseArgs(args) {
  const command = args.join(' ');
  const match = /^--show=([a-z0-9]+(?:-[a-z0-9]+)*(?:,[a-z0-9]+(?:-[a-z0-9]+)*)*)( --images)?(?: --reviews=([1-9]\d*))?(?: --type=(musical|play|special|opera))?$/.exec(command);
  if (!match) throw new Error('Expected --show=ID[,ID] [--images] [--reviews=N] [--type=musical|play|special|opera]');
  const minReviews = match[3] ? Number(match[3]) : 0;
  if (!Number.isSafeInteger(minReviews)) throw new Error('Review minimum must be a safe integer');
  const reserved = match[1].split(',').filter(id => RESERVED_SELECTOR_IDS.has(id));
  if (reserved.length) throw new Error(`--show takes explicit show ids; "${reserved[0]}" is not one (for a whole window use node scripts/slow-market-grade.js --opened-from=YYYY-MM-DD --opened-to=YYYY-MM-DD --check-gaps)`);
  return { showIds: [...new Set(match[1].split(','))], images: !!match[2], minReviews, type: match[4] || null };
}

function verifyBackfill(shows, reviews, options, imageCheck = hasRealImage) {
  return options.showIds.map(id => {
    const show = shows.find(s => s.id === id);
    const problems = [];
    // reviews.json already contains rebuilt rows. Do not reimplement source
    // exclusion/override rules here; this probe checks the aggregate outcome.
    const count = reviews.filter(r => r.showId === id && Number.isFinite(r.assignedScore)).length;
    if (!show) problems.push('show missing');
    if (show && options.images && !imageCheck(show)) problems.push('usable image missing');
    if (show && options.type && show.type !== options.type) problems.push(`type ${show.type || '(none)'} != ${options.type}`);
    if (count < options.minReviews) problems.push(`scored reviews ${count} < ${options.minReviews}`);
    return { id, ok: problems.length === 0, scoredReviews: count, problems };
  });
}

/** Image items of one city hub's dual-model audit (BRO-7265). Pure apart from the poster predicate. */
function verifyHubImages(hub, triage, scorecard, shows, posterCheck = imageOnDisk) {
  const problems = [];
  const items = (triage && triage.items) || {};
  const byId = new Map(shows.map((s) => [s.id, s]));
  const triaged = new Set();
  for (const [key, item] of Object.entries(items)) {
    if (!key.startsWith('image:')) continue;
    triaged.add(key);
    if (!item || item.verdict !== 'confirmed') continue;
    const id = key.slice('image:'.length);
    if (item.status !== 'fixed') { problems.push(`${key} still open`); continue; }
    const show = byId.get(id);
    if (!show || !posterCheck(show.images && show.images.poster)) problems.push(`${key} marked fixed but no poster on disk`);
  }
  const listed = ((scorecard && scorecard.remaining) || []).filter((r) => String(r && r.item).startsWith('image:'));
  if (listed.length && !problems.some((p) => p.endsWith('still open'))) problems.push(`scorecard.json still lists ${listed.length} open image item(s); rerun audit-city-hub-dual-model.js report --city=${hub} --write`);
  const untriaged = [...new Set(((scorecard && scorecard.flags) || []).filter((f) => f && f.kind === 'image').map((f) => `image:${f.id}`))].filter((k) => !triaged.has(k));
  return { id: hub, ok: problems.length === 0, problems, warnings: untriaged.map((k) => `${k} flagged, not triaged`) };
}

function loadHubSlugs(root) {
  try { return new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'data/city-hubs.json'), 'utf8')).hubs || {})); } catch { return new Set(); }
}

function main(args = process.argv.slice(2), root = path.join(__dirname, '..', '..')) {
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/lib/verify-data-backfill.js --show=ID[,ID] [--images] [--reviews=N] [--type=TYPE]');
    return 0;
  }
  try {
    const options = parseArgs(args);
    const rawShows = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'));
    const shows = Array.isArray(rawShows) ? rawShows : rawShows.shows;
    const rawReviews = options.minReviews
      ? JSON.parse(fs.readFileSync(path.join(root, 'data/reviews.json'), 'utf8')) : [];
    const reviews = Array.isArray(rawReviews) ? rawReviews : rawReviews.reviews;
    if (!Array.isArray(shows) || !Array.isArray(reviews)) throw new Error('Expected shows and reviews arrays');
    const hubSlugs = loadHubSlugs(root);
    const hubs = options.showIds.filter((id) => hubSlugs.has(id));
    if (hubs.length && (!options.images || options.minReviews || options.type)) throw new Error(`city hub ${hubs[0]} takes --images only (its dual-model image audit)`);
    const hubResults = hubs.map((hub) => {
      const dir = path.join(root, 'data/audit/city-hub-dual', hub);
      const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return verifyHubImages(hub, read('triage.json'), read('scorecard.json'), shows, (p) => imageOnDisk(p, { publicDir: path.join(root, 'public') }));
    });
    for (const r of hubResults) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}: ${r.ok ? 'no open image items in the hub audit' : r.problems.join('; ')}`);
      for (const w of r.warnings) console.log(`  WARN ${w}`);
    }
    const results = verifyBackfill(shows, reviews, { ...options, showIds: options.showIds.filter((id) => !hubSlugs.has(id)) });
    for (const r of results) {
      const passed = options.minReviews ? `${r.scoredReviews} scored reviews` : 'show found';
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}: ${r.ok ? `${passed}${options.images ? ', usable image found' : ''}${options.type ? `, type ${options.type}` : ''}` : r.problems.join('; ')}`);
    }
    return results.every(r => r.ok) && hubResults.every(r => r.ok) ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { parseArgs, verifyBackfill, verifyHubImages, main, RESERVED_SELECTOR_IDS };
