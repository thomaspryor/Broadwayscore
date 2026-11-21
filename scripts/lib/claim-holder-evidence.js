'use strict';
// BRO-7553. The I/O half of the claim guard's holder-liveness test: a holder's pushes (its land/ branch tip,
// the latest Land run on it) and its dispatch-ledger rows. Best effort and bounded: anything unreadable
// (no gh, no ledger in a cloud container, a timeout) yields no evidence, which leaves the guard on the
// conservative side (a holder with no proof of death stays live).
const { execFileSync } = require('child_process');
const { landRefCardNumber } = require('./cloud-worker-pick.js');

const GH_TIMEOUT_MS = 8000;
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

function ghJson(args) {
  const { runGhWithFallback } = require('./land-retry-on-cancel');
  const exec = (cmd, a, o) => execFileSync(cmd, a, { ...o, timeout: GH_TIMEOUT_MS });
  return JSON.parse(runGhWithFallback(args, { exec, fallbackToken: process.env.GH_FALLBACK_TOKEN }));
}

/** Newest of the land/ refs naming this card: latest Land run (conclusion, time) and tip commit time. */
function landingEvidence(identifier, gh = ghJson) {
  const n = Number(String(identifier).split('-')[1]);
  const refs = (gh([`repos/${REPO}/git/matching-refs/heads/land`]) || [])
    .map((r) => ({ ref: r.ref.replace(/^refs\/heads\//, ''), sha: r.object.sha }))
    .filter((r) => landRefCardNumber(r.ref) === n);
  let lastPushMs = null;
  let landing = null;
  for (const r of refs) {
    const commit = gh([`repos/${REPO}/commits/${r.sha}`]);
    const pushed = Date.parse(commit && commit.commit && commit.commit.committer && commit.commit.committer.date);
    if (Number.isFinite(pushed) && (lastPushMs === null || pushed > lastPushMs)) lastPushMs = pushed;
    const run = ((gh([`repos/${REPO}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(r.ref)}&per_page=1`]) || {}).workflow_runs || [])[0];
    const at = run && Date.parse(run.updated_at || run.created_at);
    if (run && run.status === 'completed' && Number.isFinite(at) && (!landing || at > landing.atMs)) landing = { conclusion: run.conclusion, atMs: at };
  }
  return { lastPushMs, landing };
}

/**
 * Latest ledger row for the card or the holder's session id (Mac only; absent elsewhere), and when the job
 * ended if that latest row is a finished-job event (a finished job cannot still be working the card).
 */
function ledgerEvidence(identifier, holderRef, readEntries = () => require('./dispatch-ledger.js').readEntries()) {
  const { JOB_EVENTS } = require('./dispatch-ledger.js');
  const ENDED = new Set([JOB_EVENTS.DONE, JOB_EVENTS.FAILED, JOB_EVENTS.ORPHANED, JOB_EVENTS.BLOCKED, JOB_EVENTS.STOPPED_SHORT, JOB_EVENTS.STRANDED]);
  const id = (String(holderRef).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || [])[1];
  let last = null;
  let lastRow = null;
  for (const r of readEntries()) {
    if (!new RegExp(`^linear:${identifier}(?:-|$)`).test(String(r.taskId || '')) && !(id && String(r.sessionId || '').toLowerCase() === id.toLowerCase())) continue;
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && (last === null || t >= last)) { last = t; lastRow = r; }
  }
  return { lastLedgerMs: last, jobEndedMs: lastRow && ENDED.has(lastRow.event) ? last : null };
}

function gatherHolderEvidence({ identifier, holderRef }) {
  const out = { lastPushMs: null, lastLedgerMs: null, jobEndedMs: null, landing: null };
  try { Object.assign(out, landingEvidence(identifier)); } catch (e) { console.error(`[linear-session] holder evidence: land lookup skipped (${String(e.message).split('\n')[0]})`); }
  try { Object.assign(out, ledgerEvidence(identifier, holderRef)); } catch { /* no ledger here */ }
  return out;
}

module.exports = { gatherHolderEvidence, landingEvidence, ledgerEvidence };
