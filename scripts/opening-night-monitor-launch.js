#!/usr/bin/env node
/**
 * opening-night-monitor-launch — every-20-min launchd tick
 * (com.bwsc.opening-night-monitor) that opens ONE cmux Fable session per
 * opening night to babysit review coverage end-to-end: independent census →
 * gap diagnosis → fix → verify on prod → repeat until parity or window end.
 * Generalizes the disabled per-show com.bwsc.opening-night-monitor-phase1/2/3
 * pattern (hardcoded show/date per plist) into a dynamic launcher.
 *
 * Selection is deliberately BROADER than the orchestrator's (same predicate,
 * scripts/lib/opening-night-selection.js, with includeUntrusted+ignoreStatus)
 * — the monitor exists to catch exactly the shows the orchestrator's gates
 * skip. All launch/no-launch logic is pure and unit-tested in
 * scripts/lib/opening-night-windows.js (heartbeat-first liveness so a session
 * sleeping between census passes is never relaunched as a duplicate).
 *
 *   opening-night-monitor-launch                 normal tick (launchd)
 *   opening-night-monitor-launch --dry-run       print decision, launch nothing
 *   opening-night-monitor-launch --show <id>     force one show (ignores window)
 *   opening-night-monitor-launch --rehearsal     census+diagnosis only, no fixes
 *   opening-night-monitor-launch --active-shows  print in-window show ids (session loop re-derives its list)
 *   opening-night-monitor-launch --heartbeat     stamp the session heartbeat (session loop calls this every pass)
 *
 * Kill switch: create data/opening-night-monitor/DISABLED (or set
 * ON_MONITOR_DISABLED=1) — next tick exits without launching.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = '/Users/tompryor/Broadwayscore';

// launchd hands this process only PATH, HOME and CLAUDE_CODE_OAUTH_TOKEN, so
// RESEND_API_KEY / OWNER_EMAIL were absent on every tick and every escalation
// email was dropped ("RESEND_API_KEY or OWNER_EMAIL not set, skipping email
// alert") — three exhausted launch attempts on a live opening night notified
// nobody (2026-07-30 audit; task #457). Load .env before anything reads
// process.env; real CI/shell values always win.
require('./lib/load-env.js').loadEnv(REPO);
const { hasHelpFlag } = require('./lib/cli-help.js');
const { selectOpeningNightShows } = require('./lib/opening-night-selection.js');
const {
  activeWindows, nightKey, launchDecision, computeWindow,
  claimLockGeneration, isLockGenerationOwner,
} = require('./lib/opening-night-windows.js');
const { launchCmuxSession, shouldAdoptLateStart } = require('./lib/cmux-launch.js');
const cmuxws = require('./lib/cmux-workspaces.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');

const MON_DIR = path.join(REPO, 'data', 'opening-night-monitor');
const LOCK_DIR = path.join(MON_DIR, 'monitor.lock');
const LOCK_META = path.join(LOCK_DIR, 'meta.json');
const HEARTBEAT = path.join(MON_DIR, 'heartbeat.json');
const KILL_FILE = path.join(MON_DIR, 'DISABLED');
const SEED_TEMPLATE = path.join(REPO, 'scripts', 'opening-night-prompts', 'monitor-v2.md');
const SETTINGS_PATH = path.join(REPO, '.claude', 'opening-night-monitor-settings.json');
const MODEL = process.env.ON_MONITOR_MODEL || 'fable'; // owner decision 2026-07-24 — Fable, with launcher-side external brakes

const USAGE = `opening-night-monitor-launch — launch the opening-night monitor session (see header comment)
  --dry-run | --show <id> | --rehearsal | --active-shows | --heartbeat | --help`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function log(msg) { console.log(`[on-monitor ${new Date().toISOString()}] ${msg}`); }

function loadShows() {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'shows.json'), 'utf8')).shows;
}

function monitorCandidates(shows, now) {
  // Same predicate as the orchestrator, with the monitor's broader flags —
  // then narrowed to shows actually inside their curtain window right now.
  // Evidence keeps the monitor's selection a strict superset of the
  // orchestrator's — without it, the deliberately-broader monitor would be
  // NARROWER than the CLI on the evidence-anchored arm (QA finding).
  const { loadReviewEvidence } = require('./lib/review-evidence.js');
  const selected = selectOpeningNightShows(shows, {
    market: '', now, includeUntrusted: true, ignoreStatus: true,
    evidence: loadReviewEvidence(),
  });
  return activeWindows(selected, now);
}

function nightStatePath(key) { return path.join(MON_DIR, `night-state-${key}.json`); }

// GC night/session state files >14 days old — one+ accumulates per opening
// night in a git-tracked dir and nothing else cleans them (ship-check P2).
function gcStateFiles(now = Date.now()) {
  let files;
  try { files = fs.readdirSync(MON_DIR); } catch { return; }
  for (const f of files) {
    if (!/^(night-state-|session-state-)/.test(f)) continue;
    try {
      const p = path.join(MON_DIR, f);
      if (now - fs.statSync(p).mtimeMs > 14 * 24 * 3600e3) fs.rmSync(p);
    } catch { /* best-effort */ }
  }
}
function readNightState(key) {
  try { return JSON.parse(fs.readFileSync(nightStatePath(key), 'utf8')); } catch { return { attempts: 0 }; }
}
function writeNightState(key, state) {
  fs.mkdirSync(MON_DIR, { recursive: true });
  fs.writeFileSync(nightStatePath(key), JSON.stringify(state, null, 2));
}

