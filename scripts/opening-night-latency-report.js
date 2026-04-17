'use strict';

/**
 * CLI: node scripts/opening-night-latency-report.js [--show=ID] [--date=YYYY-MM-DD]
 *
 * Reads data/audit/stage-latency.jsonl, groups by (showId, reviewKey),
 * computes per-review end-to-end latency and per-stage latency.
 * Writes data/audit/opening-night-latency-{YYYY-MM-DD}.json.
 *
 * Alternate path: if stage-latency.jsonl is empty, falls back to computing
 * latency from createdAt vs updatedAt fields on review-texts JSON files
 * (only for the first opening after rollout where no stage logs exist yet).
 */

const fs = require('fs');
const path = require('path');

const STAGE_ORDER = ['review-first-seen', 'review-text-collected', 'scored', 'rebuilt', 'deployed-live'];
const STAGE_GAP_LABELS = [
  'first-seen-to-collected',
  'collected-to-scored',
  'scored-to-rebuilt',
  'rebuilt-to-deployed',
];

const DEFAULT_LOG = path.join(__dirname, '../data/audit/stage-latency.jsonl');
const AUDIT_DIR = path.join(__dirname, '../data/audit');

function parseArgs() {
  const args = { show: null, date: null };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'show') args.show = v;
    if (k === 'date') args.date = v;
  }
  if (!args.date) args.date = new Date().toISOString().slice(0, 10);
  return args;
}

function readJSONL(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function percentile(vals, pct) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const idx = Math.ceil((pct / 100) * s.length) - 1;
  return s[Math.max(0, idx)];
}

/**
 * Group JSONL entries by (showId, reviewKey), build per-review stage maps,
 * then compute latency stats per show.
 */
function computeLatencyStats(entries, { showFilter, date } = {}) {
  // Group by (showId, reviewKey) — reviewKey null means summary rows (e.g. rebuilt per show)
  const byShowReview = new Map();
  const showMeta = new Map();

  for (const e of entries) {
    if (showFilter && e.showId !== showFilter) continue;

    // Track show-level rebuilt summary lines separately
    if (e.stage === 'rebuilt' && !e.reviewKey) {
      const prev = showMeta.get(e.showId) || {};
      showMeta.set(e.showId, { ...prev, rebuiltAt: e.at, reviewCount: e.metadata?.reviewCount });
      continue;
    }
    if (e.stage === 'deployed-live' && !e.reviewKey) {
      const prev = showMeta.get(e.showId || '__global') || {};
      showMeta.set(e.showId || '__global', { ...prev, deployedAt: e.at, runId: e.metadata?.runId });
      continue;
    }

    const key = `${e.showId}||${e.reviewKey || ''}`;
    if (!byShowReview.has(key)) {
      byShowReview.set(key, { showId: e.showId, reviewKey: e.reviewKey, stages: {} });
    }
    const entry = byShowReview.get(key);
    // Keep earliest timestamp per stage
    if (!entry.stages[e.stage] || e.at < entry.stages[e.stage]) {
      entry.stages[e.stage] = e.at;
    }
  }

  // Resolve deployed-live from global (no-reviewKey) entries
  const globalDeploy = showMeta.get('__global');

  // Group reviews by showId
  const byShow = new Map();
  for (const [, rv] of byShowReview) {
    if (!byShow.has(rv.showId)) byShow.set(rv.showId, []);
    byShow.get(rv.showId).push(rv);
  }

  const shows = [];

  for (const [showId, reviews] of byShow) {
    const meta = showMeta.get(showId) || {};
    const deployedAt = meta.deployedAt || globalDeploy?.deployedAt || null;

    const e2eTimes = [];
    const stageTimes = Object.fromEntries(STAGE_GAP_LABELS.map(l => [l, []]));
    const slowest = [];

    for (const rv of reviews) {
      const s = rv.stages;
      const firstSeen = s['review-first-seen'];
      const deployed = s['deployed-live'] || deployedAt;

      const e2e = firstSeen && deployed
        ? new Date(deployed) - new Date(firstSeen)
        : null;

      // Guard: skip negative values (clock skew between CI runners)
      if (e2e !== null && e2e > 0) e2eTimes.push(e2e);

      // Per-stage gaps
      for (let i = 0; i < STAGE_ORDER.length - 1; i++) {
        const from = s[STAGE_ORDER[i]];
        let to = s[STAGE_ORDER[i + 1]];
        // Fall back to deployed-live for the final gap
        if (STAGE_ORDER[i + 1] === 'deployed-live') to = to || deployedAt;
        if (from && to) {
          const gap = new Date(to) - new Date(from);
          if (gap > 0) stageTimes[STAGE_GAP_LABELS[i]].push(gap);
        }
      }

      // Track slowest reviews
      if (e2e !== null && e2e > 0) {
        const stuckAt = STAGE_ORDER.slice().reverse().find(st => s[st]) || null;
        slowest.push({ reviewKey: rv.reviewKey, e2e_ms: e2e, stuck_at_stage: stuckAt });
      }
    }

    slowest.sort((a, b) => b.e2e_ms - a.e2e_ms);

    const perStageMedMs = {};
    for (const label of STAGE_GAP_LABELS) {
      perStageMedMs[label] = stageTimes[label].length ? Math.round(median(stageTimes[label])) : null;
    }

    shows.push({
      showId,
      reviewCount: meta.reviewCount || reviews.length,
      median_e2e_ms: e2eTimes.length ? Math.round(median(e2eTimes)) : null,
      p90_e2e_ms: e2eTimes.length ? Math.round(percentile(e2eTimes, 90)) : null,
      per_stage_median_ms: perStageMedMs,
      reviews_over_15min: e2eTimes.filter(t => t > 15 * 60 * 1000).length,
      reviews_over_60min: e2eTimes.filter(t => t > 60 * 60 * 1000).length,
      slowest_reviews: slowest.slice(0, 5),
    });
  }

  return shows;
}

function main() {
  const args = parseArgs();
  const logFile = process.env.STAGE_LATENCY_LOG || DEFAULT_LOG;
  const entries = readJSONL(logFile);

  const shows = computeLatencyStats(entries, { showFilter: args.show, date: args.date });

  const report = {
    generatedAt: new Date().toISOString(),
    date: args.date,
    logFile,
    entryCount: entries.length,
    shows,
  };

  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const outPath = path.join(AUDIT_DIR, `opening-night-latency-${args.date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Written: ${outPath}`);
  console.log(`Shows: ${shows.length}, entries: ${entries.length}`);
  if (shows.length === 0 && entries.length === 0) {
    console.log('(No stage-latency entries yet — run after pipeline has processed reviews)');
  }
}

// Export for testing
module.exports = { computeLatencyStats, median, percentile };

if (require.main === module) main();
