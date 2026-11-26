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
  // BRO-7944 diagnostics: content tier at attempt time, HTTP status and error text (null when not applicable).
  if (r.tier) row.tier = String(r.tier);
  if (Number.isFinite(r.httpStatus)) row.httpStatus = r.httpStatus;
  if (r.error) row.error = String(r.error).slice(0, 200);
  row.seq = Number.isFinite(r.seq) ? r.seq : ++_seq;
  if (r.retryAfter) row.retryAfter = r.retryAfter;
  if (r.abandoned) row.abandoned = true;
  if (r.runId) row.runId = r.runId;
  if (r.detail) row.detail = r.detail;
  return row;
}

/**
 * BRO-7944: true when this review+strategy's latest live row is a non-evidence outcome
 * newer than GAP_NON_EVIDENCE_COOLDOWN_MIN (default 60). Non-evidence never counts toward
 * the retry caps, so without this a batch's next round redoes it straight away.
 */
function recentNonEvidence(rows, strategy, nowMs = Date.now(), env = process.env) {
  const mins = Number(env.GAP_NON_EVIDENCE_COOLDOWN_MIN);
  const ms = (Number.isFinite(mins) && mins >= 0 ? mins : 60) * 60000;
  let last = null;
  for (const r of rows || []) if (r.strategy === strategy && r.outcome !== 'reopened') last = (!last || tsMs(r) >= tsMs(last)) ? r : last;
  return !!last && last.outcome === 'non_evidence' && nowMs - tsMs(last) < ms;
}

/** HTTP status embedded in an error message ("HTTP 403", "Bright Data HTTP 429: ..."), or null. */
function httpStatusFrom(message) {
  const m = /\bHTTP[ /]?(\d{3})\b/i.exec(String(message || '')) || /\b(?:status(?:Code)?|code)[ :=]+([1-5]\d{2})\b/i.exec(String(message || ''));
  return m ? Number(m[1]) : null;
}

/**
 * BRO-7944: diagnostics every refused attempt row must carry (the url the attempt
 * used, how many bytes the candidate text had, the tier of the record, and the HTTP
 * status or error). `got` = strategy result, `r` = acceptance result, `c` = candidate.
 * Never returns an undefined key: `{...extra}` spreads must not blank the url.
 */
function refusalDiagnostics({ c = {}, got = {}, r = null }) {
  const raw = typeof got.rawText === 'string' ? got.rawText.length : null;
  const out = {
    url: got.url || c.url || null,
    bytesAfter: r && Number.isFinite(r.newLen) ? r.newLen : (raw !== null ? raw : (got.ok === false ? 0 : null)),
    tier: (r && r.decision && r.decision.priorTier) || c.contentTier || null,
    httpStatus: Number.isFinite(got.httpStatus) ? got.httpStatus : httpStatusFrom(got.error || got.reason),
    error: got.error || (r && r.reason ? String(r.reason) : null) || (got.reason ? String(got.reason) : null),
  };
  return out;
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
  // BRO-7962 review: a bot check / paywall is no access on this route, not a page
  // that serves the wrong content; it takes the 5-failure path, not the strict 3.
  if (row.outcome === 'rejected' && require('./gap-strategies').WALLED_REASONS.has(row.reason)) return 'all_tiers_failed';
  if (row.outcome === 'rejected') return 'garbage_content'; // the page serves content, never this review
  return FF_REASONS.has(row.reason) ? row.reason : 'fetch_error';
}

/**
 * Derived per (review, strategy) state.
 * @returns {{evidenceAttempts:number, lastPolicyReason:string|null, retryAfter:string|null, abandoned:boolean, lastTs:string|null, nonEvidence:number}}
 */