function heartbeatAgeMin() {
  try { return (Date.now() - fs.statSync(HEARTBEAT).mtimeMs) / 60000; } catch { return null; }
}

// birthtime, not mtime: LOCK_DIR is not gitignored (data/ is core-data-only
// gitignore territory), so a `git add -A`/checkout/clean in another session
// touching a file inside it would silently reset mtime and misreport a
// launch that's actually been in flight for a while as brand new — the
// exact anti-pattern monitor-lock-staleness.js already documents (#476).
// birthtime is stamped once at mkdir and nothing else in this launch path
// rewrites it.
function lockAgeSec() {
  try { return (Date.now() - fs.statSync(LOCK_DIR).birthtimeMs) / 1000; } catch { return null; }
}

function lockMeta() {
  try { return JSON.parse(fs.readFileSync(LOCK_META, 'utf8')); } catch { return null; }
}

// launchCmuxSession reports failure when claude hasn't registered a live
// process within its verify window — but Fable cold start + the heavy
// session-start hooks routinely exceed that window under nightly-loop load
// (the 04:36 2026-07-24 false CRITICAL for trainspotting: workspace:272
// spawned, came alive after the window, got reported dead). The final-path
// workspace is NOT closed, so if claude comes alive during a late-start grace
// we ADOPT it instead of paging + re-launching a duplicate.
//
// The adoption itself now lives in cmux-launch.js (task #503): bsc-next.js hit
// the identical false-failure class — 10 untracked live shells + duplicate
// dispatches in one day — because the fix had only ever been applied here.
// This file keeps the constant and re-exports the predicate for its own tests.
const LATE_START_GRACE_SEC = 60;

// Alert routing is lazy-required so a broken router dependency can never
// stop a tick from at least logging (the launcher must fail toward "log +
// exit", never toward "crash before deciding").
async function alert(opts) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    return await routeAlert(opts);
  } catch (e) {
    log(`ALERT ROUTING FAILED (${e.message}) — ${opts.title}`);
    return { action: 'failed' };
  }
}

