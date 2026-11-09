'use strict';
/**
 * gap-recovery-nightly.js — pure pieces of the nightly review-text recovery
 * job (BRO-7171 Stage 3): the nightly summary row, the ACTION alerts, and the
 * one aggregated owner digest line.
 *
 * Why a committed jsonl row and not owner-alert-router: the owner's morning
 * digest is sent from GitHub Actions (morning-digest-action.yml, since
 * 2026-11-02) on a fresh public-repo checkout. It cannot see the Mac or the
 * private review-texts repo, and the router's digest queue
 * (data/audit/alert-digest-queue.json) is a tracked non-jsonl file that
 * sync-audit-checkout.sh resets on the Mac and only CI's health-check drains.
 * So the nightly job appends ONE counts-only row per night to
 * data/audit/gap-recovery-nightly.jsonl (merge=union) and publishes it; the
 * digest renders the latest row. Alerts live on that row, so an alert shows
 * every morning while its condition holds and stops when it clears: durable
 * and consumed, with no queue to drain.
 *
 * Row: { ts, runId, status: 'ran'|'dry_run'|'disabled'|'busy'|'failed',
 *        openTotal, openRecent, needsDecision, attempted, accepted, recovered,
 *        byStrategy, reopened, pendingStuck, authFailedStreak, ceiling,
 *        ceilingHit, pushFailed, alerts: [{key, text}] }
 */

const fs = require('fs');
const path = require('path');

const NIGHTLY_REL = path.join('data', 'audit', 'gap-recovery-nightly.jsonl');
const DEFAULT_NIGHTLY_CEILING = 60;
const PENDING_STUCK_HOURS = 24;
const AUTH_STREAK_ALERT = 2;
const STALE_ROW_HOURS = 20; // run ~02:30 ET, digest ~08:00 ET: a missed night must not show yesterday as today

// Skip reasons that mean a strategy has used up its tries (review-guards
// shouldRetryFetch / shouldRetryUrlDiscovery), as opposed to a cooldown.
const EXHAUSTED_REASONS = new Set(['abandoned', 'max_retries_reached', 'collector_abandoned', 'collector_max_retries_reached']);

function nightlyPathDefault(root = path.join(__dirname, '..', '..')) {
  return process.env.GAP_RECOVERY_NIGHTLY_PATH || path.join(root, NIGHTLY_REL);
}

