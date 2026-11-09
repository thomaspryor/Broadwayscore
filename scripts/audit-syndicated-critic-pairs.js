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
 * BRO-6054 widened it to any show where one named critic ships at two outlets:
 * a pair that syndication-pairs.js does not explain must be listed in
 * scripts/config/same-critic-pairs-allowlist.json as two separate reviews,
 * otherwise it is a double count or a wrong outlet attribution.
 *
 * Usage: node scripts/audit-syndicated-critic-pairs.js [--reviews=PATH] [--allowlist=PATH] [--strict]
 *   --strict   exit 1 when any syndicated or unexplained pair exists
 *   --alert    file/refresh one worker card via owner-alert-router; clears it when clean (BRO-7181)
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
const fs = require('fs');
const path = require('path');
const { getSyndicationPrimaries, criticFileSlug } = require('./lib/syndication-pairs');
const { buildAuditAlert, routeAuditDecisions } = require('./lib/audit-alert');

const DEFAULT_ALLOWLIST = path.join(__dirname, 'config', 'same-critic-pairs-allowlist.json');
const BYLINE_PLACEHOLDER = /^(unknown|staff|n\/a|none|anonymous)$/;

/**
 * @param {Array<{showId:string,outletId:string,criticName?:string}>} reviews
 * @returns {Array<{showId:string,criticName:string,secondary:string,primary:string}>}
 */
function groupOutletsByShowCritic(reviews) {
  const outletsByKey = new Map();
  for (const r of reviews || []) {
    // Slug key folds diacritics, case and spacing so name variants of one critic group together.
    const critic = criticFileSlug(r.criticName);
    if (!r.showId || !r.outletId || !critic) continue;
    const key = `${r.showId}\u0000${critic}`;
    if (!outletsByKey.has(key)) outletsByKey.set(key, { showId: r.showId, criticName: r.criticName, outlets: new Set() });
    outletsByKey.get(key).outlets.add(r.outletId);
  }
  return [...outletsByKey.values()];
}

function findSyndicatedCriticPairs(reviews) {
  const pairs = [];
  for (const { showId, criticName, outlets } of groupOutletsByShowCritic(reviews)) {
    if (outlets.size < 2) continue;
    for (const outlet of outlets) {
      for (const primary of getSyndicationPrimaries(criticName, outlet)) {
        if (outlets.has(primary)) pairs.push({ showId, criticName, secondary: outlet, primary });
      }
    }
  }
  return pairs;
}

const pairKey = (showId, critic, a, b) => [showId, criticFileSlug(critic), ...[a, b].sort()].join('\u0000');

/**
 * Same show + same named critic at 2+ outlets, minus outlets that are a
 * syndication secondary of an outlet also present (findSyndicatedCriticPairs
 * reports those). Every remaining outlet pair must be allowlisted.
 * @param {Array<{showId:string,outletId:string,criticName?:string}>} reviews
 * @param {Array<{showId:string,critic:string,outlets:string[]}>} allowlist
 * @returns {{unexplained:Array<{showId:string,criticName:string,outlets:string[]}>, stale:Array<object>}}
 */
function findUnexplainedSameCriticPairs(reviews, allowlist = []) {
  const allowed = new Map(allowlist.map(e => [pairKey(e.showId, e.critic, e.outlets[0], e.outlets[1]), e]));
  const seen = new Set();
  const unexplained = [];
  for (const { showId, criticName, outlets } of groupOutletsByShowCritic(reviews)) {
    if (outlets.size < 2 || BYLINE_PLACEHOLDER.test(String(criticName).toLowerCase().trim())) continue;
    const kept = [...outlets].filter(o => !getSyndicationPrimaries(criticName, o).some(p => outlets.has(p))).sort();
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const key = pairKey(showId, criticName, kept[i], kept[j]);
        if (allowed.has(key)) seen.add(key);
        else unexplained.push({ showId, criticName, outlets: [kept[i], kept[j]] });
      }
    }
  }
  const stale = [...allowed].filter(([k]) => !seen.has(k)).map(([, e]) => e);
  return { unexplained, stale };
}

const PAIR_ALERT_KEY = 'syndicated-critic-pairs:unexplained';

/**
 * BRO-7181: one worker card for both finding kinds --strict fails on, so a
 * syndicated pair alone can never resolve the card. Pure. Rows carry show id,
 * the published byline and outlet ids only.
 */
function decideSyndicatedPairAlert(pairs, unexplained) {
  const rows = [
    ...(pairs || []).map((p) => `${p.showId}: ${p.criticName} ships as ${p.secondary} and its syndication primary ${p.primary}`),
    ...(unexplained || []).map((u) => `${u.showId}: ${u.criticName} ships as ${u.outlets.join(' and ')}`),
  ];
  return buildAuditAlert({
    conditionKey: PAIR_ALERT_KEY,
    rows,
    title: (n) => `Same-critic outlet pairs: ${n} show/critic pair${n === 1 ? '' : 's'} counted at two outlets`,
    intro: `The daily syndicated critic pair audit found ${rows.length} show/critic pair${rows.length === 1 ? '' : 's'} where one critic's review ships at two outlets that syndication-pairs.js and scripts/config/same-critic-pairs-allowlist.json do not explain. Each is a double count, a wrong attribution, or two real reviews.`,
    hint: 'For each row open both review files. Same article at two outlets: keep the primary, mark the other duplicateOf. Wrong byline: fix criticName. Two separate reviews: add the pair to scripts/config/same-critic-pairs-allowlist.json with the evidence (both URLs, different text). Never allowlist without reading both. Done when node scripts/audit-syndicated-critic-pairs.js --strict exits 0.',
    resolveReason: 'no unexplained same-critic outlet pairs',
  });
}

async function main(argv) {
  if (hasHelpFlag(argv)) {
    console.log('Usage:\n  node scripts/audit-syndicated-critic-pairs.js [--reviews=PATH] [--allowlist=PATH] [--strict] [--alert]\n  --alert      file/refresh a worker card via owner-alert-router (BRO-7181)\n  --strict     exit 1 when a show ships one critic at an outlet and its syndication primary,\n               or at two outlets the allowlist does not name as separate reviews\n  --help, -h   print this usage and exit');
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
  const allowArg = argv.find(a => a.startsWith('--allowlist='));
  const allowlist = JSON.parse(fs.readFileSync(allowArg ? allowArg.split('=')[1] : DEFAULT_ALLOWLIST, 'utf8')).pairs;
  const { unexplained, stale } = findUnexplainedSameCriticPairs(reviews, allowlist);
  console.log(`[syndicated-critic-pairs] ${unexplained.length} same-critic outlet pair(s) not explained by syndication or the allowlist`);
  for (const u of unexplained) {
    console.log(`::warning::${u.showId}: ${u.criticName} ships as ${u.outlets.join(' and ')} (double count, wrong attribution, or allowlist it)`);
  }
  if (stale.length) console.log(`[syndicated-critic-pairs] info: ${stale.length} allowlist entr${stale.length === 1 ? 'y no longer matches' : 'ies no longer match'}: ${stale.map(e => `${e.showId}/${e.critic}`).join(', ')}`);
  if (argv.includes('--alert')) await routeAuditDecisions(decideSyndicatedPairAlert(pairs, unexplained), 'audit-syndicated-critic-pairs');
  return (pairs.length || unexplained.length) && argv.includes('--strict') ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`audit-syndicated-critic-pairs: ${err.stack || err.message}`);
    process.exitCode = 3;
  });
}

module.exports = { findSyndicatedCriticPairs, findUnexplainedSameCriticPairs, decideSyndicatedPairAlert, PAIR_ALERT_KEY };
