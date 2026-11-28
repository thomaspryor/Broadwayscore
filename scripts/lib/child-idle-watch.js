'use strict';
/**
 * Parent-side watcher for a child session (BRO-6717).
 *
 * BRO-6518 (child of BRO-6498) ended its turn KEEP OPEN twice ("I'll check
 * back on them", 23:52Z Oct 29 and 18:17Z Oct 30) with nothing armed; its
 * container-local loop died and it sat idle 17h, then 19h. The parent waited
 * on a report-back, but an idle child is neither a report-back nor a failure
 * event, so nothing woke the parent either.
 *
 * get_session is an MCP tool: only the parent model can call it, never a Bash
 * loop. So the watcher is a timer the parent runs with run_in_background
 * (its exit wakes the parent), and the idle decision is a pure function the
 * parent feeds the get_session result into when it wakes:
 *
 *   1. Bash run_in_background, timeout 7200000 (one per child):
 *        node scripts/lib/child-idle-watch.js watch --session <id> [--minutes 25]
 *   2. On wake: get_session <id>, save the JSON, then
 *        node scripts/lib/child-idle-watch.js check --from-json <file> [--session <id>] [--reported-at <iso>]
 *      It prints {action, reason, rearmMinutes}: rearm (start step 1 again with
 *      rearmMinutes), unblock (interrupt_session, send a workaround), nudge (send_message the child: poll in-turn or hand its
 *      queue to a workflow / the tic-daily pending queue, then report), restart
 *      (it failed) or done (collect the report).
 *
 * The Stop hook (verify-edits.sh CHILDWATCH, decision in
 * child-session-wait-guard.js) refuses a parent KEEP OPEN on a live child
 * unless a `child-idle-watch.js watch` background task is live.
 */

const DEFAULT_IDLE_MINUTES = 30;
// A watch must finish before the harness kills it. Claude Code's default
// background Bash limit is 30 min, and CLOUD.md's step once left the timeout
// out, so a 30-min watch (the old default, and every WORKING rearm) was killed
// instead of waking the parent (BRO-7109, two watches lost 2026-11-08).
// Every timer this script proposes stays under that default.
const SAFE_WATCH_MINUTES = 25;
const WORKING = new Set(['WORKING', 'RUNNING', 'ACTIVE', 'IN_PROGRESS', 'STARTING', 'QUEUED']);
const DONE = new Set(['COMPLETED', 'REVIEW_READY', 'ARCHIVED']);
const FAILED = new Set(['FAILED', 'ERROR', 'ERRORED', 'CRASHED']);
const BLOCKED = new Set(['BLOCKED', 'NEEDS_INPUT', 'AWAITING_INPUT', 'REQUIRES_ACTION']);
// A report-back moves the child's updated_at a little (its turn ends after it).
const REPORT_SLACK_MS = 10 * 60000;
// A child that moved more than this after its init error did start (BRO-7377). A dead child's
// updated_at sits within seconds of the error (fixture: 0.8 s).
const INIT_ERROR_SLACK_MS = 3 * 60000;

/**
 * Shallowest value of `key` in a parsed get_session payload (it nests under
 * ccr/session). Breadth-first, so the session's own updated_at wins over one
 * on a nested event.
 */
function findField(obj, key) {
  let level = [obj];
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next = [];
    for (const o of level) {
      if (!o || typeof o !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(o, key) && o[key] != null) return o[key];
      next.push(...Object.values(o));
    }
    level = next;
  }
  return undefined;
}

function normBucket(raw) {
  return String(raw || '').toUpperCase().replace(/^SESSION_STATUS_(?:BUCKET_)?/, '');
}

function toMs(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object} p
 * @param {object} p.session    parsed get_session result
 * @param {number|string} p.now
 * @param {number} [p.idleMinutes=30]
 * @param {string} [p.reportedAt]  when the child last reported back (send_message to @parent), if seen
 * @param {boolean} [p.checkInit=true]  false when the caller knows the session started (it claimed a card): a last_init_error on it is stale
 * @returns {{action: 'rearm'|'nudge'|'unblock'|'restart'|'done', reason: string, idleMinutes: number|null, rearmMinutes: number, neverStarted?: true}}
 */
