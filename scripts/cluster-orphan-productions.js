#!/usr/bin/env node
/**
 * BRO-7929: cluster orphaned wrongProduction reviews into proposed missing
 * productions, and gate the orphan-cluster count.
 *
 * Orphan = wrongProduction review dated in the last 2 years whose date is
 * covered by NO same-title show in shows.json (the production was never added).
 * Clusters group orphans by title + market + 120-day date gap. Each proposal
 * must be validated (scripts/validate-show-venue.js + Playbill / venue page)
 * before the show entry is added; then scripts/apply-orphan-production.js
 * --rehome rehomes the reviews onto the new sibling production.
 *
 * Usage:
 *   node scripts/cluster-orphan-productions.js [--top N] [--min N] [--json PATH]
 *   node scripts/cluster-orphan-productions.js --gate             # exit 1 on a cluster not in baseline / grown
 *   node scripts/cluster-orphan-productions.js --update-baseline  # freeze current clusters (supervised)
 * Wired into scripts/check-corpus-drift.js AUDITS (non-blocking; BRO-3535 precedent).
 * Baseline: data/audit/orphan-production-clusters-baseline.json (ratchet: only shrinks).
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { listShowDirs, corpusDirProblem } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const L = require('./lib/orphan-production-clusters');

const ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'data', 'audit', 'orphan-production-clusters-baseline.json');
const ARGV = process.argv.slice(2);
if (hasHelpFlag(ARGV)) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, ''));
  process.exit(0);
}
const arg = (n, d) => { const i = ARGV.indexOf(n); return i >= 0 ? ARGV[i + 1] : d; };
const GATE = ARGV.includes('--gate');
const UPDATE = ARGV.includes('--update-baseline');
const TOP = +arg('--top', 25);
const MIN = +arg('--min', 3); // clusters below this are stray single reviews, not a missing production
const JSON_OUT = arg('--json', null);

function collect() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const outletsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
  const outlets = outletsRaw.outlets || outletsRaw;
  const dir = resolveReviewTextsDir();
  const problem = corpusDirProblem(dir);
  if (problem) { console.error(`SKIP: ${problem}`); process.exit(2); }
  const now = Date.now();
  const ctx = { byTitle: L.indexShows(shows), cutoffMs: now - 2 * 365 * L.DAY, now };
  const showById = new Map(shows.map((s) => [s.id, s]));
  const orphans = [];
  for (const id of listShowDirs(dir, { silent: true, skipHolding: true })) {
    const show = showById.get(id);
    if (!show) continue;
    let files;
    try { files = fs.readdirSync(path.join(dir, id)).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, id, f), 'utf8')); } catch { continue; }
      const c = L.orphanCandidate(j, show, ctx);
      if (c) orphans.push({ hostId: id, title: show.title, file: f, ms: c.ms, outletId: j.outletId, market: L.reviewMarket(j, outlets) });
    }
  }
  return orphans;
}

// Existing ids, so a proposal for a second same-year production never reuses one (proposeEntry takes -N).
const EXISTING_IDS = (() => { const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')); return new Set((Array.isArray(r) ? r : r.shows).map((s) => s.id)); })();
const orphans = collect();
const clusters = L.clusterOrphans(orphans);
const gated = clusters.filter((c) => c.count >= MIN);
// Gate keys are title|market totals, NOT per-cluster ids: a cluster id embeds its first review
// month, which shifts as the rolling 2-year cutoff drops old reviews (false red with no data change).
const keyTotals = {};
for (const c of gated) keyTotals[c.key] = (keyTotals[c.key] || 0) + c.count;
const summary = { orphanReviews: orphans.length, clusters: clusters.length, clustersAtLeastMin: gated.length, min: MIN, reviewsInGatedClusters: gated.reduce((a, c) => a + c.count, 0) };

if (UPDATE) {
  const out = { generatedAt: new Date().toISOString(), summary, clusters: keyTotals };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`baseline written: ${Object.keys(keyTotals).length} title/market keys, ${summary.reviewsInGatedClusters} reviews`);
  process.exit(0);
}

console.log(`orphan wrongProduction reviews: ${summary.orphanReviews}; clusters: ${summary.clusters}; clusters >=${MIN}: ${summary.clustersAtLeastMin} (${summary.reviewsInGatedClusters} reviews)`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, proposals: gated.map((c) => ({ id: c.id, ...L.proposeEntry(c, EXISTING_IDS) })) }, null, 2));
if (!GATE) {
  for (const c of gated.slice(0, TOP)) {
    const p = L.proposeEntry(c, EXISTING_IDS);
    console.log(`${String(c.count).padStart(3)}  ${c.market.padEnd(9)} ${p.proposedId}  ${p.estimatedOpeningNoLaterThan}..${p.lastReviewDate}  hosts=${Object.entries(c.hosts).map(([h, n]) => `${h}:${n}`).slice(0, 3).join(',')}`);
  }
  process.exit(0);
}

let base = {};
try { base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).clusters || {}; } catch { console.error('no baseline; run --update-baseline'); process.exit(1); }
const bad = Object.entries(keyTotals).filter(([k, n]) => base[k] === undefined || n > base[k]).map(([k, n]) => ({ id: k, count: n, hosts: Object.assign({}, ...gated.filter((c) => c.key === k).map((c) => c.hosts)) }));
if (bad.length) {
  console.error(`FAIL: ${bad.length} orphan production cluster(s) new or grown vs baseline (a production is missing from shows.json):`);
  for (const c of bad.slice(0, 20)) console.error(`  ${c.id} count=${c.count} baseline=${base[c.id] ?? 'none'} hosts=${Object.keys(c.hosts).join(',')}`);
  process.exit(1);
}
console.log(`PASS: no new/grown orphan clusters (${Object.keys(keyTotals).length} title/market keys <= baseline ${Object.keys(base).length})`);
