#!/usr/bin/env node
/**
 * Read-only acceptance for show, image and scored-review backfills (BRO-5266).
 * Usage: node scripts/lib/verify-data-backfill.js --show=ID[,ID] [--images] [--reviews=N] [--type=TYPE]
 * --type (BRO-6506): every listed show must carry that type (a type correction,
 * where "show found" alone passed before the fix landed).
 * Exit: 0 expectations met, 1 unmet, 2 invalid arguments or unreadable data.
 * Live state belongs in this on-demand probe, never in blocking unit tests.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasRealImage } = require('./show-images.js');
const { hasHelpFlag } = require('./cli-help.js');

function parseArgs(args) {
  const command = args.join(' ');
  const match = /^--show=([a-z0-9]+(?:-[a-z0-9]+)*(?:,[a-z0-9]+(?:-[a-z0-9]+)*)*)( --images)?(?: --reviews=([1-9]\d*))?(?: --type=(musical|play|special|opera))?$/.exec(command);
  if (!match) throw new Error('Expected --show=ID[,ID] [--images] [--reviews=N] [--type=musical|play|special|opera]');
  const minReviews = match[3] ? Number(match[3]) : 0;
  if (!Number.isSafeInteger(minReviews)) throw new Error('Review minimum must be a safe integer');
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
    const results = verifyBackfill(shows, reviews, options);
    for (const r of results) {
      const passed = options.minReviews ? `${r.scoredReviews} scored reviews` : 'show found';
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}: ${r.ok ? `${passed}${options.images ? ', usable image found' : ''}${options.type ? `, type ${options.type}` : ''}` : r.problems.join('; ')}`);
    }
    return results.every(r => r.ok) ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { parseArgs, verifyBackfill, main };
