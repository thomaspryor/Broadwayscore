/**
 * cmux-triage-digest.js — BRO-3050 piece 1: surface cmux-triage.js's verdict
 * in the morning digest.
 *
 * cmux-triage.js answers "is the work behind a dead cmux tab finished?" but
 * nothing ever ran it, so its verdict reached nobody. The morning digest runs
 * daily on the Mac that owns the cmux socket, so it shells the real CLI
 * (`node scripts/lib/cmux-triage.js --json`) and renders three numbers:
 * needsResuming, needsOwnerCall, and the foreignAgentAlive list (tabs every
 * other sweep reads as dead that have a live Codex/other agent in them).
 *
 * The one hard rule: a DEGRADED run never renders a verdict. cmux-triage
 * exits 2 (and sets `degraded: true`) when the ledger was unreadable, a tab
 * could not be probed, or Linear was skipped. Those counts are not
 * authoritative, and a "0 need resuming" from a degraded run would read as an
 * all-clear. Likewise cmux being absent (cloud, CI, cmux.app not running) is
 * said explicitly, never rendered as "0 dead tabs".
 *
 * Split: interpretTriageRun + renderCmuxTriageLine are pure (tested by
 * cmux-triage-digest.test.mjs via require, CLAUDE.md rule 15);
 * collectCmuxTriage is the thin I/O wrapper that spawns the CLI.
 */
'use strict';

const path = require('path');

const TRIAGE_SCRIPT = path.join(__dirname, 'cmux-triage.js');
// cmux-triage does one Linear getIssue per distinct dead-tab key plus a cmux
// `top` per dead tab. 90s is generous for that and still cannot hold up the
// 7:30am send for long.
const TRIAGE_TIMEOUT_MS = 90_000;
const FOREIGN_LIST_MAX = 5;

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

function clip(s, n = 160) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Parse the CLI's stdout. Strict JSON first; if anything preceded the object
 * (an older cmux-triage printed a foreign-agent banner to stdout even in
 * --json mode), fall back to the first line that opens the object.
 * @param {string} stdout
 * @returns {object|null}
 */
function parseTriageJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* try the fallback */ }
  const idx = s.search(/^\{/m);
  if (idx <= 0) return null;
  try { return JSON.parse(s.slice(idx)); } catch { return null; }
}

/**
 * Turn one CLI run into a digest summary. Pure.
 * @param {{status:(number|null), stdout?:string, stderr?:string, error?:(Error|null), signal?:(string|null)}} run
 *        the spawnSync-shaped result
 * @returns {{state:'ok'|'degraded'|'unavailable'|'failed', reason?:string,
 *            needsResuming?:number, needsOwnerCall?:number, safeToClose?:number,
 *            deadCount?:number, foreignAgentAlive?:Array<{ref:string,title:string,agent:string}>}}
 */
function interpretTriageRun(run) {
  const r = run || {};
  if (r.error) {
    const msg = r.error.code === 'ETIMEDOUT' ? 'timed out' : (r.error.message || String(r.error));
    return { state: 'failed', reason: clip(msg) };
  }
  if (r.signal) return { state: 'failed', reason: `killed by ${r.signal}` };
  const errLine = firstLine(r.stderr);

  // Exit 1 with "cmux CLI not found" is cmux-triage's own "no cmux here"
  // answer (cloud, CI, a Mac without cmux.app). Say so; it is not a failure
  // of the triage and it is certainly not "no dead tabs".
  if (r.status === 1 && /cmux CLI not found/i.test(String(r.stderr || ''))) {
    return { state: 'unavailable', reason: 'cmux is not available on this machine' };
  }

  const payload = parseTriageJson(r.stdout);

  if (r.status === 2 || (payload && payload.degraded === true)) {
    const reasons = payload && Array.isArray(payload.degradedReasons) && payload.degradedReasons.length
      ? payload.degradedReasons.join('; ')
      : (errLine.replace(/^\[cmux-triage\]\s*(WARN\s*)?/, '') || 'cmux-triage reported a degraded run');
    return { state: 'degraded', reason: clip(reasons) };
  }

  if (r.status !== 0) {
    return { state: 'failed', reason: clip(`exit ${r.status}${errLine ? `: ${errLine}` : ''}`) };
  }
  if (!payload || !Array.isArray(payload.needsResuming) || !Array.isArray(payload.needsOwnerCall)) {
    return { state: 'failed', reason: 'cmux-triage --json output was not the expected shape' };
  }

  const foreign = Array.isArray(payload.foreignAgentAlive) ? payload.foreignAgentAlive : [];
  return {
    state: 'ok',
    needsResuming: payload.needsResuming.length,
    needsOwnerCall: payload.needsOwnerCall.length,
    safeToClose: Array.isArray(payload.safeToClose) ? payload.safeToClose.length : 0,
    deadCount: Number.isFinite(payload.deadCount) ? payload.deadCount : null,
    foreignAgentAlive: foreign.map((w) => ({ ref: String(w.ref || ''), title: String(w.title || ''), agent: String(w.agent || 'agent') })),
  };
}

