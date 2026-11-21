'use strict';
/**
 * Silent-dispatch sweep (BRO-7554). Two blind spots the other sweeps leave:
 *
 * 1. A headless job posts "Dispatched <id> to <ref> at <ts> (headless)" only after it ends (BRO-7116)
 *    and moves no state. If it ended without a report, no push, no claim, the card keeps saying
 *    Todo / In Progress / In Review and nothing looks at it: the Mac stall sweep skips any card with a
 *    ledger row in 26h, the 48h reclaim covers In Progress and a narrow In Review shape only.
 *    30 days to 2026-11-15: 103 cards carried such a comment, none labelled mac-only.
 *    Rule: the newest Dispatched comment is DISPATCH_SILENT_MS old, nothing human, no report and no
 *    claim, report or human comment since the previous holder, no land/ push since and nothing landed on main.
 *    Stage 1 (4h): a SILENT_DISPATCH_MARKER note. Stage 2 (26h, only with --requeue): requeue to Todo so a cloud
 *    worker takes it (cloud-worker-pick). Shares the reclaim
 *    count (RECLAIM_MARKER) so a card that keeps going silent ends in Backlog.
 *
 * 2. A land/** ref whose latest Land run failed and whose card never mentions that run (BRO-7523: two
 *    failed runs, card still said "in progress"). Action: one LAND_FAILED_MARKER comment per run id.
 *
 * Pure functions. The CLI is `scripts/linear-reclaim-abandoned.js --silent-dispatch-sweep`.
 */
const { RECLAIM_MARKER, MAX_RECLAIMS, NO_RECLAIM_RE, OWNER_CARD_RE } = require('./linear-reclaim-abandoned.js');

const HOUR_MS = 60 * 60 * 1000;
const DISPATCH_SILENT_MS = 4 * HOUR_MS;
// Requeue waits as long as the Mac dispatcher's own resume window (stalled-session-sweep LOCAL_LEDGER_QUIET_MS): CI cannot read that ledger.
const REQUEUE_SILENT_MS = 26 * HOUR_MS;
const LOOKBACK_NO_PRIOR_MS = 48 * HOUR_MS;
const MAX_REQUEUES_PER_RUN = 5;
const MAX_LAND_NOTES_PER_RUN = 10;
const SILENT_DISPATCH_MARKER = 'SILENT-DISPATCH:';
const LAND_FAILED_MARKER = 'LAND-FAILED-UNSEEN:';
const WATCHED_STATES = new Set(['Todo', 'In Progress', 'In Review']);
const DISPATCH_RE = /^Dispatched\b/;
const HEADLESS_DISPATCH_RE = /^Dispatched\b.*\(headless\)\s*$/;
const CLAIM_RE = /^Claimed by /;
const ms = (c) => Date.parse(c && c.createdAt);

function macOnly(issue) {
  const labels = ((issue && issue.labels && issue.labels.nodes) || []).map((l) => String(l.name || '').toLowerCase());
  return labels.includes('mac-only') || /^\s*MAC-ONLY\s*:/im.test((issue && issue.description) || '');
}

/** A comment nobody typed: dispatch receipt, claim, reclaim or silent-dispatch note, headless end note, failed-land note. */
function isMachineComment(c) {
  const { HEADLESS_END_MARKER } = require('./linear-session-reporting.js');
  const { isMachineComment: pickerMachine } = require('./cloud-worker-pick.js'); // one shared machine-comment list
  const b = String((c && c.body) || '').trim();
  return pickerMachine(b) || DISPATCH_RE.test(b) || CLAIM_RE.test(b) || b.startsWith(RECLAIM_MARKER) || b.startsWith(SILENT_DISPATCH_MARKER)
    || b.startsWith(LAND_FAILED_MARKER) || b.startsWith(HEADLESS_END_MARKER);
}

/**
 * @param {{issue:object, comments:Array<{body:string,createdAt:string}>, lastPushMs?:?number, pushUnknown?:boolean,
 *   landedSince?:boolean, requeueEnabled?:boolean, nowMs:number, silentMs?:number, requeueMs?:number}} p
 *   lastPushMs: newest activity of any land/ ref naming the card (null: none). pushUnknown: a ref's age could not be read.
 *   landedSince: main has a commit naming the card since the dispatch (land.yml deletes the ref after landing, so a
 *   ref check alone cannot see landed work).
 * @returns {{action:'skip', reason:string} | {action:'flag'|'requeue'|'backlog', dispatchAt:string, silentHours:number, reclaims:number, priorState:string}}
 */
