#!/usr/bin/env node
'use strict';
/**
 * audit-syndicated-critic-pairs.js (BRO-6046): published reviews.json rows where
 * one critic's review of a show ships twice, once at an outlet and once at that
 * outlet's syndication primary (per-critic pair or publishing group, e.g. an
 * Observer column also filed as "guardian"). The rebuild's syndication shield
 * should never let both through; a hit means a primary/secondary relationship
 * the shield does not know about yet, or a shield regression.
 *
 * Usage: node scripts/audit-syndicated-critic-pairs.js [--reviews=PATH] [--strict]
 *   --strict   exit 1 when any pair exists
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
const fs = require('fs');
const path = require('path');
const { getSyndicationPrimaries } = require('./lib/syndication-pairs');

/**
 * @param {Array<{showId:string,outletId:string,criticName?:string}>} reviews
 * @returns {Array<{showId:string,criticName:string,secondary:string,primary:string}>}
 */
function findSyndicatedCriticPairs(reviews) {
  const outletsByKey = new Map();
  for (const r of reviews || []) {
    const critic = String(r.criticName || '').toLowerCase().trim();
    if (!r.showId || !r.outletId || !critic) continue;
    const key = `${r.showId}\u0000${critic}`;
    if (!outletsByKey.has(key)) outletsByKey.set(key, { showId: r.showId, criticName: r.criticName, outlets: new Set() });
    outletsByKey.get(key).outlets.add(r.outletId);
  }
  const pairs = [];
  for (const { showId, criticName, outlets } of outletsByKey.values()) {
    if (outlets.size < 2) continue;
    for (const outlet of outlets) {
      for (const primary of getSyndicationPrimaries(criticName, outlet)) {
        if (outlets.has(primary)) pairs.push({ showId, criticName, secondary: outlet, primary });
      }
    }
  }
  return pairs;
}

function main(argv) {
  if (hasHelpFlag(argv)) {
    console.log('Usage:\n  node scripts/audit-syndicated-critic-pairs.js [--reviews=PATH] [--strict]\n  --strict     exit 1 when a show ships one critic at an outlet and its syndication primary\n  --help, -h   print this usage and exit');
    return 0;
  }
  const reviewsArg = argv.find(a => a.startsWith('--reviews='));
  const file = reviewsArg ? reviewsArg.split('=')[1] : path.join(__dirname, '..', 'data', 'reviews.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reviews = Array.isArray(doc) ? doc : doc.reviews;
  const pairs = findSyndicatedCriticPairs(reviews);
  console.log(`[syndicated-critic-pairs] ${pairs.length} show+critic pair(s) shipped at both a secondary outlet and its primary`);
  for (const p of pairs) {
    console.log(`::warning::${p.showId}: ${p.criticName} ships as ${p.secondary} and ${p.primary}`);
  }
  return pairs.length && argv.includes('--strict') ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { findSyndicatedCriticPairs };
