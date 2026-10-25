#!/usr/bin/env node
/**
 * worker-firing-stats.js — BRO-6087 RECHECK. Average Claude-lane claims per board-workers firing.
 *
 *   node scripts/worker-firing-stats.js --min-avg 3.0 [--hours 72]
 *
 * Exit codes: 0 = at/above the bar, 1 = below it, 2 = bad usage, 3 = Linear unreadable
 * (unverifiable, not failed; same convention as check-linear-drain-throughput.js).
 * Baseline 2026-10-20..23: 2.69 per firing against a cap of 4.
 */
const { firingStats, CLAIM_CAP } = require('./lib/worker-firing-stats.js');

async function main(argv) {
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const minAvg = Number(arg('--min-avg', NaN));
  const hours = Number(arg('--hours', 72));
  if (!Number.isFinite(minAvg) || minAvg <= 0 || !Number.isFinite(hours) || hours <= 0) {
    console.error('usage: node scripts/worker-firing-stats.js --min-avg <n> [--hours <n>]');
    return 2;
  }
  let comments;
  try {
    const client = require('./lib/linear-client.js');
    const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();
    // One query per model: "Worker model:" alone would also match the ~9 Codex claims per firing.
    const parts = await Promise.all(['sonnet', 'opus'].map((m) => client.listRecentCommentsContaining({ sinceIso, text: `Worker model: ${m}`, max: 2000 })));
    comments = parts.flat();
  } catch (err) {
    console.error(`could not read Linear: ${err.message}`);
    return 3;
  }
  const s = firingStats(comments, { windowHours: hours });
  if (!s.firings) { console.error('no complete firings with Claude claims in the window: unverifiable'); return 3; }
  console.log(`firings with Claude claims: ${s.firings}, claims: ${s.claims}, avg ${s.avg.toFixed(2)} (cap ${CLAIM_CAP}), min ${minAvg}`);
  console.log(`claims per firing: ${JSON.stringify(s.dist)}; stopped early with 60+ min left: ${s.early} (${(s.ratio * 100).toFixed(0)}%)`);
  return s.avg >= minAvg ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 3; });
module.exports = { main };
