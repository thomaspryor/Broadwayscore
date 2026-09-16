'use strict';
/**
 * Swap-pressure measurement (BRO-2205 root-cause follow-up).
 *
 * The 2026-08-16 cyrus-edge ENOSPC crash was investigated and corrected
 * twice: first blamed on whole-disk exhaustion (wrong — the owner's own
 * `df` showed 35GB+ free), then narrowed to "something returned ENOSPC,
 * cause unconfirmed." Re-investigated 2026-09-16: `diskutil info` confirms
 * the Data volume's reported free space IS the real APFS container free
 * space (not a distinct, hidden quota) — so the existing df-based floor
 * checks (disk-floor-check.sh, gc-merged-worktrees.sh, bsc-runner.js
 * freeDiskGB) are measuring the right thing. What none of them account for:
 * that number is volatile on a seconds-to-minutes timescale, because macOS
 * dynamically grows the VM (swap) volume under memory pressure, and swap
 * growth draws from the exact same shared container pool an ordinary write
 * draws from. A brief swap-growth burst (many concurrent worktree
 * sessions running node/tsc/next at once is exactly this Mac's normal
 * load) can transiently exhaust the container even though a `df` check a
 * few seconds before or after shows a healthy margin — a classic
 * check-then-act race the existing floor checks cannot see, because
 * nothing in the pipeline reads swap/memory pressure at all. Confirmed
 * live and reproducible on 2026-09-16: swap was at 13.3/14.3GB (970MB of
 * its own headroom) with only ~116MB of free RAM pages system-wide, while
 * container free space sat at ~19-20GB — comfortably above every existing
 * floor (5GB dispatch, 20GB GC) despite the machine visibly straining.
 *
 * This module is the missing signal: swap headroom, parsed from
 * `sysctl vm.swapusage`. It is deliberately NOT wired into bsc-runner.js's
 * dispatch-refusal path in this change — that is critical/shared dispatch
 * infrastructure (CLAUDE.md rule 18) and flipping a new hard gate live,
 * on a machine that reads as already under pressure by this exact metric,
 * is a fleet-wide behavior change that needs its own review, not a rider
 * on a root-cause investigation. What this DOES give the pipeline today:
 * a standalone, testable signal (see scripts/check-swap-pressure.js) that
 * can be alerted on or wired into the dispatch floor in a follow-up once
 * an owner has picked a threshold.
 */
const { execFileSync } = require('child_process');

/**
 * Parse `sysctl vm.swapusage` output, e.g.:
 *   "vm.swapusage: total = 14336.00M  used = 13365.19M  free = 970.81M  (encrypted)"
 *
 * @param {string} output
 * @returns {{totalMB: number, usedMB: number, freeMB: number}|null} null if
 *   the line is missing or doesn't parse (e.g. non-macOS, sysctl renamed).
 */
function parseSwapUsage(output) {
  const match = /total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/.exec(output || '');
  if (!match) return null;
  const [, totalMB, usedMB, freeMB] = match;
  return { totalMB: Number(totalMB), usedMB: Number(usedMB), freeMB: Number(freeMB) };
}

/**
 * IO wrapper around `sysctl vm.swapusage`. Fails to null (never throws) —
 * same fail-open contract as bsc-runner.js's freeDiskGB: a missing/broken
 * sysctl (non-macOS, sandboxed CI) must never be mistaken for zero headroom.
 *
 * @returns {{totalMB: number, usedMB: number, freeMB: number}|null}
 */
function currentSwapUsage() {
  try {
    const out = execFileSync('sysctl', ['vm.swapusage'], { encoding: 'utf8', timeout: 10000 });
    return parseSwapUsage(out);
  } catch {
    return null;
  }
}

/**
 * @param {object} d
 * @param {number} d.freeMB - current swap headroom (within swap's own ceiling)
 * @param {number} d.floorMB - alert threshold
 * @returns {boolean} true iff swap headroom is critically low
 */
function isSwapPressureCritical({ freeMB, floorMB }) {
  return freeMB < floorMB;
}

module.exports = { parseSwapUsage, currentSwapUsage, isSwapPressureCritical };
