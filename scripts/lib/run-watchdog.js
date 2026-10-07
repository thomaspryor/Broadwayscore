/**
 * run-watchdog.js — a hard wall-clock deadline for long batch scripts whose
 * own "time budget" is only checked BETWEEN units of work (BRO-4401).
 *
 * fetch-show-images-auto.js checks --max-runtime before each batch of shows.
 * On 2026-09-30 (run 36655690883, the first run with a real Playwright
 * browser) one show's fetch never returned: the check between batches never
 * came, the 150-minute budget passed unnoticed, and the job ran until it was
 * cancelled at 160 minutes — with a finished show's accepted image sitting
 * in memory, never checkpointed, never committed. A budget that cannot fire
 * while a unit is in flight is not a budget.
 *
 * armRunWatchdog() schedules ONE timer at budget + grace. When it fires the
 * caller's onFire() runs (checkpoint what finished, discard in-flight
 * artifacts, annotate) and then the process exits with the given code. The
 * timer is unref()'d so a run that finishes normally is never held open by
 * it. Injectable timer/exit for tests; no I/O here.
 */

'use strict';

/**
 * @param {object} opts
 * @param {number} opts.maxRuntimeMin  the script's own budget; <= 0 disarms (returns null)
 * @param {number} [opts.graceMin=10]  how long past the budget an in-flight unit may run
 * @param {() => void} opts.onFire  checkpoint / cleanup; exceptions are logged, never block the exit
 * @param {number} [opts.exitCode=0]  0 so the workflow's `if: always()` archive+commit steps still run
 * @param {(fn: Function, ms: number) => any} [opts.setTimer]  default setTimeout
 * @param {(code: number) => void} [opts.exit]  default process.exit
 * @param {(msg: string) => void} [opts.log]  default console.log
 * @returns {{ fireAtMs: number, handle: any } | null}
 */
function armRunWatchdog({ maxRuntimeMin, graceMin = 10, onFire, exitCode = 0, setTimer = setTimeout, exit = (c) => process.exit(c), log = console.log }) {
  const budget = Number(maxRuntimeMin);
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const fireAtMs = (budget + graceMin) * 60 * 1000;
  const handle = setTimer(() => {
    log(`::warning title=Run watchdog::exceeded --max-runtime=${budget} min by the ${graceMin} min grace with a unit still in flight — checkpointing finished work and exiting ${exitCode} (BRO-4401)`);
    try {
      if (typeof onFire === 'function') onFire();
    } catch (err) {
      log(`::warning::run watchdog onFire threw: ${err && err.message}`);
    }
    exit(exitCode);
  }, fireAtMs);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return { fireAtMs, handle };
}

module.exports = { armRunWatchdog };
