'use strict';
/**
 * gap-recovery-ledger.js — the append-only attempt ledger of the gap-recovery
 * engine (BRO-7171 Stage 2): data/audit/gap-recovery-attempts.jsonl,
 * merge=union in .gitattributes. One JSON row per attempt; state is DERIVED
 * by reading all rows (sorted by ts, never by file order: a union merge
 * appends the other side's rows after ours).
 *
 * Row: { ts, reviewKey ("<showId>/<file>"), gapClass, strategy, outcome,
 *        reason, url, bytesBefore, bytesAfter, priorFullTextHash, pushedBlob,
 *        retryAfter, abandoned, runId }
 *
 * Outcomes:
 *   recovered            text on origin/main (written ONLY from the checkpoint's
 *                        onLanded callback: see recoveredRowFromLanding)
 *   pending_push         accepted + written locally, not yet confirmed landed
 *   rejected             fetched something, the acceptance gate refused it   (evidence)
 *   no_evidence          the route ran and found nothing (404, no SERP hit)  (evidence)
 *   non_evidence         our own budget/code/soft-404: says nothing about the review
 *   auth_failed          subscriber session not logged in (non-evidence)
 *   browser_unavailable  no GUI session / screen locked (non-evidence)
 *   reopened             reconcile found a 'recovered' review that is not complete
 *
 * Retry caps and cooldowns are NOT a new policy: fetch-type strategies reuse
 * review-guards' shouldRetryFetch / recordFetchAttempt (lifecycle-keyed via
 * classifyLifecycle, strict-vs-lenient via failed-fetch-policy), fed with the
 * ledger's per-strategy evidence count. URL_REDISCOVER reuses the file's own
 * serpRetryCount gate (shouldRetryUrlDiscovery), so it never gets a second
 * counter.
 */

const fs = require('fs');
const path = require('path');

const OUTCOMES = Object.freeze(['recovered', 'pending_push', 'rejected', 'no_evidence', 'non_evidence', 'auth_failed', 'browser_unavailable', 'reopened']);
const EVIDENCE_OUTCOMES = new Set(['rejected', 'no_evidence']);
const FETCH_STRATEGIES = new Set(['REFETCH_FREE', 'BROWSER_SESSION', 'ARCHIVE', 'PAID_FETCH']);
// failed-fetch-policy reasons a no_evidence row may carry as-is.
const FF_REASONS = new Set(['url_dead_404', 'url_dead_410', 'all_tiers_failed', 'all_tiers_timeout', 'fetch_error', 'garbage_content']);

/**
 * Machine-wide working ledger (BRO-7171 Stage 3): the nightly job seeds it
 * from origin + the shared checkout and publishes it back with
 * gap-recovery-publish (plumbing, no working tree). When it exists every run
 * on this machine, nightly or manual, reads and appends the same rows, so a
 * manual run never redoes a review the nightly accepted but has not yet
 * published. The tracked data/audit copy is the published mirror.
 */
function stateLedgerPath() {
  return path.join(require('os').homedir(), '.broadwayscore-state', 'gap-recovery', 'attempts.jsonl');
}

function ledgerPathDefault() {
  if (process.env.GAP_RECOVERY_LEDGER_PATH) return process.env.GAP_RECOVERY_LEDGER_PATH;
  if (!process.env.GITHUB_ACTIONS && !process.env.CI && fs.existsSync(stateLedgerPath())) return stateLedgerPath();
  return path.join(__dirname, '..', '..', 'data', 'audit', 'gap-recovery-attempts.jsonl');
}

/**
 * A live manual driver run that appended to the machine state ledger publishes
 * its own rows to the data/audit mirror at exit (BRO-7171 2026-11-10: 368
 * manual-run rows sat only in the state file, invisible to CI readers of the
 * mirror, until the next nightly). The nightly's child run (it sets
 * GAP_RECOVERY_RUN_LOCK_PARENT) publishes from the parent; dry runs, CI and a
 * scratch ledger never publish. GAP_RECOVERY_NO_PUBLISH=1 opts out.
 */