function decide({ session, now = Date.now(), idleMinutes = DEFAULT_IDLE_MINUTES, reportedAt, checkInit = true } = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const bucket = normBucket(findField(session, 'status_bucket'));
  const status = normBucket(findField(session, 'session_status'));
  const updated = toMs(findField(session, 'updated_at'));
  const ageMin = updated == null ? null : Math.max(0, (nowMs - updated) / 60000);
  const reported = toMs(reportedAt);
  const out = (action, reason, rearmMinutes = idleMinutes) =>
    ({ action, reason, idleMinutes: ageMin == null ? null : Math.round(ageMin), rearmMinutes: Math.min(SAFE_WATCH_MINUTES, Math.max(1, Math.ceil(rearmMinutes))) });

  if (DONE.has(bucket) || DONE.has(status) || findField(session, 'archived') === true) {
    return out('done', `child is ${bucket || status || 'archived'}: collect its report`);
  }
  // BRO-7377: a child whose container never came up (setup script exit 128 on
  // 2026-11-11) still reads status_bucket=WORKING, so every check said rearm.
  // external_metadata.last_init_error is the only signal. Two guards against a
  // stale error on a session that later started fine: a report-back (it has
  // plainly started) and activity well after the error (the failed child's
  // updated_at equals the error's `at`; a working one moves on).
  const meta = (session && (session.ccr || session).external_metadata) || {};
  const initErr = meta.last_init_error || findField(session, 'last_init_error');
  if (checkInit && reported == null && initErr && typeof initErr === 'object' && !/^\s*true\s*$/i.test(String(initErr.recoverable))
      && (initErr.message || initErr.error_kind || initErr.error_type)) {
    // No usable `at`: measure from the session's creation, a dead child's updated_at sits minutes after it.
    const errAt = toMs(initErr.at) ?? toMs(findField(session, 'created_at'));
    // An unparseable updated_at proves nothing either way: leave it to the ordinary checks, never restart on it.
    const progressed = errAt != null && updated != null && updated - errAt > INIT_ERROR_SLACK_MS;
    if (updated != null && !progressed) {
      const kind = initErr.error_kind || initErr.error_type || 'init';
      return { ...out('restart', `child never started (${kind}: ${initErr.message || 'no message'}${initErr.at ? ` at ${initErr.at}` : ''}): `
        + 'list_events it with kinds ["env_manager_log"] for the output, fix the cause (get_environment, then update_environment), '
        + 'archive_session the dead one, then create_session again'), neverStarted: true };
    }
  }
  if (FAILED.has(bucket) || FAILED.has(status)) return out('restart', `child ${bucket || status}: fix or restart it`);
  if (BLOCKED.has(bucket) || BLOCKED.has(status)) return out('unblock', `child ${bucket || status}: interrupt_session and send a workaround`);
  // A report-back at (or just before) the child's last activity means it has
  // said its piece; activity well after the report means it went back to work.
  if (reported != null && (updated == null || updated - reported <= REPORT_SLACK_MS)) {
    return out('done', 'child reported back after its last activity');
  }
  if (WORKING.has(bucket) || (!bucket && WORKING.has(status))) {
    return out('rearm', `child is ${bucket || status}`);
  }
  // Not working (idle, waiting, blocked, unknown): idle long enough is the BRO-6518 case.
  if (ageMin == null) return out('nudge', `child is ${bucket || 'in an unknown state'} with no updated_at`);
  if (ageMin >= idleMinutes) {
    return out('nudge', `child ${bucket || 'not working'} for ${Math.round(ageMin)} min with no report-back`);
  }
  // Idle but not for long: wake again exactly when it crosses the threshold.
  return out('rearm', `child ${bucket || 'not working'} for ${Math.round(ageMin)} min, under ${idleMinutes}`, idleMinutes - ageMin);
}