function strategyState(index, reviewKey, strategy) {
  const all = index.get(reviewKey) || [];
  const rows = liveRows(all).filter((r) => r.strategy === strategy);
  // Urls where another writer replaced a raw-HTML recovery (read across every
  // reopen, not reset by one): re-accepting there with any raw-HTML strategy
  // brings the same page chrome back, i.e. the nightly loop.
  const supersededUrls = RAW_HTML_STRATEGIES.has(strategy)
    ? all.filter((r) => r.outcome === 'reopened' && r.reason === SUPERSEDED_REASON && r.url).map((r) => r.url)
    : [];
  // Urls (one entry per loss) where a REFETCH_FREE recovery was lost: another
  // writer put a shorter text back. Read across every reopen; compared
  // canonically at eligibility time (12 reviews traded nightly by 2026-11-15,
  // all REFETCH_FREE; jena-friedman thecomedybureau 4x).
  // One entry per lost recovery (detail.recoveredAt): the same loss reconciled
  // on two machines is two rows but one trade.
  const lostFreeUrls = [];
  if (strategy === 'REFETCH_FREE') {
    const seen = new Set();
    for (const r of all) {
      if (r.outcome !== 'reopened' || r.reason !== LOST_REASON || !r.url || r.strategy !== 'REFETCH_FREE') continue;
      const id = `${r.url}|${(r.detail && r.detail.recoveredAt) || r.ts}`;
      if (!seen.has(id)) { seen.add(id); lostFreeUrls.push(r.url); }
    }
  }
  const st = { evidenceAttempts: 0, lastPolicyReason: null, retryAfter: null, abandoned: false, lastTs: null, nonEvidence: 0, supersededUrls, lostFreeUrls };
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
  // The block holds only while the newer writer's text is still substantive:
  // once it degrades to a stub, recovering at the url is worth trying again.
  if (state && Array.isArray(state.supersededUrls) && state.supersededUrls.length && isSubstantiveText(review) && /^https?:\/\//i.test(String(review.url || ''))) {
    const { urlCanonicallyChanged } = require('./url-change-invariant');
    if (state.supersededUrls.some((u) => !urlCanonicallyChanged(u, review.url))) {
      return { ok: false, reason: 'superseded_at_url' };
    }
  }
  // A free refetch here was lost LOST_LOOP_AT times: a third accept is the
  // same trade (the engine's raw-HTML read keeps page chrome the collector's
  // cleaner read drops). Only REFETCH_FREE stops: ARCHIVE / PAID_FETCH /
  // BROWSER_SESSION / URL_REDISCOVER may still bring a clean text or a new url
  // (a url change lifts the block). The gap stays open and counted.
  if (state && Array.isArray(state.lostFreeUrls) && state.lostFreeUrls.length && /^https?:\/\//i.test(String(review.url || ''))) {
    const { urlCanonicallyChanged } = require('./url-change-invariant');
    if (state.lostFreeUrls.filter((u) => !urlCanonicallyChanged(u, review.url)).length >= LOST_LOOP_AT) return { ok: false, reason: 'lost_loop_at_url' };
  }
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
    detail: tierDetail(landed, info),
  });
}

/**
 * BRO-8276: rows for a landing. A text carried onto a successor file (the
 * path was renamed upstream) closes the old key's pending_push row with a
 * non_evidence 'renamed_upstream' row and records 'recovered' on the new key.
 * @param {object} landed  checkpoint onLanded payload (renamedFrom optional)
 * @param {object} info    attempt info (recoveredRowFromLanding)
 */
function landingRows(landed, info = {}) {
  const rec = recoveredRowFromLanding(landed, info);
  if (!landed.renamedFrom) return [rec];
  // One ms after the recovered row, so it never sorts before the pending_push it closes.
  const ts = new Date(Date.parse(rec.ts) + 1).toISOString();
  return [rec, makeRow({ ts, reviewKey: reviewKeyOf(landed.renamedFrom), gapClass: info.gapClass, strategy: info.strategy, outcome: 'non_evidence', reason: 'renamed_upstream', url: info.url, runId: info.runId, detail: { successor: rec.reviewKey } })];
}

/** BRO-8276: the attempt info for a landing, looked up by its key or the key it was renamed from. */
function landingInfo(landed, lookup) {
  const key = reviewKeyOf(landed.path || landed.absPath);
  return lookup(key) || (landed.renamedFrom ? lookup(reviewKeyOf(landed.renamedFrom)) : null) || null;
}