function manualRunShouldPublish({ dryRun, ledgerPath, env = process.env }) {
  if (dryRun) return false;
  if (env.GAP_RECOVERY_RUN_LOCK_PARENT || env.GAP_RECOVERY_NO_PUBLISH === '1') return false;
  if (env.GITHUB_ACTIONS || env.CI) return false;
  return !!ledgerPath && path.resolve(ledgerPath) === path.resolve(stateLedgerPath());
}

function reviewKeyOf(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

// Per-process write order: rows written in the same millisecond keep the order
// they were made in (indexRows tiebreak). Seeded from the clock so two runs'
// seqs do not collide in a meaningful way; only same-ts rows ever compare it.
let _seq = Date.now() * 1000;

/** Normalise + validate one row. Throws on an unknown outcome or missing key. */
function makeRow(r) {
  if (!r || !r.reviewKey) throw new Error('gap-recovery-ledger: reviewKey required');
  if (!OUTCOMES.includes(r.outcome)) throw new Error(`gap-recovery-ledger: unknown outcome ${r.outcome}`);
  const row = {
    ts: r.ts || new Date().toISOString(),
    reviewKey: r.reviewKey,
    gapClass: r.gapClass || null,
    strategy: r.strategy || null,
    outcome: r.outcome,
    reason: r.reason || null,
    url: r.url || null,
    bytesBefore: Number.isFinite(r.bytesBefore) ? r.bytesBefore : null,
    bytesAfter: Number.isFinite(r.bytesAfter) ? r.bytesAfter : null,
    priorFullTextHash: r.priorFullTextHash || null,
    pushedBlob: r.pushedBlob || null,
  };
  row.seq = Number.isFinite(r.seq) ? r.seq : ++_seq;
  if (r.retryAfter) row.retryAfter = r.retryAfter;
  if (r.abandoned) row.abandoned = true;
  if (r.runId) row.runId = r.runId;
  if (r.detail) row.detail = r.detail;
  return row;
}

/** One O_APPEND write per row (safe against concurrent appenders). */
function appendRows(rows, file = ledgerPathDefault()) {
  if (!rows.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = rows.map((r) => JSON.stringify(makeRow(r))).join('\n') + '\n';
  fs.appendFileSync(file, text);
  return rows.length;
}

function readRows(file = ledgerPathDefault()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && j.reviewKey && j.outcome) out.push(j); } catch { /* skip torn line */ }
  }
  return out;
}

const tsMs = (r) => { const t = Date.parse(r.ts || ''); return Number.isFinite(t) ? t : 0; };

// Same-ts tiebreak: an attempt precedes its acceptance, an acceptance precedes
// its landing, a landing precedes a reopen of it.
const LIFECYCLE_RANK = { pending_push: 1, recovered: 2, reopened: 3 };
const lifeRank = (r) => LIFECYCLE_RANK[r.outcome] || 0;
const seqOf = (r) => (Number.isFinite(r.seq) ? r.seq : 0);

/** Total order for one review's rows: ts, then lifecycle rank, then write seq. */
function compareRows(a, b) {
  return (tsMs(a) - tsMs(b)) || (lifeRank(a) - lifeRank(b)) || (seqOf(a) - seqOf(b));
}

// Logged-only strategies: a read-only probe row (gap-url-find.js) is kept in
// the ledger as a record but never read as an attempt, so it cannot shadow a
// pending_push or recovered row, cool a strategy down, or count as evidence.
const INERT_STRATEGIES = new Set(['URL_FIND_PROBE']);

/** Rows grouped by reviewKey, each list in compareRows order (never file order; logged-only rows left out). */
function indexRows(rows) {
  const m = new Map();
  for (const r of rows) {
    if (INERT_STRATEGIES.has(r.strategy)) continue;
    if (!m.has(r.reviewKey)) m.set(r.reviewKey, []);
    m.get(r.reviewKey).push(r);
  }
  for (const list of m.values()) list.sort(compareRows);
  return m;
}