/**
 * One plain-text digest line (the caller HTML-escapes it). Pure.
 * level: 'ok' (nothing to do), 'watch' (counts worth a look), 'unknown'
 * (no verdict this morning: degraded / unavailable / failed).
 * @param {ReturnType<typeof interpretTriageRun>|null} summary
 * @returns {{text:string, level:'ok'|'watch'|'unknown'}}
 */
function renderCmuxTriageLine(summary) {
  const s = summary || { state: 'failed', reason: 'no result' };
  if (s.state === 'unavailable') {
    return { level: 'unknown', text: 'Dead cmux tab triage: not run, cmux is not available on this machine. No verdict this morning.' };
  }
  if (s.state === 'degraded') {
    return { level: 'unknown', text: `Dead cmux tab triage: DEGRADED run (${s.reason}). No verdict this morning; counts from a degraded run are not shown.` };
  }
  if (s.state !== 'ok') {
    return { level: 'unknown', text: `Dead cmux tab triage: could not run (${s.reason || 'unknown error'}). No verdict this morning.` };
  }
  const foreign = s.foreignAgentAlive || [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let text = `Dead cmux tab triage: ${plural(s.needsResuming, 'tab needs', 'tabs need')} resuming, ${plural(s.needsOwnerCall, 'needs', 'need')} an owner call`;
  if (s.safeToClose) text += `, ${s.safeToClose} safe to close`;
  text += '.';
  if (foreign.length) {
    const shown = foreign.slice(0, FOREIGN_LIST_MAX).map((w) => `${w.ref} ${JSON.stringify(clip(w.title, 60))} (live ${w.agent} session)`);
    const more = foreign.length > FOREIGN_LIST_MAX ? ` (+${foreign.length - FOREIGN_LIST_MAX} more)` : '';
    text += ` ${plural(foreign.length, 'tab looks', 'tabs look')} dead to the prune sweep but ${foreign.length === 1 ? 'has' : 'have'} a live agent, not corpses: ${shown.join('; ')}${more}.`;
  }
  if (s.needsResuming || s.needsOwnerCall) text += '';
  const level = (s.needsResuming || s.needsOwnerCall || foreign.length) ? 'watch' : 'ok';
  return { level, text };
}

/**
 * I/O: run the real CLI and interpret it. Never throws, never blocks longer
 * than TRIAGE_TIMEOUT_MS.
 * @param {{spawnSync?:Function, cwd?:string, timeoutMs?:number}} [opts]
 */
function collectCmuxTriage({ spawnSync = require('child_process').spawnSync, cwd, timeoutMs = TRIAGE_TIMEOUT_MS } = {}) {
  try {
    const r = spawnSync(process.execPath, [TRIAGE_SCRIPT, '--json'], {
      cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    });
    return interpretTriageRun(r);
  } catch (err) {
    return { state: 'failed', reason: clip(err.message || String(err)) };
  }
}

module.exports = {
  interpretTriageRun, renderCmuxTriageLine, collectCmuxTriage, parseTriageJson,
  TRIAGE_SCRIPT, TRIAGE_TIMEOUT_MS,
};
