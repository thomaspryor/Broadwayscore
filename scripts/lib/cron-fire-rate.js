'use strict';

/**
 * cron-fire-rate.js — pure decisions for scripts/check-cron-fire-rate.js (BRO-7934).
 *
 * check-cron-health.yml asks "when did this workflow last SUCCEED?", which a
 * cron that fires 4% of the time still passes whenever one of its few runs
 * lands inside max_hours. Measured 2026-11-06..19: opening-night-completeness-check
 * (`*\/15`) fired 53 of 1,344 expected times, the _pending drain 67%, reverse
 * discovery 66%, with no alert. This module compares EXPECTED scheduled fires
 * (computed from the cron expressions in the workflow file) with ACTUAL
 * `event=schedule` runs, and separately flags cancelled scheduled runs
 * (`if: always()` does not run on cancel, so notify-failure never fires for them).
 *
 * No I/O: the CLI supplies counts from the GitHub API.
 */

const MIN = 60 * 1000;

function expandField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`unsupported cron field "${field}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b === undefined ? (m[2] ? max : a) : b;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step > 0)) throw new Error(`bad cron step in "${field}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse "m h dom mon dow" into matcher sets. dow 7 is Sunday. */
function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  const dow = expandField(f[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return {
    minute: expandField(f[0], 0, 59),
    hour: expandField(f[1], 0, 23),
    dom: expandField(f[2], 1, 31),
    month: expandField(f[3], 1, 12),
    dow,
    domStar: f[2] === '*',
    dowStar: f[4] === '*',
  };
}

function matches(c, d) {
  if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  // cron rule: when both day fields are restricted a day matches if EITHER does.
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * Distinct scheduled fire times (ms) in [fromMs, toMs) across all expressions.
 * @param {string[]} exprs
 */
function expectedFireTimes(exprs, fromMs, toMs) {
  const parsed = exprs.map(parseCron);
  const out = [];
  const start = Math.ceil(fromMs / MIN) * MIN;
  for (let t = start; t < toMs; t += MIN) {
    const d = new Date(t);
    if (parsed.some((c) => matches(c, d))) out.push(t);
  }
  return out;
}

/**
 * Verdict for one workflow.
 * @param {{workflow:string, expected:number, actual:number, cancelled?:number,
 *          minExpected?:number, minRatio?:number, cancelRatio?:number, minCancelled?:number}} a
 * @returns {{workflow:string, expected:number, actual:number, ratio:number|null,
 *            cancelled:number, shortfall:boolean, cancelAlert:boolean, status:string}}
 */
function fireRateVerdict(a) {
  const minExpected = a.minExpected ?? 4;
  const minRatio = a.minRatio ?? 0.5;
  const minCancelled = a.minCancelled ?? 3;
  const cancelRatio = a.cancelRatio ?? 0.25;
  const expected = a.expected | 0;
  const actual = a.actual | 0;
  const cancelled = a.cancelled | 0;
  const ratio = expected > 0 ? actual / expected : null;
  const shortfall = expected >= minExpected && ratio < minRatio;
  const cancelAlert = cancelled >= minCancelled && actual > 0 && cancelled / actual >= cancelRatio;
  let status = 'ok';
  if (expected === 0) status = 'no-expected-fires';
  else if (expected < minExpected) status = 'too-few-expected-to-judge';
  else if (shortfall) status = 'shortfall';
  return { workflow: a.workflow, expected, actual, ratio, cancelled, shortfall, cancelAlert, status };
}

module.exports = { parseCron, expectedFireTimes, fireRateVerdict };