function silentDispatchDecision({ issue, comments, lastPushMs = null, pushUnknown = false, landedSince = false, requeueEnabled = false,
  nowMs, silentMs = DISPATCH_SILENT_MS, requeueMs = REQUEUE_SILENT_MS }) {
  if (!issue || !issue.state || !WATCHED_STATES.has(issue.state.name)) return { action: 'skip', reason: 'state' };
  if (OWNER_CARD_RE.test(issue.title || '')) return { action: 'skip', reason: 'owner-card' };
  if (NO_RECLAIM_RE.test(issue.description || '')) return { action: 'skip', reason: 'opted-out' };
  if (macOnly(issue)) return { action: 'skip', reason: 'mac-only' };
  const list = (Array.isArray(comments) ? comments : []).filter((c) => c && Number.isFinite(ms(c)));
  // The headless receipt and its end note are both posted AFTER the job ends (linear-next.js, BRO-7116), so the worker's
  // own report and claim sit BEFORE the receipt. Look from the previous holder (claim or earlier receipt) to now.
  const dispatch = list.filter((c) => HEADLESS_DISPATCH_RE.test(String(c.body || '').trim())).sort((a, b) => ms(b) - ms(a))[0];
  if (!dispatch) return { action: 'skip', reason: 'no-headless-dispatch' };
  const age = nowMs - ms(dispatch);
  if (age < silentMs) return { action: 'skip', reason: 'recent-dispatch' };
  const holders = list.filter((c) => c !== dispatch && (CLAIM_RE.test(String(c.body || '').trim()) || DISPATCH_RE.test(String(c.body || '').trim())));
  if (holders.some((c) => ms(c) > ms(dispatch))) return { action: 'skip', reason: 'claimed-after-dispatch' };
  const prior = holders.filter((c) => ms(c) < ms(dispatch)).sort((a, b) => ms(b) - ms(a))[0];
  const startMs = prior ? ms(prior) : ms(dispatch) - LOOKBACK_NO_PRIOR_MS; // no prior holder: do not let a years-old comment block the card
  if (list.some((c) => c !== dispatch && ms(c) > startMs && !isMachineComment(c))) return { action: 'skip', reason: 'report-or-human-activity' };
  if (list.some((c) => ms(c) > ms(dispatch) && String(c.body || '').trim().startsWith(SILENT_DISPATCH_MARKER))) {
    if (!(requeueEnabled && age >= requeueMs)) return { action: 'skip', reason: 'already-flagged' };
  }
  if (pushUnknown) return { action: 'skip', reason: 'push-time-unknown' };
  if (Number.isFinite(lastPushMs) && lastPushMs > ms(dispatch)) return { action: 'skip', reason: 'push-after-dispatch' };
  if (landedSince) return { action: 'skip', reason: 'landed-since-dispatch' };
  const reclaims = list.filter((c) => String(c.body || '').includes(RECLAIM_MARKER)).length;
  const base = { dispatchAt: dispatch.createdAt, silentHours: Math.floor(age / HOUR_MS), reclaims, priorState: issue.state.name };
  if (!requeueEnabled || age < requeueMs) return { action: 'flag', ...base };
  if (issue.state.name === 'Todo') return { action: 'skip', reason: 'already-todo' };
  return { action: reclaims >= MAX_RECLAIMS ? 'backlog' : 'requeue', ...base };
}

/** Flag-only note (advisory stage). */
function buildSilentDispatchComment(d, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return [
    `${SILENT_DISPATCH_MARKER} ${day} (BRO-7554 hourly sweep)`,
    '',
    `The headless dispatch at ${d.dispatchAt} left no session report, no claim and no land/ push for ${d.silentHours}h. The card is ${d.priorState}. ${d.priorState === 'Todo' ? 'It is already Todo, so a cloud worker can take it.' : `If nothing changes it goes back to Todo for a cloud worker after ${Math.round(REQUEUE_SILENT_MS / HOUR_MS)}h.`}`,
    '',
    'To keep a card put aside, add a `NO-RECLAIM: <reason>` line to its description.',
  ].join('\n');
}

/** Requeue note. Starts with RECLAIM_MARKER so the 48h reclaim's count and every machine-comment filter already read it. */
function buildSilentRequeueComment(d, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return [
    `${RECLAIM_MARKER} ${day} (BRO-7554 silent headless dispatch)`,
    '',
    `The headless dispatch at ${d.dispatchAt} left no session report, no claim and no land/ push for ${d.silentHours}h, so the job is presumed dead. The card was ${d.priorState}.`,
    d.action === 'backlog'
      ? `It has been reclaimed ${d.reclaims} times already, so it goes to Backlog instead of Todo. Someone should read the history before it is retried.`
      : 'Moved back to Todo so a cloud worker can take it (a land/ branch naming it is resumed, not redone).',
  ].join('\n');
}

/**
 * Failed Land runs the card never mentions.
 * @param {{runs:Array<{ref:string, runId:number|string, conclusion:?string, url:?string, at:?string}>, comments:Array<{body:string}>}} p
 *   runs: the LATEST land.yml run per land/ ref naming this card.
 * @returns {Array<{ref:string, runId:string, url:?string}>}
 */
function unseenFailedLandRuns({ runs, comments }) {
  const text = (Array.isArray(comments) ? comments : []).map((c) => String((c && c.body) || '')).join('\n');
  return (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.conclusion === 'failure' && r.runId != null && !text.includes(String(r.runId)))
    .map((r) => ({ ref: r.ref, runId: String(r.runId), url: r.url || null }));
}

function buildLandFailedComment(items) {
  return [
    `${LAND_FAILED_MARKER} Land run(s) for this card failed and nothing on the card mentions them (BRO-7554 hourly sweep).`,
    '',
    ...items.map((i) => `- ${i.ref}: run ${i.runId}${i.url ? ` ${i.url}` : ''}`),
    '',
    'The worker holding this card should read the failing gate, fix it on the same land/ ref and follow the next run. If nobody holds it, the card is eligible for a cloud worker resume.',
  ].join('\n');
}

module.exports = {
  DISPATCH_SILENT_MS, REQUEUE_SILENT_MS, MAX_REQUEUES_PER_RUN, MAX_LAND_NOTES_PER_RUN, SILENT_DISPATCH_MARKER, LAND_FAILED_MARKER, WATCHED_STATES,
  isMachineComment, silentDispatchDecision, buildSilentDispatchComment, buildSilentRequeueComment, unseenFailedLandRuns, buildLandFailedComment,
};
