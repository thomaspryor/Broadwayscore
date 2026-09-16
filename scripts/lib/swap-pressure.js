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
  const parsed = { totalMB: Number(totalMB), usedMB: Number(usedMB), freeMB: Number(freeMB) };
  // The capture group `[\d.]+` accepts malformed multi-dot numbers (e.g. a
  // truncated/garbled sysctl line reading "1.2.3M"), which Number() turns
  // into NaN rather than throwing (adversarial review finding). A NaN freeMB
  // silently reads as "not critical" in isSwapPressureCritical (NaN < floor
  // is always false) — fail to null like any other unparseable line instead
  // of returning a value that looks healthy.
  if (!Object.values(parsed).every(Number.isFinite)) return null;
  return parsed;
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
 * CAVEAT (adversarial review, BRO-2205): macOS grows the swap volume
 * dynamically — `totalMB` is not a fixed ceiling, it is however much swap
 * happens to be allocated right now. That means (a) a freshly-booted Mac
 * with no swap pressure yet can read `{totalMB: 0, usedMB: 0, freeMB: 0}`,
 * which would trip "critical" against any positive floor despite there
 * being no actual pressure — callers should treat `totalMB === 0` as "no
 * swap pressure data yet", not "critical"; and (b) macOS can relieve a
 * "critical" reading by simply allocating another swapfile, which frees up
 * `freeMB` again without the underlying memory pressure having eased at
 * all. This function is a literal headroom-vs-floor comparison only — it
 * is not, by itself, a memory-pressure verdict.
 *
 * @param {object} d
 * @param {number} d.freeMB - current swap headroom (within swap's own ceiling)
 * @param {number} d.floorMB - alert threshold
 * @returns {boolean} true iff swap headroom is below the floor
 */
function isSwapPressureCritical({ freeMB, floorMB }) {
  return freeMB < floorMB;
}

module.exports = { parseSwapUsage, currentSwapUsage, isSwapPressureCritical };
