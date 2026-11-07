'use strict';
/**
 * Stale-baseline detection shared by the baseline-diff audits (BRO-5315).
 *
 * A baseline entry whose underlying violation was fixed stays in the baseline
 * and silently re-excuses the same regression later (BRO-2257: a deleted
 * validate-data.js line's broadway-category-predicate entry kept excusing a
 * later hit). Every baseline-diff audit therefore reports baseline keys that
 * have no live violation behind them, and its `--check-stale` mode exits 1 on
 * any, which tests/unit/audit-stale-baseline-detection.test.mjs asserts.
 *
 * Keys are compared as a MULTISET: a key the baseline lists twice but the live
 * scan finds once has one stale copy. For set-shaped baselines (each key at
 * most once) this degenerates to a plain set difference.
 */

function countKeys(keys) {
  const counts = new Map();
  for (const k of keys || []) counts.set(k, (counts.get(k) || 0) + 1);
  return counts;
}

/**
 * @param {Iterable<string>|Map<string,number>} baselineKeys keys (or key→count map) the baseline excuses
 * @param {Iterable<string>|Map<string,number>} liveKeys keys (or key→count map) the live scan found
 * @returns {string[]} sorted stale keys, one entry per surplus baseline copy
 */
function computeStaleBaselineKeys(baselineKeys, liveKeys) {
  const base = baselineKeys instanceof Map ? baselineKeys : countKeys(baselineKeys);
  const live = liveKeys instanceof Map ? liveKeys : countKeys(liveKeys);
  const stale = [];
  for (const [key, n] of base) {
    const surplus = n - (live.get(key) || 0);
    for (let i = 0; i < surplus; i++) stale.push(key);
  }
  return stale.sort();
}

/**
 * Print the stale report. Returns the stale count so callers can exit on it.
 * @param {string[]} stale
 * @param {{ label: string, updateCmd: string, log?: (s: string) => void, limit?: number }} opts
 */
function reportStaleBaseline(stale, { label, updateCmd, log = console.log, limit = 50 }) {
  if (!stale.length) {
    log(`✓ ${label}: no stale baseline entries.`);
    return 0;
  }
  log(`⚠️  ${label}: ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'} (no live violation behind them):`);
  for (const k of stale.slice(0, limit)) log(`   - ${k}`);
  if (stale.length > limit) log(`   … and ${stale.length - limit} more`);
  log(`   A stale entry would silently re-excuse the same regression later. Prune: ${updateCmd}`);
  return stale.length;
}

/**
 * Drop exactly the stale entries from a baseline array, one entry per stale
 * key occurrence (multiset-safe), keeping order. Unlike a full
 * --update-baseline rewrite this never ADDS the live scan's new violations.
 * @template T
 * @param {T[]} entries
 * @param {(e: T) => string} keyOf
 * @param {string[]} staleKeys
 * @returns {T[]}
 */
function pruneStaleEntries(entries, keyOf, staleKeys) {
  const budget = countKeys(staleKeys);
  const kept = [];
  // Drop from the END so the earliest-listed copies of a duplicated key survive.
  for (let i = (entries || []).length - 1; i >= 0; i--) {
    const k = keyOf(entries[i]);
    const n = budget.get(k) || 0;
    if (n > 0) { budget.set(k, n - 1); continue; }
    kept.push(entries[i]);
  }
  return kept.reverse();
}

/**
 * Shared CLI handling for the two stale modes. Returns false when neither
 * flag is present (caller continues its normal flow); otherwise exits.
 *   --check-stale  report, exit 1 on any stale entry (read-only)
 *   --prune-stale  call prune(stale) to rewrite the baseline minus stale keys, exit 0
 * @param {string[]} argv
 * @param {{ stale: string[], label: string, updateCmd: string, prune: (stale: string[]) => void, exit?: (code: number) => void }} opts
 */
function runStaleModes(argv, { stale, label, updateCmd, prune, exit = process.exit }) {
  if (argv.includes('--prune-stale')) {
    if (stale.length) prune(stale);
    console.log(`✓ ${label}: pruned ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'}.`);
    exit(0);
    return true;
  }
  if (argv.includes('--check-stale')) {
    exit(reportStaleBaseline(stale, { label, updateCmd }) ? 1 : 0);
    return true;
  }
  return false;
}

const STALE_FLAGS_HELP = '--check-stale (exit 1 on baseline entries with no live violation) | --prune-stale (drop only those entries)';

module.exports = { countKeys, computeStaleBaselineKeys, reportStaleBaseline, pruneStaleEntries, runStaleModes, STALE_FLAGS_HELP };