/** BRO-8276: closes a pending_push row whose file was removed upstream with no successor. */
function goneUpstreamRow(rel, info = {}, why = null) {
  return makeRow({ ts: new Date(Date.now() + 1).toISOString(), reviewKey: reviewKeyOf(rel), gapClass: info.gapClass, strategy: info.strategy, outcome: 'non_evidence', reason: 'gone_upstream', url: info.url, runId: info.runId, detail: why ? { why } : undefined });
}

function tierDetail(landed, info) {
  const d = {
      ...(landed.commit ? { commit: landed.commit } : {}),
      // BRO-7942: "recovered" counts only when the tier went up (143 of 464 recovered keys were still truncated).
      ...(info.newTier ? { priorTier: info.priorTier || null, newTier: info.newTier, tierImproved: tierImproved(info.priorTier, info.newTier) } : {}),
  };
  return Object.keys(d).length ? d : undefined;
}

const TIER_ORDER = { invalid: 0, stub: 1, excerpt: 2, truncated: 3, complete: 4 };
/** Did the accepted text raise the content tier? An unknown prior tier counts as the lowest. */
function tierImproved(priorTier, newTier) {
  const n = TIER_ORDER[newTier];
  if (n === undefined) return false;
  const p = TIER_ORDER[priorTier];
  return p === undefined ? true : n > p;
}

// Reopen reason for a recovery another writer replaced by re-fetching the
// SAME url after it landed (BRO-7171, 2026-11-13). The collector reads the live
// page's article body; the engine parses raw HTML, which keeps blog footers,
// "you might also like" lists and a second show's section of a joint column.
// 24 of 54 reopens 2026-11-09..13 were this, and the engine re-accepted the
// same chrome the next night (ilford-boy revstan: 2468 -> 1383 -> 2468 ...),
// re-flagging a paid rescore each cycle. The newer writer's text stands; the
// same strategy is not retried at that url (other strategies still are).
const SUPERSEDED_REASON = 'recovered_text_superseded';
const LOST_REASON = 'recovered_text_lost';
// Lost reopens of a REFETCH_FREE recovery at one url before REFETCH_FREE stops there.
const LOST_LOOP_AT = 2;
// Below these the newer text is itself a gap (a stub, a wall): a real loss.
const SUPERSEDE_MIN_CHARS = 500;
const SUPERSEDE_TIERS = new Set(['complete', 'truncated']);
// A newer text under this share of the recovered bytes looks like a teaser
// cut, not a cleaner extraction of the same article.
const SUPERSEDE_MIN_RATIO = 0.4;
// Strategies that extract the article from raw HTML (gap-strategies fromHtml),
// where the collector reads the same page with a cleaner extractor. A
// BROWSER_SESSION recovery is subscriber text the collector cannot see (NYT
// the-unbelievers 2026-11-09: 5389 subscriber chars, later a 2399-char
// browserbase cut labelled complete): its replacement stays a loss and alerts.
const RAW_HTML_STRATEGIES = new Set(['REFETCH_FREE', 'PAID_FETCH', 'ARCHIVE', 'URL_FIND', 'URL_REDISCOVER']);
// Of those, the ones whose recovery a same-url collector fetch can supersede
// (ARCHIVE/PAID_FETCH texts may hold what the live free page no longer has).
const SUPERSEDABLE_STRATEGIES = new Set(['REFETCH_FREE', 'URL_FIND', 'URL_REDISCOVER']);

function isSubstantiveText(review) {
  const text = review && typeof review.fullText === 'string' ? review.fullText : '';
  return text.length >= SUPERSEDE_MIN_CHARS && SUPERSEDE_TIERS.has(review.contentTier);
}

/**
 * Did a different writer re-fetch the recovered url after the recovery landed
 * and store a substantive text? Pure.
 * @param {object} review file on disk
 * @param {object} recoveredRow the latest 'recovered' row
 */
