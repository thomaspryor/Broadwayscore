'use strict';

/**
 * opus-budget.js (BRO-6684): how many more non-P0 Opus workers may start right now.
 *
 * The weekly Claude limit went in ~2 days after the Opus launch cap was removed
 * (BRO-6502, 2026-10-29). Owner 2026-10-31: put a cap back, but lift it near the
 * end of the weekly window when plenty of usage is left, so none is wasted.
 *
 *   - default: OPUS_DAILY_CAP (4) Opus launches per 24h (P0s and retries count, but are never refused);
 *   - weekly status "allowed_warning" or "rejected": 0, so only P0s and retries get Opus;
 *     an unrecognised status counts as unknown;
 *   - weekly status "allowed" and the weekly reset within LIFT_WINDOW_H (30h): no cap;
 *   - usage unknown or stale (older than USAGE_MAX_AGE_H): the default cap.
 *
 * Usage comes from get_session's external_metadata.rate_limit_info, which only a
 * cloud session can read. The session records it with
 *   node scripts/opus-budget.js --record-usage --type=seven_day --status=<status> --resets-at=<epoch s>
 * into USAGE_PATH, and every picker in that container reads it.
 *
 * P0s and retries are never downgraded here (a retry on the model that already
 * failed is the BRO-4523 loop); pickLinearModel applies the budget only to a
 * card's own "Model: Opus" line, and the create_session hook re-checks every
 * Opus launch against the same rule (scripts/opus-launch-check.js).
 * Kill switch: OPUS_BUDGET_DISABLED=1.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const OPUS_DAILY_CAP = 4;
const LIFT_WINDOW_H = 30;
const USAGE_MAX_AGE_H = 6;
const USAGE_PATH = path.join(os.homedir(), '.claude', 'state', 'claude-usage.json');
const OK_STATUS = 'allowed';
const WEEKLY_TYPE = 'seven_day';
// rate_limit_info.status values that mean the weekly limit is close or hit. Any other
// value we have not seen is treated as unknown (the default cap), never as a hard stop.
const TIGHT_STATUSES = new Set(['allowed_warning', 'rejected']);

function disabled(env = process.env) {
  return env.OPUS_BUDGET_DISABLED === '1';
}

/**
 * @param {object} o
 * @param {number|null} o.opusLaunches24h - Opus launches in the last 24h, null when unknown
 * @param {{status:string, resetsAt:number}|null} o.usage - weekly limit status, resetsAt in epoch seconds
 * @param {number} o.nowMs
 * @returns {{ cap: number|null, remaining: number, reason: string }} cap null = no cap
 */
function decideOpusBudget({ opusLaunches24h, usage, nowMs }) {
  const used = Number.isFinite(opusLaunches24h) ? opusLaunches24h : 0;
  const countNote = Number.isFinite(opusLaunches24h) ? `${used} used in 24h` : '24h count unknown';
  if (usage && TIGHT_STATUSES.has(usage.status)) {
    return { cap: 0, remaining: 0, reason: `weekly limit is "${usage.status}": Opus only for P0s and retries` };
  }
  if (usage && usage.status === OK_STATUS && Number.isFinite(usage.resetsAt)) {
    const hoursLeft = (usage.resetsAt * 1000 - nowMs) / 3_600_000;
    if (hoursLeft >= 0 && hoursLeft <= LIFT_WINDOW_H) {
      return { cap: null, remaining: Infinity, reason: `weekly limit resets in ${Math.round(hoursLeft)}h with room left: no Opus cap` };
    }
  }
  const remaining = Math.max(0, OPUS_DAILY_CAP - used);
  return { cap: OPUS_DAILY_CAP, remaining, reason: `Opus cap ${OPUS_DAILY_CAP}/24h, ${countNote}` };
}

/** -> { status, resetsAt } from USAGE_PATH, or null when missing, unreadable or stale. */
function readUsage({ file = USAGE_PATH, nowMs = Date.now() } = {}) {
  try {
    const u = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = nowMs - Date.parse(u.recordedAt);
    if (!(age >= 0 && age <= USAGE_MAX_AGE_H * 3_600_000)) return null;
    if (typeof u.status !== 'string' || !Number.isFinite(u.resetsAt)) return null;
    return { status: u.status, resetsAt: u.resetsAt };
  } catch {
    return null;
  }
}

function recordUsage({ status, resetsAt, type, file = USAGE_PATH, now = new Date() }) {
  const r = Number(resetsAt);
  if (!status || !Number.isFinite(r)) throw new Error('need --status and --resets-at (epoch seconds) from get_session rate_limit_info');
  // Only the weekly limit may lift the cap: a five-hour limit always resets within 30h (review finding).
  if (type !== WEEKLY_TYPE) throw new Error(`rate_limit_info.rateLimitType is "${type}"; only "${WEEKLY_TYPE}" is recorded (pass --type=${WEEKLY_TYPE})`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { status: String(status), resetsAt: r, recordedAt: now.toISOString() };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

/**
 * The budget for this run: 24h Opus count from the dispatch ledger (Mac; absent in
 * the cloud) plus Linear "Worker model: opus" claims (cloud). A failed count is
 * unknown, which decideOpusBudget treats as 0 used (fail open, noted in the reason).
 */
async function loadOpusBudget({ nowMs = Date.now(), usage = readUsage({ nowMs }), readEntries, fetchClaims } = {}) {
  if (disabled()) return null;
  const { countRecentLinearOpusLaunches } = require('./bsc-next-model.js');
  const pick = require('./cloud-worker-pick.js');
  let count = null;
  try {
    const rows = (readEntries || require('./dispatch-ledger.js').readEntries)();
    const claims = await (fetchClaims || pick.fetchOpusClaimEntries)(nowMs);
    count = countRecentLinearOpusLaunches(pick.withCloudOpusClaims(rows, claims), nowMs);
  } catch { /* unknown */ }
  return decideOpusBudget({ opusLaunches24h: count, usage, nowMs });
}

module.exports = { WEEKLY_TYPE, OPUS_DAILY_CAP, LIFT_WINDOW_H, USAGE_MAX_AGE_H, USAGE_PATH, disabled, decideOpusBudget, readUsage, recordUsage, loadOpusBudget };
