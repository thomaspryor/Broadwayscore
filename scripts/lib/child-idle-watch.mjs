#!/usr/bin/env node
/**
 * Idle child sessions and the parents that never notice (BRO-6717).
 *
 * BRO-6518's child ended two turns "KEEP OPEN ... still running, I'll check
 * back" with nothing in its own session armed to wake it (a `setsid nohup`
 * ingest loop and an already-finished Monitor). It sat idle 17h, then 19h.
 * Its parent waited on a report-back that an idle child never sends.
 *
 * Child side: `stopDecision` is the CHILDIDLE gate's decision. verify-edits.sh
 * parses the transcript (one parser for every gate) and passes what is still
 * live IN THIS SESSION: run_in_background Bash, Monitor, background Agents.
 * Started sessions, PR subscriptions and detached processes are not wakes.
 *
 * Parent side: `childCheck` + the `arm` / `check` CLI. get_session is an MCP
 * tool and cannot be called from Bash, so the watcher is a timer: the parent
 * runs `arm` with run_in_background, its exit wakes the parent, the parent
 * calls get_session itself and feeds the JSON to `check`, which says what to
 * do and when to arm next. An idle child with no report-back is flagged
 * IDLE_MINUTES (30) after it went quiet.
 *
 *   node scripts/lib/child-idle-watch.mjs stop-decision   < {firstPrompt, env, closing, lastLine, live}
 *   node scripts/lib/child-idle-watch.mjs arm --child <session_id> [--until <iso> | --minutes N]
 *   node scripts/lib/child-idle-watch.mjs check --session-json <file|-> [--last-report <iso>]
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isChildSession } = require('./child-session-wait-guard.js');

export const IDLE_MINUTES = 30;
export const WORKING_RECHECK_MINUTES = 20; // must stay <= IDLE_MINUTES so an idle child is seen within IDLE_MINUTES
export const MIN_ARM_MINUTES = 2;
export const MAX_ARM_MINUTES = 110; // under the 2h run_in_background ceiling

// ─── Child side ─────────────────────────────────────────────────────────────

const VERDICT_RE = /^[\s*_•>-]{0,4}(KEEP OPEN|NOT SAFE TO EXIT|SAFE TO ARCHIVE|SAFE TO EXIT|ACTION NEEDED FROM YOU)\b/;
const STILL_RUNNING_RE = /^[\s*_•-]{0,4}Still running\s*:\s*(.*)$/i;
// "Still running: nothing", "Still running: nothing here.", "none", "n/a".
const NOTHING_RE = /^(?:nothing|none|no(?:thing)? (?:jobs?|work)|n\/a|-)\b/i;

/** The final message claims something is still running (it will be waited on). */
export function claimsRunningWork(closing = '', lastLine = '') {
  const verdict = (VERDICT_RE.exec(lastLine || '') || [])[1] || '';
  if (verdict === 'KEEP OPEN' || verdict === 'NOT SAFE TO EXIT') {
    return { claims: true, why: `closing verdict ${verdict}` };
  }
  if (/\bNothing is still running\b/i.test(closing)) return { claims: false, why: 'nothing is still running' };
  for (const line of String(closing || '').split('\n')) {
    const m = STILL_RUNNING_RE.exec(line);
    if (m && m[1].trim() && !NOTHING_RE.test(m[1].trim())) {
      return { claims: true, why: `"Still running: ${m[1].trim().slice(0, 80)}"` };
    }
  }
  return { claims: false, why: 'no running-work claim' };
}

/**
 * @param {{firstPrompt?: string, env?: object, closing?: string, lastLine?: string,
 *          live?: {waits?: string[], agents?: string[]}}} input
 * @returns {{block: boolean, reason: string}}
 */
export function stopDecision(input = {}) {
  const { firstPrompt = '', env = {}, closing = '', lastLine = '', live = {} } = input;
  const no = (reason) => ({ block: false, reason });
  if (!isChildSession({ firstPrompt, env })) return no('not a child session');
  if (/\bNO-VERIFY:/.test(closing)) return no('NO-VERIFY bypass');
  const claim = claimsRunningWork(closing, lastLine);
  if (!claim.claims) return no(claim.why);
  const wakes = [...(live.waits || []), ...(live.agents || [])];
  if (wakes.length) return no(`live wake in this session: ${wakes[0]}`);
  return { block: true, reason: `${claim.why}, but no run_in_background task, Monitor or background Agent is live in this session` };
}

// ─── Parent side ────────────────────────────────────────────────────────────

const ms = (min) => min * 60_000;
const ts = (s) => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? t : null; };
const bucketOf = (s) => String(s?.status_bucket || '').replace(/^SESSION_STATUS_BUCKET_/i, '').toUpperCase();

/** Unwrap a get_session result: the raw MCP text ({"ccr":{...}}, possibly inside an untrusted-data frame) or the object. */
export function parseSession(raw) {
  if (raw && typeof raw === 'object') return raw.ccr || raw;
  const t = String(raw || '');
  const i = t.indexOf('{');
  if (i < 0) throw new Error('no JSON object in get_session output');
  let depth = 0;
  for (let k = i; k < t.length; k++) {
    const ch = t[k];
    if (ch === '"') { for (k++; k < t.length && t[k] !== '"'; k++) if (t[k] === '\\') k++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const o = JSON.parse(t.slice(i, k + 1));
      return o.ccr || o;
    }
  }
  throw new Error('unterminated JSON in get_session output');
}

/**
 * What the parent should do about one child, from its get_session record.
 * @param {{session: object, now?: number, lastReportAt?: string|null, idleMinutes?: number}} input
 * @returns {{verdict: 'working'|'blocked'|'failed'|'gone'|'reported'|'idle-no-report'|'quiet',
 *            act: boolean, idleMinutes: number|null, nextWakeAt: string|null, say: string}}
 */
