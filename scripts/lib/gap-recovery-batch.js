'use strict';
/**
 * gap-recovery-batch.js (lib): the pure decisions behind scripts/gap-recovery-batch.js
 * (BRO-7944): chained, checkpointed rounds of the gap-recovery driver.
 *
 *  - checkpointCadence: how often a round commits+pushes accepted text. Never more than
 *    10 accepted reviews or 10 minutes uncommitted, whatever the env asks for.
 *  - orphanAccepts: accepted reviews (latest ledger row pending_push) that a killed round
 *    wrote to disk but never committed. The next round adopts and lands them instead of
 *    losing the text or redoing the fetch.
 *  - stopDecision: stop after two failed pushes or when the spend cap is used up.
 *  - buildRoundRow: one counts-only summary row per round.
 */
const MAX_ACCEPTS_BETWEEN_CHECKPOINTS = 10;
const MAX_MINUTES_BETWEEN_CHECKPOINTS = 10;
const MAX_FAILED_PUSHES = 2;

function posInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; }

/** @returns {{everyAccepts:number, maxMs:number}} clamped to the 10 / 10-minute ceiling */
function checkpointCadence(env = process.env, defaults = { accepts: 5, minutes: 2 }) {
  const accepts = Math.min(posInt(env.GAP_CHECKPOINT_EVERY, defaults.accepts), MAX_ACCEPTS_BETWEEN_CHECKPOINTS);
  const minutes = Math.min(Number(env.GAP_CHECKPOINT_MAX_MIN) > 0 ? Number(env.GAP_CHECKPOINT_MAX_MIN) : defaults.minutes, MAX_MINUTES_BETWEEN_CHECKPOINTS);
  return { everyAccepts: accepts, maxMs: Math.round(minutes * 60000) };
}

/**
 * Pending-push reviews whose accepted text is on disk, uncommitted, in the clone.
 * @param {Map<string, {bytesAfter:number}>} pending reviewKey -> info (L.pendingPushInfo)
 * @param {{readText:(key:string)=>string|null, isDirty:(key:string)=>boolean, landed?:Set<string>}} io
 * @returns {{adopt: string[], gone: string[]}} adopt = text present+uncommitted and matches the accepted length;
 *          gone = pending, not landed and not adoptable (no text, clean in git, or length differs); reported, never silently dropped
 */
function orphanAccepts(pending, io) {
  const adopt = []; const gone = [];
  for (const [key, info] of pending) {
    if (io.landed && io.landed.has(key)) continue;
    const text = io.readText(key);
    // acceptedHash (when the row has one) proves the dirty file is still OUR accepted text, not an equal-length replacement.
    const hashOk = !info.acceptedHash || !io.hashText || io.hashText(text) === info.acceptedHash;
    if (text !== null && io.isDirty(key) && Number.isFinite(info.bytesAfter) && text.length === info.bytesAfter && hashOk) adopt.push(key);
    else gone.push(key); // missing, clean (committed or reset), or changed since the accept: reported, never dropped
  }
  return { adopt: adopt.sort(), gone: gone.sort() };
}

/**
 * @param {{failedPushes:number, spend:{bd:number, serp:number}, cap:{bd:number|null, serp:number|null}, roundsDone:number, rounds:number, lastRoundWork:number}} s
 * @returns {{stop:boolean, why:string|null}}
 */
function stopDecision(s) {
  if (s.failedPushes >= MAX_FAILED_PUSHES) return { stop: true, why: `${s.failedPushes} failed pushes` };
  if (s.cap && s.cap.bd != null && s.spend.bd >= s.cap.bd) return { stop: true, why: `spend cap: Bright Data ${s.spend.bd}/${s.cap.bd}` };
  if (s.cap && s.cap.serp != null && s.spend.serp >= s.cap.serp) return { stop: true, why: `spend cap: SERP ${s.spend.serp}/${s.cap.serp}` };
  if (s.roundsDone >= s.rounds) return { stop: true, why: 'rounds complete' };
  if (s.roundsDone > 0 && s.lastRoundWork === 0) return { stop: true, why: 'last round attempted nothing (nothing eligible)' };
  return { stop: false, why: null };
}

/** Remaining per-round env budgets from the batch-level cap. */
function remainingBudget(cap, spend) {
  const rem = (c, u, d) => (c == null ? d : Math.max(0, c - u));
  return { bd: rem(cap.bd, spend.bd, null), serp: rem(cap.serp, spend.serp, null) };
}

function buildRoundRow({ batchId, round, startedAt, endedAt, exit, summary, spendTotal, stopWhy = null, adopted = 0, orphansGone = 0 }) {
  const s = summary || {};
  return {
    ts: endedAt, batchId, round, startedAt, endedAt, exit,
    attempted: s.attempted || 0, accepted: s.accepted || 0, landed: s.landed || 0,
    byStrategy: Object.fromEntries(Object.entries(s.byStrategy || {}).map(([k, v]) => [k, { attempted: v.attempted, accepted: v.accepted }])),
    adopted, orphansGone,
    timeBudgetHit: !!s.timeBudgetHit, ceilingHit: !!s.ceilingHit, pushFailed: !!(s.pushFailed || s.pushRetryFailed),
    spend: s.spend || null, spendTotal: spendTotal || null, error: s.error || null, stopWhy,
  };
}

/**
 * BRO-8277: what one round spent, for the batch-wide cap. A round with no summary
 * (killed, timed out) has unknown spend: assume its whole allowance. A dry run
 * spends nothing; its summary carries no spend field and used to be booked as a
 * full allowance, so one dry-run batch "used up" the cap (25 BD / 60 SERP each).
 */
function roundSpend(summary, rem) {
  if (summary && summary.spend) return { bd: summary.spend.bd || 0, serp: summary.spend.serp || 0 };
  if (summary && summary.mode === 'dry_run') return { bd: 0, serp: 0 };
  return { bd: rem.bd == null ? 0 : rem.bd, serp: rem.serp == null ? 0 : rem.serp };
}

/**
 * Outlet ids the DRIVER will scope to: exactly its own parse (first `--outlet=a,b` only; a bare
 * `--outlet x` is not scoped by the driver). The lane lock must cover what the child really runs.
 */
function outletsFromArgs(args) {
  const hit = args.find((a) => a.startsWith('--outlet='));
  return hit ? [...new Set(hit.slice(9).split(',').map((x) => x.trim()).filter(Boolean))] : [];
}

module.exports = { roundSpend, outletsFromArgs, checkpointCadence, orphanAccepts, stopDecision, remainingBudget, buildRoundRow, MAX_ACCEPTS_BETWEEN_CHECKPOINTS, MAX_MINUTES_BETWEEN_CHECKPOINTS, MAX_FAILED_PUSHES };