// ─── One watcher per child (BRO-8239) ───────────────────────────────────────
// Parents stacked a fresh 25-min watch per child every cycle (a rearm while
// an earlier watch for the same child was still live), so one child woke the
// parent several times per cycle. get_session is MCP-only, so a Bash watcher
// cannot learn the child was archived and re-arm itself; the safe part is to
// dedupe: `watch` registers <dir>/<child>.json {pid, until} with an exclusive
// create, and a second `watch` for a child with a live entry exits at once.
// The registry is container-local (a resumed session in a new container is
// not deduped, which is harmless). A SIGKILLed watcher leaves its file; the
// pid and `until` checks make that entry stale.
function watchDir(env = process.env) {
  return env.CHILD_IDLE_WATCH_DIR || require('path').join(require('os').tmpdir(), 'child-idle-watch');
}
function watchFile(id, dir) {
  return require('path').join(dir, String(id).replace(/[^0-9A-Za-z_.-]/g, '_') + '.json');
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** The live registered watcher for this child, or null. */
function liveWatcher(id, { dir = watchDir(), now = Date.now() } = {}) {
  try {
    const w = JSON.parse(require('fs').readFileSync(watchFile(id, dir), 'utf8'));
    return Number.isInteger(w.pid) && w.pid > 0 && pidAlive(w.pid) && toMs(w.until) > toMs(now) ? w : null;
  } catch { return null; }
}
/** Register this process as the child's watcher. {ok:true} or {ok:false, live}. */
function claimWatch(id, { dir = watchDir(), pid = process.pid, until, now = Date.now() } = {}) {
  const fs = require('fs');
  const f = watchFile(id, dir);
  const body = JSON.stringify({ session: id, pid, until: new Date(toMs(until)).toISOString() });
  const tmp = f + '.' + pid + '.' + Date.now() + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, body);
  } catch { return { ok: true, unregistered: true }; } // registry unusable: fail open, the plain timer still runs
  try {
    for (let i = 0; i < 3; i++) {
      // link() is atomic and exclusive, and the file is complete the moment it exists (no empty-file window).
      try { fs.linkSync(tmp, f); return { ok: true }; } catch (e) { if (e.code !== 'EEXIST') return { ok: true, unregistered: true }; }
      const live = liveWatcher(id, { dir, now });
      if (live) return { ok: false, live };
      if (!liveWatcher(id, { dir, now })) { try { fs.unlinkSync(f); } catch { /* raced: retry the exclusive link */ } }
    }
    const live = liveWatcher(id, { dir, now });
    return live ? { ok: false, live } : { ok: true, unregistered: true };
  } finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
}
function releaseWatch(id, { dir = watchDir(), pid = process.pid } = {}) {
  const fs = require('fs');
  try { if (JSON.parse(fs.readFileSync(watchFile(id, dir), 'utf8')).pid === pid) fs.unlinkSync(watchFile(id, dir)); } catch { /* gone already */ }
}

function arg(argv, name, dflt) {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : dflt;
}

function usage() {
  return [
    'child-idle-watch.js (BRO-6717): wake a parent session when its child goes idle.',
    '  watch --session <id> [--minutes 25]   timer; run it with run_in_background (timeout 7200000); its exit wakes you',
    '  check --from-json <file> [--session <id>] [--reported-at <iso>] [--idle-minutes 30] [--now <iso>]',
    '                                        decide from a saved get_session result: rearm | nudge | restart | done',
  ].join('\n');
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === 'watch') {
    const session = arg(argv, '--session', '');
    const minutes = Number(arg(argv, '--minutes', SAFE_WATCH_MINUTES));
    if (minutes >= 30) process.stderr.write(`watch: ${minutes} min outlives the 30-min background default; launch with Bash timeout 7200000\n`);
    if (!session || !(minutes > 0) || minutes > 115) {
      process.stderr.write('watch needs --session <id> and --minutes in 1..115 (background Bash caps at 2h)\n');
      return 2;
    }
    const claim = claimWatch(session, { until: Date.now() + minutes * 60000 });
    if (!claim.ok && claim.live) {
      process.stdout.write(`ALREADY-WATCHED ${session} by pid ${claim.live.pid} until ${claim.live.until}: that watch wakes you then; do not start another (BRO-8239)\n`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, minutes * 60000));
    releaseWatch(session); // before the wake text, so an immediate rearm is not refused by this exiting watcher
    process.stdout.write(`CHILD-IDLE-WATCH WAKE ${session} after ${minutes} min: call get_session ${session}, save the JSON, then run\n`
      + `  node scripts/lib/child-idle-watch.js check --from-json <file> --session ${session}\n`
      + `  (a rearm runs watch again with Bash run_in_background and timeout 7200000)\n`);
    return 0;
  }
  if (cmd === 'check') {
    const file = arg(argv, '--from-json', '');
    if (!file) { process.stderr.write(usage() + '\n'); return 2; }
    const session = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    const res = decide({
      session,
      now: arg(argv, '--now', Date.now()),
      idleMinutes: Number(arg(argv, '--idle-minutes', DEFAULT_IDLE_MINUTES)),
      reportedAt: arg(argv, '--reported-at', undefined),
    });
    const live = arg(argv, '--session', '') && res.action === 'rearm' ? liveWatcher(arg(argv, '--session', '')) : null;
    if (live) Object.assign(res, { alreadyWatched: { pid: live.pid, until: live.until }, reason: `${res.reason}; a watch for it is already live until ${live.until}, do not start another (BRO-8239)` });
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(usage() + '\n');
  return cmd ? 2 : 0;
}

module.exports = { decide, findField, normBucket, liveWatcher, claimWatch, releaseWatch, DEFAULT_IDLE_MINUTES, SAFE_WATCH_MINUTES };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    process.stderr.write('child-idle-watch: ' + e.message + '\n');
    process.exitCode = 1;
  });
}