/** Rows after the latest 'reopened' row: a reopen resets every strategy. */
function liveRows(list) {
  let i = -1;
  (list || []).forEach((r, k) => { if (r.outcome === 'reopened') i = k; });
  return (list || []).slice(i + 1);
}

/** failed-fetch-policy reason an evidence row stands for. */
function policyReasonOf(row) {
  if (row.outcome === 'rejected') return 'garbage_content'; // the page serves content, never this review
  return FF_REASONS.has(row.reason) ? row.reason : 'fetch_error';
}

/**
 * Derived per (review, strategy) state.
 * @returns {{evidenceAttempts:number, lastPolicyReason:string|null, retryAfter:string|null, abandoned:boolean, lastTs:string|null, nonEvidence:number}}
 */
function strategyState(index, reviewKey, strategy) {
  const rows = liveRows(index.get(reviewKey)).filter((r) => r.strategy === strategy);
  const st = { evidenceAttempts: 0, lastPolicyReason: null, retryAfter: null, abandoned: false, lastTs: null, nonEvidence: 0 };
  for (const r of rows) {
    st.lastTs = r.ts;
    if (EVIDENCE_OUTCOMES.has(r.outcome)) {
      st.evidenceAttempts++;
      st.lastPolicyReason = policyReasonOf(r);
      st.retryAfter = r.retryAfter || null;
      if (r.abandoned) st.abandoned = true;
    } else if (r.outcome !== 'recovered' && r.outcome !== 'pending_push') {
      st.nonEvidence++;
    }
  }
  return st;
}

/**
 * Cooldown/cap stamp for a NEW evidence row, from the lifecycle policy
 * (recordFetchAttempt). Non-evidence rows get nothing: they never count.
 * @returns {{retryAfter?: string, abandoned?: boolean}}
 */
function evidenceStamp({ show, strategy, outcome, reason, priorState }) {
  if (!FETCH_STRATEGIES.has(strategy) || !EVIDENCE_OUTCOMES.has(outcome)) return {};
  const { recordFetchAttempt } = require('./review-guards');
  const failureReason = policyReasonOf({ outcome, reason });
  const patch = recordFetchAttempt(show, {}, { failureReason, failureCount: (priorState ? priorState.evidenceAttempts : 0) + 1 });
  const out = {};
  if (patch.fetchRetryAfter) out.retryAfter = patch.fetchRetryAfter;
  if (patch.fetchDiscoveryAbandoned) out.abandoned = true;
  return out;
}

/**
 * Is `strategy` eligible for this review now? Pure apart from Date.now()
 * inside the reused review-guards policy.
 * @param {object} a
 * @param {string} a.strategy
 * @param {object|null} a.show shows.json record
 * @param {object} a.review the review file
 * @param {string} a.gapClass
 * @param {object} a.state strategyState()
 * @returns {{ok:boolean, reason:string}}
 */
function strategyEligibility({ strategy, show, review, gapClass, state }) {
  const rg = require('./review-guards');
  if (FETCH_STRATEGIES.has(strategy)) {
    const entry = state.evidenceAttempts ? { failureReason: state.lastPolicyReason, failureCount: state.evidenceAttempts } : null;
    const v = rg.shouldRetryFetch(show, { fetchRetryAfter: state.retryAfter, fetchDiscoveryAbandoned: state.abandoned }, entry);
    return { ok: v.shouldRetry, reason: v.reason };
  }
  if (strategy === 'URL_REDISCOVER') {
    const v = rg.shouldRetryUrlDiscovery(show, { ...review, incompleteReason: serpGateReason(gapClass) });
    return { ok: v.shouldRetry, reason: v.reason };
  }
  return { ok: true, reason: 'not_gated' };
}

/** The transient incompleteReason that puts a class under the file's SERP gate. */
function serpGateReason(gapClass) {
  return gapClass === 'NO_URL' ? 'no_url' : 'wrong_content';
}

/** Distinct reviews accepted (pending_push or recovered) on nowMs's UTC day. */
function acceptedToday(rows, nowMs = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const keys = new Set();
  for (const r of rows) {
    if ((r.outcome === 'recovered' || r.outcome === 'pending_push') && String(r.ts || '').slice(0, 10) === day) keys.add(r.reviewKey);
  }
  return keys.size;
}