function supersededByLaterFetch(review, recoveredRow) {
  if (!review || !recoveredRow || !review.url || !recoveredRow.url) return false;
  if (!SUPERSEDABLE_STRATEGIES.has(recoveredRow.strategy)) return false;
  if (!/^https?:\/\//i.test(String(review.url))) return false;
  if (require('./url-change-invariant').urlCanonicallyChanged(recoveredRow.url, review.url)) return false;
  const fetchedMs = Date.parse(review.textFetchedAt || '');
  const recMs = Date.parse(recoveredRow.ts || '');
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(recMs) || fetchedMs <= recMs) return false;
  // The engine's own writes stamp textFetchedAt before its recovered row, so
  // the time test already excludes them; the label check is belt and braces.
  if (/^gap-recovery/.test(String(review.fetchMethod || ''))) return false;
  if (!isSubstantiveText(review)) return false;
  const bytes = Number(recoveredRow.bytesAfter);
  if (Number.isFinite(bytes) && bytes > 0 && review.fullText.length < bytes * SUPERSEDE_MIN_RATIO) return false;
  return true;
}

/**
 * BRO-8276: read a review by its ledger key, following a rename. A key whose
 * file was renamed after its text landed (byline resolved: --unknown ->
 * --<critic>) is read from the file stamped `_renamedFrom.file === key` in
 * the same show dir. Duplicate deletion and outlet corrections may leave no
 * stamp: use the recovered article plus a known critic to find its surviving
 * copy. An unknown critic may only match within the same outlet. Ambiguous
 * matches stay unreadable; this never changes the successor's flags or text.
 * @returns {object|null}
 */
function readReviewFollowingRename(dir, key, recoveredRow = {}) {
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const direct = path.join(dir, key);
  if (fs.existsSync(direct)) return read(direct);
  const showDir = path.join(dir, path.dirname(key));
  let names = [];
  try { names = fs.readdirSync(showDir).filter((n) => n.endsWith('.json')); } catch { return null; }
  const records = names.map((name) => ({ name, review: read(path.join(showDir, name)) })).filter((r) => r.review);
  const stamped = records.filter(({ review }) => review._renamedFrom && review._renamedFrom.file === key);
  if (stamped.length) return stamped.length === 1 ? stamped[0].review : null;

  const { normalizeUrl, normalizeCritic, normalizeOutlet } = require('./review-normalization');
  // urlCanonicallyChanged treats malformed URLs as unchanged, so it cannot
  // establish article identity here. Validate before comparing canonical URLs.
  const articleKey = (url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || /\s/.test(url) || url.includes('undefined')) return null;
    try { new URL(url); return normalizeUrl(url); } catch { return null; }
  };
  const url = articleKey(recoveredRow && recoveredRow.url);
  if (!url) return null;
  const [outlet, critic] = path.basename(key, '.json').split('--');
  if (!outlet || !critic) return null;
  const criticId = normalizeCritic(critic);
  const outletId = normalizeOutlet(outlet);
  const hits = records.filter(({ name, review }) => {
    if (articleKey(review.url) !== url) return false;
    if (review.criticName != null && typeof review.criticName !== 'string') return false;
    if (review.outletId != null && typeof review.outletId !== 'string') return false;
    const [fileOutlet, fileCritic] = path.basename(name, '.json').split('--');
    // Stored bylines take precedence over stale filenames after corrections.
    const candidateCritic = normalizeCritic(review.criticName || fileCritic);
    if (criticId !== 'unknown') return candidateCritic === criticId;
    return normalizeOutlet(review.outletId || fileOutlet) === outletId;
  });
  return hits.length === 1 ? hits[0].review : null;
}

/**
 * Nightly reconcile (pure): every review whose latest row is 'recovered' but
 * whose recovered text is no longer on disk (fullText shorter than the row's
 * bytesAfter; tier !== complete for rows without bytesAfter) gets a 'reopened'
 * row (which also resets its strategy counts). A file that cannot be read reopens too.
 * @param {Array} rows all ledger rows
 * @param {(reviewKey:string, recoveredRow:object) => object|null} readReview
 * @returns {Array} reopen rows to append
 */