function readNightlyRows(file = nightlyPathDefault()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && j.ts && j.status) out.push(j); } catch { /* torn line */ }
  }
  // merge=union appends the other side's rows after ours: order by ts.
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function appendNightlyRow(row, file = nightlyPathDefault()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

/** Nightly accepted-review ceiling (configurable; conservative first-week default). */
function nightlyCeiling(env = process.env) {
  const s = String(env.GAP_RECOVERY_NIGHTLY_CEILING || '').trim();
  return /^\d+$/.test(s) ? Number(s) : DEFAULT_NIGHTLY_CEILING;
}

/**
 * Counts from the driver's dry-run plan (candidates of every open gap).
 * needsDecision = gaps on historic shows (>2y) with no automatic strategy
 * left because every try was used up: the batch the owner will be asked to
 * close (revised plan item 7; recent shows are never in it).
 */
function planCounts(candidates) {
  let openTotal = 0; let openRecent = 0; let needsDecision = 0;
  for (const c of candidates || []) {
    openTotal++;
    if (c.recency === 'recent') { openRecent++; continue; }
    if (c.strategy) continue;
    const reasons = (c.skipped || []).map((k) => String(k.reason));
    if (reasons.some((r) => EXHAUSTED_REASONS.has(r)) && !reasons.some((r) => r === 'cooldown' || r === 'collector_cooldown')) needsDecision++;
  }
  return { openTotal, openRecent, needsDecision };
}

/** Reviews whose latest ledger row is pending_push and older than PENDING_STUCK_HOURS. */
function pendingStuckCount(ledgerRows, nowMs = Date.now()) {
  const latest = new Map();
  for (const r of ledgerRows || []) {
    const t = Date.parse(r.ts || '');
    const prev = latest.get(r.reviewKey);
    if (!prev || t >= prev.t) latest.set(r.reviewKey, { t, outcome: r.outcome });
  }
  let n = 0;
  for (const v of latest.values()) {
    if (v.outcome === 'pending_push' && Number.isFinite(v.t) && nowMs - v.t > PENDING_STUCK_HOURS * 3600e3) n++;
  }
  return n;
}

/** Last row that actually ran the live driver (not dry-run/disabled/busy). */
function lastRanRow(rows) {
  for (let i = (rows || []).length - 1; i >= 0; i--) if (rows[i].status === 'ran') return rows[i];
  return null;
}

/**
 * auth_failed streak in nights. A night with no browser attempt at all (screen
 * locked, no GUI) says nothing about the login: the streak carries over.
 * @param {{authFailed:boolean, authOk:boolean}} tonight
 */
function nextAuthStreak(prevRow, tonight) {
  const prev = (prevRow && Number(prevRow.authFailedStreak)) || 0;
  if (tonight.authFailed) return prev + 1;
  if (tonight.authOk) return 0;
  return prev;
}

/**
 * ACTION alerts only (no per-outlet noise): lost browser session for 2+
 * nights, a pending push stuck past a day or failed tonight, reconcile
 * reopening recovered reviews, the nightly ceiling hit, the run failing.
 * @returns {Array<{key:string, text:string}>} plain-English, owner-readable
 */
function decideAlerts({ authFailedStreak = 0, authOutlets = [], pendingStuck = 0, pushFailed = false, reopened = 0, ceilingHit = false, ceiling = DEFAULT_NIGHTLY_CEILING, runFailed = false, runError = '' }) {
  const out = [];
  if (authFailedStreak >= AUTH_STREAK_ALERT) {
    const who = authOutlets.length ? authOutlets.join(', ') : 'a subscriber site';
    out.push({ key: 'browser_session_lost', text: `the Mac's ${who} login has failed ${authFailedStreak} nights in a row, so those reviews are not being recovered until it is logged in again` });
  }
  if (pushFailed || pendingStuck > 0) {
    out.push({ key: 'pending_push_stuck', text: pushFailed
      ? 'recovered texts could not be uploaded tonight; they are saved and the next run retries them first'
      : `${pendingStuck} recovered text${pendingStuck === 1 ? ' has' : 's have'} waited more than a day to upload` });
  }
  if (reopened > 0) out.push({ key: 'reconcile_reopened', text: `${reopened} review${reopened === 1 ? '' : 's'} marked recovered had lost the recovered text and ${reopened === 1 ? 'was' : 'were'} reopened` });
  if (ceilingHit) out.push({ key: 'ceiling_hit', text: `the nightly limit of ${ceiling} recovered reviews was reached, so more are waiting for the next night` });
  if (runFailed) out.push({ key: 'run_failed', text: `the nightly run stopped with an error${runError ? ` (${String(runError).slice(0, 80)})` : ''}` });
  return out;
}

/**
 * Build tonight's row from the pieces the nightly entrypoint gathered.
 * @param {object} a
 * @param {object|null} a.summary driver --summary output ({attempted, accepted, landed, byStrategy, ceilingHit, pushFailed, authFailedOutlets, authOkOutlets, error})
 * @param {object} a.counts planCounts()
 * @param {number} a.reopened reconcile reopen count
 * @param {Array} a.ledgerRows all ledger rows after the run
 * @param {Array} a.prevRows earlier nightly rows
 */
function buildNightlyRow({ runId, status, summary, counts, reopened = 0, ledgerRows = [], prevRows = [], ceiling, nowMs = Date.now(), driverExit = 0 }) {
  const s = summary || {};
  const authFailedOutlets = s.authFailedOutlets || [];
  const authFailedStreak = nextAuthStreak(lastRanRow(prevRows), { authFailed: authFailedOutlets.length > 0, authOk: (s.authOkOutlets || []).length > 0 });
  const pendingStuck = pendingStuckCount(ledgerRows, nowMs);
  const runFailed = status === 'failed' || (driverExit !== 0 && !s.pushFailed);
  const row = {
    ts: new Date(nowMs).toISOString(),
    runId,
    status,
    openTotal: counts ? counts.openTotal : null,
    openRecent: counts ? counts.openRecent : null,
    needsDecision: counts ? counts.needsDecision : null,
    attempted: s.attempted || 0,
    accepted: s.accepted || 0,
    recovered: s.landed || 0,
    byStrategy: s.byStrategy || {},
    reopened,
    pendingStuck,
    authFailedStreak,
    authFailedOutlets,
    ceiling,
    ceilingHit: !!s.ceilingHit,
    pushFailed: !!s.pushFailed,
  };
  row.alerts = status === 'dry_run' || status === 'disabled' ? [] : decideAlerts({
    authFailedStreak, authOutlets: authFailedOutlets, pendingStuck, pushFailed: row.pushFailed,
    reopened, ceilingHit: row.ceilingHit, ceiling, runFailed, runError: s.error,
  });
  return row;
}

const fmt = (n) => Number(n).toLocaleString('en-US');

/**
 * The ONE aggregated owner line for the morning digest, or null when the job
 * has never run. Plain English, no ids.
 * @param {Array} rows readNightlyRows()
 * @returns {string|null}
 */
function renderDigestLine(rows, nowMs = Date.now()) {
  const real = (rows || []).filter((r) => r.status !== 'dry_run');
  if (!real.length) return null;
  const last = real[real.length - 1];
  const ageH = (nowMs - Date.parse(last.ts)) / 3600e3;
  if (!Number.isFinite(ageH) || ageH > STALE_ROW_HOURS) {
    const ran = lastRanRow(real);
    return `Review texts: the nightly recovery did not run last night${ran ? ` (last ran ${new Date(ran.ts).toISOString().slice(0, 10)})` : ''}.`;
  }
  if (last.status === 'disabled') return 'Review texts: the nightly recovery is switched off.';
  if (last.status === 'busy') return 'Review texts: the nightly recovery was skipped last night because a manual recovery was running.';
  const bits = [];
  if (Number.isFinite(last.openRecent)) {
    const prev = lastRanRow(real.slice(0, -1));
    let change = '';
    if (prev && Number.isFinite(prev.openRecent)) {
      const d = last.openRecent - prev.openRecent;
      change = d < 0 ? ` (${fmt(-d)} fewer than the night before)` : d > 0 ? ` (${fmt(d)} more than the night before)` : ' (no change)';
    }
    bits.push(`${fmt(last.openRecent)} reviews of recent shows still lack their full text${change}`);
  }
  bits.push(`${fmt(last.recovered || 0)} recovered last night`);
  if (Number.isFinite(last.needsDecision)) bits.push(`${fmt(last.needsDecision)} older ones ${last.needsDecision === 1 ? 'has' : 'have'} run out of automatic options and will need your decision`);
  let line = `Review texts: ${bits.join('; ')}.`;
  if (last.status === 'failed' && !(last.alerts || []).some((a) => a.key === 'run_failed')) line += ' The nightly run stopped with an error.';
  const alerts = (last.alerts || []).map((a) => a.text).filter(Boolean);
  if (alerts.length) line += ` Needs attention: ${alerts.join('; ')}.`;
  return line;
}

module.exports = {
  NIGHTLY_REL,
  DEFAULT_NIGHTLY_CEILING,
  PENDING_STUCK_HOURS,
  AUTH_STREAK_ALERT,
  STALE_ROW_HOURS,
  EXHAUSTED_REASONS,
  nightlyPathDefault,
  readNightlyRows,
  appendNightlyRow,
  nightlyCeiling,
  planCounts,
  pendingStuckCount,
  lastRanRow,
  nextAuthStreak,
  decideAlerts,
  buildNightlyRow,
  renderDigestLine,
};