const DEFAULT_DAILY_CEILING = 40;
function dailyCeiling(env = process.env) {
  const s = String(env.GAP_RECOVERY_DAILY_CEILING || '').trim();
  return /^\d+$/.test(s) ? Number(s) : DEFAULT_DAILY_CEILING;
}

/** True when today's accepted count (ledger + this run) has reached the ceiling. */
/** Per-run accepted cap (GAP_RECOVERY_RUN_CEILING), or null when unset. */
function runCeiling(env = process.env) {
  const s = String(env.GAP_RECOVERY_RUN_CEILING || '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

function ceilingReached({ rows, nowMs = Date.now(), ceiling, acceptedThisRun = 0 }) {
  return acceptedToday(rows, nowMs) + acceptedThisRun >= ceiling;
}

/**
 * Ceiling check for the NEXT attempt, read fresh from the shared ledger file
 * (BRO-7171): a start-of-run snapshot plus this run's own count never saw
 * another run's accepts, so two runs could each take the full daily ceiling.
 * Daily mode counts every accept in the file today (this run's pending_push
 * rows are already there); run mode (GAP_RECOVERY_RUN_CEILING) is a per-run
 * cap and counts only this run.
 */
function ceilingReachedNow({ file = ledgerPathDefault(), ceiling, runMode = false, acceptedThisRun = 0, nowMs = Date.now() }) {
  if (runMode) return acceptedThisRun >= ceiling;
  return acceptedToday(readRows(file), nowMs) >= ceiling;
}

function killSwitchPath() {
  return path.join(require('os').homedir(), '.broadwayscore-state', 'gap-recovery-disabled');
}

/** Kill switch: env GAP_RECOVERY_DISABLED=1/true/yes, or the state file exists. */
function killSwitchActive({ env = process.env, stateFileExists } = {}) {
  const v = String(env.GAP_RECOVERY_DISABLED || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return { active: true, why: 'env GAP_RECOVERY_DISABLED' };
  const exists = stateFileExists !== undefined ? stateFileExists : fs.existsSync(killSwitchPath());
  if (exists) return { active: true, why: `state file ${killSwitchPath()}` };
  return { active: false, why: null };
}

/**
 * The 'recovered' row for a path the checkpoint confirmed on origin/main.
 * `info` is what the driver recorded when it accepted the text.
 */
function recoveredRowFromLanding(landed, info = {}) {
  return makeRow({
    reviewKey: reviewKeyOf(landed.path || landed.absPath),
    gapClass: info.gapClass,
    strategy: info.strategy,
    outcome: 'recovered',
    reason: 'landed_on_origin_main',
    url: info.url,
    bytesBefore: info.bytesBefore,
    bytesAfter: info.bytesAfter,
    priorFullTextHash: info.priorFullTextHash,
    pushedBlob: landed.blob || null,
    runId: info.runId,
    detail: landed.commit ? { commit: landed.commit } : undefined,
  });
}

/**
 * Nightly reconcile (pure): every review whose latest row is 'recovered' but
 * whose recovered text is no longer on disk (fullText shorter than the row's
 * bytesAfter; tier !== complete for rows without bytesAfter) gets a 'reopened'
 * row (which also resets its strategy counts). A file that cannot be read reopens too.
 * @param {Array} rows all ledger rows
 * @param {(reviewKey:string) => object|null} readReview
 * @returns {Array} reopen rows to append
 */
function reconcileRecovered(rows, readReview, nowIso = new Date().toISOString()) {
  const out = [];
  for (const [key, list] of indexRows(rows)) {
    const last = list[list.length - 1];
    if (!last || last.outcome !== 'recovered') continue;
    const review = readReview(key);
    const tier = review ? review.contentTier || null : null;
    // The recovery is intact while the text it wrote is still on disk. A recovered
    // text may honestly be "truncated" (a paywalled outlet's partial body), so the
    // tier alone is not the test when the row knows how much it wrote; tier is the
    // fallback for rows without bytesAfter.
    const onDisk = review && typeof review.fullText === 'string' ? review.fullText.length : 0;
    const hasBytes = Number.isFinite(last.bytesAfter) && last.bytesAfter > 0;
    // 90%: a later whitespace/boilerplate trim of the recovered text is not a loss.
    if (review && (hasBytes ? onDisk >= Math.floor(last.bytesAfter * 0.9) : tier === 'complete')) continue;
    out.push(makeRow({
      ts: nowIso,
      reviewKey: key,
      gapClass: last.gapClass,
      strategy: last.strategy,
      outcome: 'reopened',
      reason: !review ? 'recovered_file_unreadable' : hasBytes ? 'recovered_text_lost' : 'recovered_file_not_complete',
      url: last.url,
      detail: { tier, recoveredAt: last.ts, pushedBlob: last.pushedBlob || null },
    }));
  }
  return out;
}

/**
 * Attempt info for every review whose latest live row is 'pending_push': the
 * fallback onLanded uses when a checkpoint lands work from an EARLIER run
 * (retryPendingPushes restores carry no driver meta), so those texts still get
 * their 'recovered' row instead of staying pending_push forever.
 * @returns {Map<string, object>} reviewKey -> info for recoveredRowFromLanding
 */
function pendingPushInfo(rows) {
  const out = new Map();
  for (const [key, list] of indexRows(rows)) {
    const last = liveRows(list).slice(-1)[0];
    if (!last || last.outcome !== 'pending_push') continue;
    out.set(key, {
      reviewKey: key, gapClass: last.gapClass, strategy: last.strategy, url: last.url,
      bytesBefore: last.bytesBefore, bytesAfter: last.bytesAfter, priorFullTextHash: last.priorFullTextHash, runId: last.runId,
    });
  }
  return out;
}

// Refusals from the write path itself (a race with another writer, the safe
// writer or the post-write check) say nothing about whether the source holds
// the review: they never count toward a cap.
// identity_check_unavailable: the LLM identity check errored (no verdict).
const WRITE_PATH_REFUSALS = new Set(['url_moved_during_fetch', 'write_refused', 'write_rolled_back', 'dry_run_needs_llm', 'identity_check_unavailable']);

/** Ledger outcome for a recoverReviewTextVerified refusal code. */
function outcomeForGateRefusal(code) {
  return WRITE_PATH_REFUSALS.has(code) ? 'non_evidence' : 'rejected';
}

/**
 * Records a person or a verdict owns: the acceptance gate refuses them before
 * looking at any text, so the driver must not spend a fetch on them.
 * (Mirrors gap-acceptance step 1; manually_verified/blocklisted need context
 * the planner lacks and are left to the gate.)
 * @returns {string|null} skip reason
 */
function ownedRecordReason(review) {
  if (!review) return null;
  if (review._locked === true) return 'locked';
  if (review.manualContentTier) return 'manual_tier';
  // Verdicts judged on a saved error page do not own the record: the real
  // review is looked for and they are voided on accept (BRO-7171 item a).
  if ((review.wrongShow || review.wrongProduction) && !require('./error-page-verdict').isErrorPageVerdictOnly(review)) return 'excluded_record';
  return null;
}

module.exports = {
  pendingPushInfo,
  outcomeForGateRefusal,
  ownedRecordReason,
  WRITE_PATH_REFUSALS,
  OUTCOMES,
  EVIDENCE_OUTCOMES,
  FETCH_STRATEGIES,
  DEFAULT_DAILY_CEILING,
  ledgerPathDefault,
  stateLedgerPath,
  manualRunShouldPublish,
  INERT_STRATEGIES,
  reviewKeyOf,
  makeRow,
  appendRows,
  readRows,
  indexRows,
  compareRows,
  liveRows,
  strategyState,
  evidenceStamp,
  strategyEligibility,
  serpGateReason,
  acceptedToday,
  dailyCeiling,
  runCeiling,
  ceilingReached,
  ceilingReachedNow,
  killSwitchPath,
  killSwitchActive,
  recoveredRowFromLanding,
  reconcileRecovered,
};