function reconcileRecovered(rows, readReview, nowIso = new Date().toISOString()) {
  const out = [];
  for (const [key, list] of indexRows(rows)) {
    const last = list[list.length - 1];
    if (!last || last.outcome !== 'recovered') continue;
    const review = readReview(key, last);
    const tier = review ? review.contentTier || null : null;
    // The recovery is intact while the text it wrote is still on disk. A recovered
    // text may honestly be "truncated" (a paywalled outlet's partial body), so the
    // tier alone is not the test when the row knows how much it wrote; tier is the
    // fallback for rows without bytesAfter.
    const onDisk = review && typeof review.fullText === 'string' ? review.fullText.length : 0;
    const hasBytes = Number.isFinite(last.bytesAfter) && last.bytesAfter > 0;
    // 90%: a later whitespace/boilerplate trim of the recovered text is not a loss.
    if (review && (hasBytes ? onDisk >= Math.floor(last.bytesAfter * 0.9) : tier === 'complete')) continue;
    const superseded = supersededByLaterFetch(review, last);
    out.push(makeRow({
      ts: nowIso,
      reviewKey: key,
      gapClass: last.gapClass,
      strategy: last.strategy,
      outcome: 'reopened',
      reason: !review ? 'recovered_file_unreadable' : superseded ? SUPERSEDED_REASON : hasBytes ? LOST_REASON : 'recovered_file_not_complete',
      url: last.url,
      detail: {
        tier, recoveredAt: last.ts, pushedBlob: last.pushedBlob || null,
        ...(superseded ? { supersededBy: review.fetchMethod || null, supersededAt: review.textFetchedAt, bytesOnDisk: onDisk } : {}),
      },
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
      priorTier: (last.detail && last.detail.priorTier) || null, newTier: (last.detail && last.detail.newTier) || null,
      acceptedHash: (last.detail && last.detail.acceptedHash) || null,
    });
  }
  return out;
}

// Refusals from the write path itself (a race with another writer, the safe
// writer or the post-write check) say nothing about whether the source holds
// the review: they never count toward a cap.
// identity_check_unavailable: the LLM identity check errored (no verdict).
const WRITE_PATH_REFUSALS = new Set(['url_moved_during_fetch', 'write_refused', 'write_rolled_back', 'url_pinned', 'dry_run_needs_llm', 'identity_check_unavailable']);

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

/**
 * BRO-7943: a manual tier pin judged on a paywalled or partial fetch outlives
 * the text it was judged on. The full text arrives later (another collector),
 * the pin keeps the review "truncated"/"stub", and ownedRecordReason keeps
 * every recovery route away from it: the gap never closes and never shows as
 * attempted (Paranormal Activity NYT, pinned on a 2,913-char JS wall, held
 * 9,381 chars of full review three months later). True when the pin is not
 * "complete" but the text, classified without the pin, is complete.
 * @param {object} review
 * @param {(r:object)=>{contentTier:string}} classify  content-quality classifyContentTier
 */
function isStaleManualTierPin(review, classify) {
  if (!review || !review.manualContentTier || review.manualContentTier === 'complete') return false;
  if (review.manualContentTier === 'invalid') return false; // a verdict on the record, not on text length
  const { manualContentTier, ...rest } = review;
  try { return classify(rest).contentTier === 'complete'; } catch { return false; }
}

// A review file another writer renamed or deleted after the plan was built
// (byline fix artshub--unknown -> artshub--<critic>, dedup, merge). Only this
// candidate's own file counts: any other missing file is a real fault and
// must still stop the run. BRO-7171 2026-11-15: one rename killed the night.
function isVanishedReviewFile(err, filePath) {
  if (!err || err.code !== 'ENOENT' || !filePath || !err.path) return false;
  if (path.resolve(err.path) !== path.resolve(filePath)) return false;
  return !fs.existsSync(filePath);
}

module.exports = {
  readReviewFollowingRename,
  landingRows,
  landingInfo,
  goneUpstreamRow,
  isStaleManualTierPin,
  tierImproved,
  recentNonEvidence,
  httpStatusFrom,
  refusalDiagnostics,
  isVanishedReviewFile,
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
  supersededByLaterFetch,
  SUPERSEDED_REASON,
  LOST_REASON,
  LOST_LOOP_AT,
};