export function childCheck({ session, now = Date.now(), lastReportAt = null, idleMinutes = IDLE_MINUTES } = {}) {
  const s = session || {};
  const bucket = bucketOf(s);
  const status = String(s.session_status || '').toUpperCase();
  const updated = ts(s.updated_at);
  const report = ts(lastReportAt);
  const quietFor = updated == null ? null : Math.max(0, Math.round((now - updated) / 60_000));
  const at = (t) => new Date(Math.min(Math.max(t, now + ms(MIN_ARM_MINUTES)), now + ms(MAX_ARM_MINUTES))).toISOString();
  const out = (verdict, act, nextWakeAt, say) => ({ verdict, act, idleMinutes: quietFor, nextWakeAt, say });

  if (/ARCHIVED|DELETED/.test(status)) {
    return report != null
      ? out('reported', false, null, 'Child is archived and reported back; read its report.')
      : out('gone', true, null, 'Child is archived without a report-back: read its last events (list_events) and finish or restart the work.');
  }
  if (bucket === 'FAILED') return out('failed', true, null, 'Child\'s last turn errored: read list_events, then fix or restart it.');
  if (bucket === 'BLOCKED' || /REQUIRES_ACTION/.test(status)) {
    return out('blocked', true, null, 'Child is blocked on a prompt nobody will answer: interrupt_session, then send_message a workaround.');
  }
  // session_status is the truth about a turn in progress: an idle session
  // can still carry status_bucket WORKING (seen 2026-10-31 on an idle parent:
  // SESSION_STATUS_IDLE + SESSION_STATUS_BUCKET_WORKING). The bucket only
  // decides when session_status is absent.
  if (/RUNNING/.test(status) || (!status && bucket === 'WORKING')) {
    return out('working', false, at(now + ms(WORKING_RECHECK_MINUTES)), 'Child is working. Re-arm the watcher and end the turn KEEP OPEN.');
  }
  // Not running: its turn ended (IDLE, whatever the bucket says).
  if (report != null && (updated == null || report >= updated - ms(2))) {
    return out('reported', false, null, 'Child reported back after its last turn; act on the report.');
  }
  if (updated == null) {
    return out('idle-no-report', true, null, 'Child is idle, its last activity time is unknown, and it has not reported back: send_message it to finish or report.');
  }
  if (now - updated >= ms(idleMinutes)) {
    return out('idle-no-report', true, null,
      `Child has been idle ${quietFor} min with no report-back (BRO-6518 sat 17h like this). send_message it: resume the work with an in-session wait, or land what is done and report. If it does not answer within ${idleMinutes} min, read its events and take the work over.`);
  }
  return out('quiet', false, at(updated + ms(idleMinutes)),
    `Child went idle ${quietFor} min ago with no report-back yet. Re-arm the watcher until ${idleMinutes} min after it went quiet.`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function arg(argv, name, dflt = null) {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : dflt;
}

/** Milliseconds the `arm` timer sleeps. Exported for tests. */
export function armDelayMs(argv, now = Date.now()) {
  const until = ts(arg(argv, '--until'));
  const minutes = Number(arg(argv, '--minutes', String(WORKING_RECHECK_MINUTES)));
  const target = until != null ? until : now + ms(Number.isFinite(minutes) ? minutes : WORKING_RECHECK_MINUTES);
  return Math.min(Math.max(target - now, ms(MIN_ARM_MINUTES)), ms(MAX_ARM_MINUTES));
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === 'stop-decision') {
    let raw = '';
    for await (const c of process.stdin) raw += c;
    try {
      process.stdout.write(JSON.stringify(stopDecision(JSON.parse(raw || '{}'))));
    } catch (e) {
      process.stderr.write('child-idle-watch: failing open: ' + e.message + '\n');
      process.stdout.write(JSON.stringify({ block: false, reason: 'fail-open: ' + e.message }));
    }
    return 0;
  }
  if (cmd === 'arm') {
    const child = arg(argv, '--child', '');
    if (!/^(?:session|cse)_[0-9A-Za-z]{6,}$/.test(child)) {
      process.stderr.write('usage: child-idle-watch.mjs arm --child <session_id> [--until <iso> | --minutes N]\n');
      return 2;
    }
    const delay = armDelayMs(argv);
    process.stdout.write(`armed: wakes this session at ${new Date(Date.now() + delay).toISOString()} to check ${child}\n`);
    await new Promise((r) => setTimeout(r, delay));
    process.stdout.write(`CHILD-CHECK-DUE ${child}: call get_session on it, save the result to a file, then run `
      + `node scripts/lib/child-idle-watch.mjs check --session-json <file> [--last-report <iso of its last message to you>]\n`);
    return 0;
  }
  if (cmd === 'check') {
    const src = arg(argv, '--session-json');
    if (!src) { process.stderr.write('usage: child-idle-watch.mjs check --session-json <file|-> [--last-report <iso>]\n'); return 2; }
    const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
    const session = parseSession(raw);
    const r = childCheck({ session, lastReportAt: arg(argv, '--last-report') });
    const rearm = r.nextWakeAt ? `node scripts/lib/child-idle-watch.mjs arm --child ${session.id} --until ${r.nextWakeAt}` : null;
    process.stdout.write(JSON.stringify({ child: session.id, ...r, rearm }, null, 2) + '\n');
    return r.act ? 3 : 0;
  }
  process.stderr.write('usage: child-idle-watch.mjs stop-decision | arm --child <id> [--until <iso>|--minutes N] | check --session-json <file> [--last-report <iso>]\n');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
