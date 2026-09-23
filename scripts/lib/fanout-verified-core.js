/**
 * fanout-verified-core.js — the pure decision behind scripts/fanout-verified.js.
 *
 * Owner escalation 2026-09-20 (BRO-3939): "sometimes they say CLOSE ME even
 * though that would leave no one truly checking if the full suite of things
 * worked. They just spawned one or many targeted sessions and hope for the
 * best. That NEVER works." Gate O v2 (~/.claude/hooks/exit-status-gate.sh)
 * already refuses CLOSE ME until every dispatched child has landed; the gap
 * is the COMBINED result — N per-child LANDED lines say nothing about whether
 * the children's work functions together. This module decides whether a
 * `fanout-verified` ledger row may be written: the row is the proof Gate O
 * reads when a session dispatched two or more children and wants to close.
 *
 * Preconditions (each refusal is a real precondition, not a formality):
 *   - at least two refs (one child's own LANDED acceptance IS the combined
 *     check; this row exists for fan-outs);
 *   - every ref's newest ledger row is landed (job-done, landed-acked newer
 *     than any bad row, or prune-closed with a ✅ mark) — a fan-out check run
 *     before a child finished proves nothing about that child;
 *   - the verify command is safe-form (scripts/lib/autonomous-triage-core.js
 *     SAFE_CHECK_FORMS) and exited 0 in the CLI's real run;
 *   - the reason names what the command exercised across the children.
 * Pure: no fs, no child processes. CLAUDE.md §15 — the test require()s this.
 */
'use strict';

const { rowsForRef, normalizeRef } = require('./ack-landed-core.js');

const MIN_REFS = 2;
const MIN_REASON_CHARS = 15;
const FANOUT_EVENT = 'fanout-verified';
const LANDED_EVENTS = new Set(['job-done', 'landed-acked']);
const BAD_EVENTS = new Set(['job-orphaned', 'job-failed', 'job-stopped-short', 'job-stranded',
  'job-abandoned', 'job-blocked']);
const RELAUNCH_EVENTS = new Set(['launch', 'job-spawned', 'watchdog-redispatch', 'job-retried']);

/** Newest-row-wins landing verdict for one ref, mirroring Gate O v2. */
function landingState(rows) {
  let state = { landed: false, detail: 'no ledger row for this ref', ts: '' };
  let lastBadTs = '';
  for (const row of rows) {
    const ev = String(row.event || '');
    const ts = String(row.ts || '');
    if (LANDED_EVENTS.has(ev)) {
      if (ev === 'landed-acked' && ts <= lastBadTs) {
        state = { landed: false, detail: `${ev} ${ts.slice(0, 19)} is not newer than the last bad row ${lastBadTs.slice(0, 19)}`, ts };
      } else {
        state = { landed: true, detail: `${ev} ${ts.slice(0, 19)}`, ts };
      }
    } else if (ev === 'prune-closed') {
      const marks = String(row.title || '') + String(row.subject || '');
      state = marks.includes('✅')
        ? { landed: true, detail: `${ev} ✅ ${ts.slice(0, 19)}`, ts }
        : { landed: false, detail: `${ev} without ✅ ${ts.slice(0, 19)}`, ts };
      if (!state.landed) lastBadTs = ts > lastBadTs ? ts : lastBadTs;
    } else if (BAD_EVENTS.has(ev) || RELAUNCH_EVENTS.has(ev)) {
      state = { landed: false, detail: `${ev} ${ts.slice(0, 19)}`, ts };
      lastBadTs = ts > lastBadTs ? ts : lastBadTs;
    }
  }
  return state;
}

/**
 * decideFanout({ refs, entries, verify: {cmd, safe, unsafeReason, exitCode}, reason, ackedBy })
 *   -> { ok, refusals: string[], row, landed: {ref: state} }
 * `entries` is the full ledger (dispatch-ledger.js readEntries()).
 */
function decideFanout({ refs, entries, verify, reason, ackedBy }) {
  const refusals = [];
  const normalized = [];
  for (const raw of refs || []) {
    const r = normalizeRef(raw);
    if (!r) refusals.push(`unrecognised ref: ${raw}`);
    else if (!normalized.includes(r)) normalized.push(r);
  }
  if (normalized.length < MIN_REFS) {
    refusals.push(`a fan-out check needs at least ${MIN_REFS} distinct refs (got ${normalized.length}); with one child its LANDED acceptance re-run is the check`);
  }
  const landed = {};
  for (const r of normalized) {
    const st = landingState(rowsForRef(entries || [], r));
    landed[r] = st;
    if (!st.landed) refusals.push(`${r} has not landed yet (${st.detail}) — a combined check before every child finished proves nothing about it`);
  }
  const cmd = String((verify && verify.cmd) || '').trim();
  if (!cmd) refusals.push('--verify is required: a safe-form command that exercises the combined result');
  else if (!verify.safe) refusals.push(`verify command is not safe-form: ${verify.unsafeReason || cmd}`);
  else if (verify.exitCode !== 0) refusals.push(`verify command exited ${verify.exitCode}, not 0: ${cmd}`);
  const why = String(reason || '').trim();
  if (why.length < MIN_REASON_CHARS) refusals.push(`--reason must say what the command exercised across the children (>= ${MIN_REASON_CHARS} chars)`);
  if (refusals.length) return { ok: false, refusals, row: null, landed };
  return {
    ok: true,
    refusals: [],
    landed,
    row: {
      event: FANOUT_EVENT,
      taskId: 'fanout',
      refs: normalized,
      verifyCmd: cmd,
      exitCode: 0,
      reason: why,
      ackedBy: ackedBy || 'unknown',
    },
  };
}

function formatFanoutLine(row) {
  return `FANOUT-VERIFIED: ${row.refs.join(', ')} — \`${row.verifyCmd}\` exit 0 (${row.ts || 'ts pending'}); ${row.reason}`;
}

module.exports = { MIN_REFS, MIN_REASON_CHARS, FANOUT_EVENT, landingState, decideFanout, formatFanoutLine };
