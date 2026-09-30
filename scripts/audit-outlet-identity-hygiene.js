#!/usr/bin/env node
/**
 * Outlet identity hygiene audit (BRO-4419).
 *
 * Reports, and under --strict fails on:
 *   1. LIVE reviews (rows in data/reviews.json) whose URL host is a content-farm
 *      look-alike, a blocked/junk host, or imitates the row's own outlet's domain.
 *   2. Registry aliases that name a known look-alike host (the nysepost root cause).
 *   3. LIVE reviews whose outletId is not in the registry (undecided provisional).
 *   4. Scoreable corpus files (data/review-texts incl. _pending) whose outletId is
 *      not in the registry: a provisional outlet with no decision. Skipped, with a
 *      notice, when the private corpus is not on disk (cloud/worktree).
 *
 * Usage:
 *   node scripts/audit-outlet-identity-hygiene.js [--strict] [--json] [--review-texts=<dir>]
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { isLookalikeContentFarmUrl, findLookalikeHost, hostLabel, LOOKALIKE_CONTENT_FARM_DOMAINS } = require('./lib/outlet-lookalike-guard');
const { normalizeOutlet, isJunkOutlet } = require('./lib/review-normalization');
const { outletRegistryAuditExclusionBranch } = require('./lib/outlet-registry-audit-exclusions');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const asJson = args.includes('--json');
const dirArg = args.find((a) => a.startsWith('--review-texts='));
const textsDir = dirArg ? dirArg.split('=')[1] : path.join(ROOT, 'data', 'review-texts');

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reviews.json'), 'utf8')).reviews || [];

function canonical(id) {
  const lower = String(id || '').toLowerCase();
  if (registry.outlets[lower]) return lower;
  const n = normalizeOutlet(id);
  return n && registry.outlets[n] ? n : null;
}

function hostProblem(outletId, url) {
  if (!url) return null;
  if (isLookalikeContentFarmUrl(url)) return 'content-farm-lookalike';
  if (isBlockedReviewUrl(url)) return 'blocked-host';
  const c = canonical(outletId);
  if (c) {
    const l = findLookalikeHost(c, url, registry);
    if (l.lookalike) return `lookalike:${l.imitates}`;
  }
  return null;
}

// Root cause of the nysepost case: the imitator's own name was registered as an ALIAS of the
// real outlet, so any row labelled 'nysepost' normalised to nypost.
const lookalikeAliases = [];
{
  const farmLabels = new Set([...LOOKALIKE_CONTENT_FARM_DOMAINS].map(hostLabel));
  for (const [id, o] of Object.entries(registry.outlets)) {
    for (const a of o.aliases || []) if (farmLabels.has(String(a).toLowerCase())) lookalikeAliases.push(`${id}:${a}`);
  }
  for (const [a, id] of Object.entries(registry._aliasIndex || {})) {
    if (farmLabels.has(a.toLowerCase())) lookalikeAliases.push(`_aliasIndex ${a}->${id}`);
  }
}

const liveHost = [];
const liveUnregistered = {};
for (const r of reviews) {
  const p = hostProblem(r.outletId, r.url);
  if (p) liveHost.push({ showId: r.showId, outletId: r.outletId, url: r.url, problem: p });
  if (!canonical(r.outletId)) liveUnregistered[r.outletId] = (liveUnregistered[r.outletId] || 0) + 1;
}

const corpusUnregistered = {};
let corpusScanned = false;
let corpusFiles = 0;
if (fs.existsSync(textsDir)) {
  corpusScanned = true;
  for (const show of listShowDirs(textsDir, { silent: true })) {
    const sd = path.join(textsDir, show);
    for (const f of fs.readdirSync(sd)) {
      if (!f.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
      corpusFiles++;
      // Same exclusion rule audit-outlet-registry.js uses: a file the rebuild can never
      // score (non-review, blocked host, wrong production, unscored) needs no registry entry.
      // isJunkOutlet ids are parse garbage (a quote fragment or 'unknown' in the outlet slot), never
      // registered by design; audit-outlet-registry.js reports them under 'skipped as junk'.
      if (d.outletId && !canonical(d.outletId) && !isJunkOutlet(d.outletId) && outletRegistryAuditExclusionBranch(d) === 0) {
        (corpusUnregistered[d.outletId] = corpusUnregistered[d.outletId] || []).push(`${show}/${f}`);
      }
    }
  }
}

const report = {
  liveReviews: reviews.length,
  liveOnBadHost: liveHost,
  lookalikeAliasesInRegistry: lookalikeAliases,
  liveUnregisteredOutlets: liveUnregistered,
  corpusScanned,
  corpusFiles,
  corpusUnregisteredOutlets: Object.fromEntries(Object.entries(corpusUnregistered).map(([k, v]) => [k, v.length])),
};
const failures = lookalikeAliases.length + liveHost.length + Object.keys(liveUnregistered).length + Object.keys(corpusUnregistered).length;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`live reviews scanned: ${reviews.length}`);
  console.log(`live reviews on look-alike/blocked host: ${liveHost.length}`);
  for (const x of liveHost.slice(0, 20)) console.log(`  ${x.showId} ${x.outletId} ${x.url} [${x.problem}]`);
  console.log(`registry aliases naming a look-alike host: ${lookalikeAliases.length}${lookalikeAliases.length ? ' ' + lookalikeAliases.join(', ') : ''}`);
  console.log(`live reviews with unregistered outlet: ${Object.keys(liveUnregistered).length} outlet(s)`);
  if (corpusScanned) {
    console.log(`corpus files scanned: ${corpusFiles}; provisional outlets without a decision: ${Object.keys(corpusUnregistered).length}`);
    for (const [k, v] of Object.entries(corpusUnregistered).slice(0, 20)) console.log(`  ${k} (${v.length}) e.g. ${v[0]}`);
  } else {
    console.log(`corpus not on disk (${textsDir}): provisional-outlet check SKIPPED`);
  }
  console.log(failures === 0 ? 'OK: 0 problems' : `PROBLEMS: ${failures}`);
}
if (strict && failures > 0) process.exit(1);