// Cheap auth ping BEFORE any side-effecting launch (autonomous-run.js
// preflightAuth pattern): distinguishes an OAuth-expiry night from N launch
// failures, and an auth failure must NOT consume a launch attempt (plan
// review: the attempt cap only counts tries that reached a side effect).
function preflightAuth() {
  const r = spawnSync('claude', ['-p', 'Reply with exactly: pong', '--model', 'sonnet', '--output-format', 'json'],
    { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) return { ok: false, detail: (r.stderr || r.stdout || `exit ${r.status}`).slice(0, 300) };
  return { ok: true };
}

function buildSeed(windows, { attempt, rehearsal, key }) {
  const template = fs.readFileSync(SEED_TEMPLATE, 'utf8');
  const showIds = windows.map(w => w.showId).join(', ');
  const windowEnd = new Date(Math.max(...windows.map(w => w.windowEnd.getTime()))).toISOString();
  return template
    .replaceAll('{{SHOW_IDS}}', showIds)
    .replaceAll('{{WINDOW_END}}', windowEnd)
    .replaceAll('{{ATTEMPT}}', String(attempt))
    .replaceAll('{{NIGHT_KEY}}', key)
    .replaceAll('{{STATE_FILE}}', path.join(MON_DIR, `session-state-${key}.json`))
    .replaceAll('{{MODE}}', rehearsal
      ? 'REHEARSAL — census, chain-health checks, and diagnosis ONLY. Do NOT apply any fix, clear any flag, push any commit, or dispatch any workflow. Report what you WOULD have done.'
      : 'LIVE — diagnose AND fix.');
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const opts = parseArgs(argv);
  const now = new Date();

  if (opts.heartbeat) {
    fs.mkdirSync(MON_DIR, { recursive: true });
    fs.writeFileSync(HEARTBEAT, JSON.stringify({ at: now.toISOString() }));
    return 0;
  }

  gcStateFiles();
  const shows = loadShows();

  if (opts['active-shows']) {
    const w = monitorCandidates(shows, now);
    if (w.length) console.log(w.map(x => x.showId).join(','));
    return 0;
  }

  let windows;
  if (opts.show) {
    const s = shows.find(x => x.id === opts.show);
    if (!s) { log(`--show ${opts.show}: not found in shows.json`); return 1; }
    const w = computeWindow(s) || {
      // Forced launches (rehearsal on a not-yet-open show) get a synthetic
      // window ending tomorrow so the seed has a real deadline.
      showId: s.id, market: s.category, openingDate: s.openingDate || now.toISOString().slice(0, 10),
      windowStart: now, windowEnd: new Date(now.getTime() + 24 * 3600e3),
    };
    windows = [{ ...w, forced: true }];
  } else {
    windows = monitorCandidates(shows, now);
  }

  const key = nightKey(windows) || (windows[0] && `on-monitor-forced-${windows[0].showId}`);
  const nightState = key ? readNightState(key) : { attempts: 0 };
  const meta = lockMeta();
  const state = {
    windows,
    killSwitch: fs.existsSync(KILL_FILE) || process.env.ON_MONITOR_DISABLED === '1',
    lockExists: fs.existsSync(LOCK_DIR),
    lockAgeSec: lockAgeSec(),
    metaExists: meta !== null,
    heartbeatAgeMin: heartbeatAgeMin(),
    claudeAlive: cmuxws.computeClaudeAlive(meta),
    attemptsTonight: nightState.attempts,
  };
  const decision = launchDecision(state);

  if (opts['dry-run']) {
    console.log(JSON.stringify({
      decision,
      windows: windows.map(w => ({ ...w, windowStart: w.windowStart.toISOString(), windowEnd: w.windowEnd.toISOString() })),
      state: { ...state, windows: undefined },
    }, null, 2));
    return 0;
  }

  log(`decision: ${decision.action} — ${decision.reason}`);
  if (decision.action === 'skip') return 0;

  if (decision.action === 'escalate') {
    if (!nightState.escalated) {
      await alert({
        conditionKey: `on-monitor-attempts-exhausted-${key}`,
        title: `Opening-night monitor: ${nightState.attempts} attempts exhausted for ${windows.map(w => w.showId).join(', ')}`,
        description: `The monitor session died ${nightState.attempts}x tonight and the launcher will not start a 4th. ` +
          `Ledger: data/audit/dispatch-ledger.jsonl. State: ${nightStatePath(key)}. ` +
          `Coverage falls back to the standing pipeline; check the show page(s) in the morning.`,
        severity: 'error', disposition: 'human',
      });
      writeNightState(key, { ...nightState, escalated: true });
    }
    return 1;
  }

  if (decision.action === 'reclaim-and-launch') {
    log(`reclaiming dead session lock (workspace ${meta && meta.workspaceRef})`);
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  }

  const auth = preflightAuth();
  if (!auth.ok) {
    await alert({
      conditionKey: `on-monitor-auth-failed-${now.toISOString().slice(0, 10)}`,
      title: 'Opening-night monitor: claude auth preflight failed — no session launched',
      description: `Ping failed: ${auth.detail}. A show is in its opening-night window (${windows.map(w => w.showId).join(', ')}). ` +
        'Re-auth claude on the Mac Studio; the next 20-min tick retries automatically.',
      severity: 'error', disposition: 'human', cooldownHours: 6,
    });
    return 1;
  }

  // Atomic lock: mkdir is the test-and-set. A concurrent tick (launchd
  // overlap after a slow tick) loses the race here and exits — the
  // one-workspace-per-night invariant must never rest on a read-then-write.
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: false });
  } catch {
    log('lock exists (concurrent tick won the race) — skipping');
    return 0;
  }
  // Stamp our ownership token IMMEDIATELY — before any slow work (preflight
  // auth, cmux launch) a later reclaimer could race past. Every later
  // destructive write to this lock (meta.json, or the dir itself) must
  // re-check this token is still current before touching it (#569): a
  // reclaim-and-launch on a later tick deletes+recreates LOCK_DIR based on a
  // stale in-memory decision, and if THIS process wasn't actually dead — just
  // slow — its eventual writes must not clobber the new owner.
  const myGenToken = claimLockGeneration(LOCK_DIR);

  // Count the attempt BEFORE the side-effecting launch so a launch that dies
  // mid-flight still consumed one.
  writeNightState(key, { ...nightState, attempts: nightState.attempts + 1, lastLaunchAt: now.toISOString() });

  const rehearsal = !!opts.rehearsal;
  const seed = buildSeed(windows, { attempt: nightState.attempts + 1, rehearsal, key });
  const title = `🎭🧠 ON monitor·${rehearsal ? 'REHEARSAL ' : ''}${windows.map(w => w.showId.replace(/-\d{4}$/, '')).join(' + ').slice(0, 60)}`;
  const result = launchCmuxSession({
    title, seed, seedKey: `${key}-a${nightState.attempts + 1}`,
    cwd: REPO, model: MODEL,
    // focus:false — a 23:00 auto-launch must never steal the owner's screen
    // (plan-review user-impact finding).
    focus: false, autoColor: true, settingsPath: SETTINGS_PATH,
    // Fable + session-start hooks take well over the default 30s to register
    // a live process (first live launch 2026-07-24: alive at ~45s, after the
    // launcher had already close-and-retried it).
    verifyTimeoutSec: 90,
    // Late-start adoption: a Fable session that registered a live process AFTER
    // the verify window is healthy, not failed — adopt it rather than page +
    // relaunch a duplicate next tick (2026-07-24 false CRITICAL).
    lateAdoptSec: LATE_START_GRACE_SEC,
  });

  const adoptedLate = !!result.adoptedLate;
  if (adoptedLate) log(`adopted late-start session ${result.ref} for ${windows.map(w => w.showId).join(', ')} (alive after verify window)`);

  if (!result.ok) {
    // Genuinely dead — close the lingering workspace so it can't become an
    // untracked orphan, drop the lock (only if we still own it — a later
    // tick may have already reclaimed it out from under this slow failure),
    // and page.
    if (result.workspaceRef) { try { cmuxws.closeWorkspace(result.workspaceRef); } catch { /* already gone */ } }
    if (isLockGenerationOwner(LOCK_DIR, myGenToken)) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    } else {
      log('lock generation changed while launching — another tick already reclaimed it; not touching its lock');
    }
    await alert({
      conditionKey: `on-monitor-launch-failed-${key}`,
      title: `Opening-night monitor launch FAILED for ${windows.map(w => w.showId).join(', ')}`,
      description: `launchCmuxSession: ${result.reason}. Attempt ${nightState.attempts + 1}/3; next tick retries. Command: ${result.command}`,
      severity: 'error', disposition: 'human', cooldownHours: 3,
    });
    return 1;
  }

  // #569: re-verify ownership right before writing meta.json — a slow
  // launch (preflight auth + up to ~150s of cmux launch time) can finish
  // AFTER a later tick reclaimed this lock as dead. Writing anyway would
  // silently overwrite the new owner's meta.json with our stale
  // workspaceRef, exactly the split-brain json-write-guard.js guards
  // against for commercial.json/audience-buzz.json saves.
  if (!isLockGenerationOwner(LOCK_DIR, myGenToken)) {
    log(`lock generation changed before meta.json write — another tick reclaimed ${LOCK_DIR} while this launch (workspace ${result.ref}) was in flight; closing the orphaned workspace instead of clobbering the new owner's meta.json`);
    try { cmuxws.closeWorkspace(result.ref); } catch { /* already gone */ }
    await alert({
      conditionKey: `on-monitor-generation-lost-${key}`,
      title: `Opening-night monitor: lock reclaimed mid-launch for ${windows.map(w => w.showId).join(', ')}`,
      description: `This tick's launch (workspace ${result.ref}) finished after another tick reclaimed the lock as dead. Closed the orphaned workspace rather than overwrite the newer generation's meta.json.`,
      severity: 'warning', disposition: 'digest',
    });
    return 1;
  }

  fs.writeFileSync(LOCK_META, JSON.stringify({
    nightKey: key, workspaceRef: result.ref, launchedAt: now.toISOString(),
    attempt: nightState.attempts + 1, shows: windows.map(w => w.showId), rehearsal, model: MODEL,
    ...(adoptedLate ? { adoptedAfterLateStart: true } : {}),
  }, null, 2));
  // Seed the heartbeat at launch so the next tick (before the session's first
  // loop pass finishes) reads a fresh heartbeat, not the stale-dead path.
  fs.writeFileSync(HEARTBEAT, JSON.stringify({ at: now.toISOString(), seededByLauncher: true }));
  // dispatch-ledger requires {event, taskId}; taskId carries the night key
  // (the ledger is task-shaped — first live launch crashed here on a
  // {type:...}-shaped entry, after the workspace was already up).
  dispatchLedger.appendEntry({
    event: 'launch', taskId: key,
    workspaceRef: result.ref, shows: windows.map(w => w.showId),
    attempt: nightState.attempts + 1, model: MODEL, rehearsal, kind: 'on-monitor',
  });
  await alert({
    conditionKey: `on-monitor-launched-${key}`,
    title: `Opening-night monitor launched: ${windows.map(w => w.showId).join(', ')}`,
    description: `Workspace ${result.ref}, attempt ${nightState.attempts + 1}, model ${MODEL}${rehearsal ? ', REHEARSAL mode' : ''}${adoptedLate ? ' (adopted after late start)' : ''}.`,
    severity: 'info', disposition: 'digest',
  });
  log(`launched ${result.ref} for ${windows.map(w => w.showId).join(', ')} (attempt ${nightState.attempts + 1})`);
  return 0;
}

module.exports = { parseArgs, monitorCandidates, buildSeed, main, shouldAdoptLateStart };

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(`[on-monitor] tick crashed: ${e && e.stack || e}`);
    process.exit(1);
  });
}
