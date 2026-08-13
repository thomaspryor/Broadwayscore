#!/usr/bin/env node
/**
 * opening-night-monitor-launch — every-20-min launchd tick
 * (com.bwsc.opening-night-monitor) that runs ONE bounded HEADLESS claude -p
 * pass per tick to babysit review coverage end-to-end: independent census →
 * gap diagnosis → fix → verify on prod. Each pass is capped at
 * HEADLESS_MAX_WALL_MIN and picks up where the last pass left off via the
 * session-state file — the recurring 20-min launchd tick IS the loop's
 * cadence now, not a long-lived interactive session.
 *
 * Card #650 (2026-07-30): the previous cmux-launched design never launched a
 * single session in 344 ticks — cmux refuses connections from
 * launchd-parented process ancestry ("Access denied — only processes started
 * inside cmux can connect" / broken-pipe on list-workspaces/new-workspace),
 * proven with a double-fork+setsid orphan reproducing the exact failure. This
 * file no longer touches cmux at all: scripts/lib/opening-night-monitor.js
 * (a thin wrapper around the repo's shared scripts/lib/claude-cli.js headless
 * primitive, already used by autonomous-run.js/bsc-runner.js under this same
 * launchd ancestry every night) runs the pass instead. Ancestry-sensitivity
 * simply doesn't apply to `claude -p` — it was verified live under the exact
 * same double-fork+setsid orphan ancestry that breaks cmux.
 *
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
 *   opening-night-monitor-launch --active-shows  print in-window show ids
 *   opening-night-monitor-launch --heartbeat     stamp the heartbeat file manually
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
  activeWindows, nightKey, launchDecision, computeWindow, carryForwardNightState,
  MAX_ATTEMPTS_PER_NIGHT,
  claimLockGeneration, isLockGenerationOwner,
} = require('./lib/opening-night-windows.js');
const { runMonitorPass } = require('./lib/opening-night-monitor.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');

const MON_DIR = path.join(REPO, 'data', 'opening-night-monitor');
const LOCK_DIR = path.join(MON_DIR, 'monitor.lock');
const LOCK_META = path.join(LOCK_DIR, 'meta.json');
const HEARTBEAT = path.join(MON_DIR, 'heartbeat.json');
const KILL_FILE = path.join(MON_DIR, 'DISABLED');
const SEED_TEMPLATE = path.join(REPO, 'scripts', 'opening-night-prompts', 'monitor-v2.md');
const SETTINGS_PATH = path.join(REPO, '.claude', 'opening-night-monitor-settings.json');
// runClaudeCli (scripts/lib/claude-cli.js) hard-refuses fable/mythos for
// unattended runs (task #459) — the cmux-era Fable default (owner decision
// 2026-07-24, chosen for an INTERACTIVE session) cannot carry over. Opus for
// the judgment this pass does (corroborating production identity before
// clearing a flag, diagnosing which of 4 gap classes a miss falls into) —
// override with ON_MONITOR_MODEL if the owner wants a cheaper tier.
const MODEL = process.env.ON_MONITOR_MODEL || 'opus';
// A pass is capped well under the 20-min (1200s) launchd StartInterval so a
// normal pass always finishes — and releases the lock — before the next tick
// fires; HEARTBEAT_STALE_MIN (90) is the backstop for a pass that hangs past
// this cap anyway (killed by claude-cli's own SIGKILL timeout, or the whole
// node process crashing).
const HEADLESS_MAX_WALL_MIN = 15;
// Adversarial ship-check finding (2026-07-30, Claude review): the cmux-era
// design capped total launches at MAX_ATTEMPTS_PER_NIGHT (3) — an "external
// brake" (opening-night-windows.js's own comment) because the session can't
// be trusted to self-police its own $ spend. The new consecutiveFailures
// bookkeeping resets that counter on every success, so a mostly-successful
// night has NO cap at all: ~31h window / 20-min ticks ⇒ up to ~90 opus
// passes. This is the actual external brake now — checked independently of
// launchDecision (which still owns the separate "session looks dead"
// question) so a long run of genuine successes still gets cut off too.
const NIGHTLY_USD_CAP = 100;

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
  const evidence = loadReviewEvidence();
  const selected = selectOpeningNightShows(shows, {
    market: '', now, includeUntrusted: true, ignoreStatus: true,
    evidence,
  });
  // The SAME evidence must reach activeWindows, not just the selection above.
  // A show can be correctly selected on the evidence arm and then dropped by
  // computeWindow for having no openingDate — which is precisely how
  // how-the-other-half-loves-west-end-2026 went unmonitored for 19h on
  // 2026-08-12 while its reviews were already published.
  return activeWindows(selected, now, { evidence });
}

function nightStatePath(key) { return path.join(MON_DIR, `night-state-${key}.json`); }

// ── Did this pass actually do anything? ──────────────────────────────────
// Two consumers, deliberately different strictness:
//   - the alert path asks "was this worth waking the owner over?" and must be
//     GENEROUS (a false page is the bug being fixed);
//   - the no-progress brake asks "is another $5 pass worth it?" and must be
//     HONEST about real output.
// Both are answered by the same probe, so they can never drift apart.
//
// Why not the session-state file alone: monitor-v2.md puts the state write in
// step 5 (Verify + record), AFTER census/diff/fix. A pass SIGTERM'd at the
// 15-min cap mid-fix will have committed a real review recovery and written no
// state — pass 3 on 2026-08-12 committed a London Box Office recovery exactly
// that way. Counting only the state file would score the pipeline's most
// productive passes as idle and stop the night while it was working.
function statFingerprint(p) {
  try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return null; }
}

// Commits touching core data since the pass started. Local git, no network.
function commitsSince(sinceIso) {
  try {
    const r = spawnSync('git', ['log', '--oneline', `--since=${sinceIso}`, '--', 'data/review-texts', 'data/shows.json', 'data/reviews.json'],
      { cwd: REPO, encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) return 0;
    return r.stdout.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

// Scored-review count for the window's shows — the RE-ARM signal. Without it a
// no-progress stop would be permanent for the night, so a T1 landing at 02:00
// would never be picked up, and the long tail is the monitor's whole purpose.
function reviewCountFor(showIds) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'reviews.json'), 'utf8'));
    const all = Array.isArray(raw) ? raw : (raw.reviews || []);
    const set = new Set(showIds);
    return all.filter(r => set.has(r.showId)).length;
  } catch { return null; }
}

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
  try { return { attempts: 0, consecutiveFailures: 0, noProgressPasses: 0, usdTonight: 0, ...JSON.parse(fs.readFileSync(nightStatePath(key), 'utf8')) }; }
  catch { return { attempts: 0, consecutiveFailures: 0, noProgressPasses: 0, usdTonight: 0 }; }
}

/** Every other night-state on disk, for the carry-forward merge. */
function readAllNightStates(exceptKey) {
  const out = [];
  let files;
  try { files = fs.readdirSync(MON_DIR); } catch { return out; }
  for (const f of files) {
    const m = /^night-state-(.+)\.json$/.exec(f);
    if (!m || m[1] === exceptKey) continue;
    try { out.push({ key: m[1], state: JSON.parse(fs.readFileSync(path.join(MON_DIR, f), 'utf8')) }); }
    catch { /* a corrupt sibling must never stop tonight's launch */ }
  }
  return out;
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

// Alert routing is lazy-required so a broken router dependency can never
// stop a tick from at least logging (the launcher must fail toward "log +
// exit", never toward "crash before deciding").
async function alert(opts) {
  try {
    const router = require('./lib/owner-alert-router.js');
    // This launcher is a launchd sender in the SHARED ~/Broadwayscore checkout,
    // so its cooldown state must never sit uncommitted in the git-tracked
    // data/audit/alert-ledger.json — a parallel session's checkout/reset wipes
    // it between ticks and every re-fire looks new (card #693: the same
    // on-monitor-launch-failed alert emailed twice 21 min apart through a
    // cooldownHours: 3 window). owner-alert-router.js routes non-CI callers to
    // ~/.broadwayscore-state/alert-ledger.json; log which ledger a tick used so
    // a future double-send is diagnosable from the launcher log alone.
    if (!alert.loggedLedger) {
      alert.loggedLedger = true;
      log(`alert ledger: ${router.ledgerPath()} (${router.isLocalLedger() ? 'machine-local, survives git ops' : 'git-tracked'})`);
    }
    return await router.routeAlert(opts);
  } catch (e) {
    log(`ALERT ROUTING FAILED (${e.message}) — ${opts.title}`);
    return { action: 'failed' };
  }
}

// Cheap auth ping BEFORE any side-effecting launch (autonomous-run.js
// preflightAuth pattern): distinguishes an OAuth-expiry night from N launch
// failures, and an auth failure must NOT consume a launch attempt (plan
// review: the attempt cap only counts tries that reached a side effect).
//
// #457 root cause (2026-07-31, tao-of-glass night): the login lives in the
// macOS Keychain (no ~/.claude/.credentials.json), which a launchd-parented
// claude cannot open — so a pass launched with ANTHROPIC_API_KEY cleared
// dies "Not logged in". The old preflight LIED about this: it inherited the
// launcher's env, where load-env.js had already pulled the .env API key in,
// so the ping billed through the key while the real pass then cleared it.
// The preflight must probe the SAME env shape the pass will run with, and
// when only the API key path works, the pass must be told to keep the key
// (bounded spend: MAX_ATTEMPTS_PER_NIGHT passes, HEADLESS_MAX_WALL_MIN cap).
function authPing(extraEnv) {
  const r = spawnSync('claude', ['-p', 'Reply with exactly: pong', '--model', 'sonnet', '--output-format', 'json'],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) return { ok: false, detail: (r.stderr || r.stdout || `exit ${r.status}`).slice(0, 300) };
  // Positive validation (codex review 2026-07-31): require the envelope to
  // actually contain the pong. The broken-auth CLI exits 0 with
  // subtype:"success" and result:"Not logged in · Please run /login", and
  // future CLI versions may reword that — so never grep for the error
  // string, prove the success instead.
  try {
    const body = JSON.parse(r.stdout);
    if (body.is_error === false && /pong/i.test(String(body.result || ''))) return { ok: true };
    return { ok: false, detail: `ping returned no pong: ${String(body.result || r.stdout).slice(0, 200)}` };
  } catch {
    return { ok: false, detail: `unparseable ping output: ${String(r.stdout || r.stderr).slice(0, 200)}` };
  }
}

// Pure decision, extracted for tests (CLAUDE.md rule 15): which auth mode
// should the pass use given the two probe outcomes and key availability?
function resolvePassAuth({ storedLoginOk, apiKeyPresent, apiKeyPingOk }) {
  if (storedLoginOk) return { mode: 'oauth' };
  if (apiKeyPresent && apiKeyPingOk) return { mode: 'api-key' };
  return { mode: 'fail' };
}

function preflightAuth() {
  // Probe 1: the pass's real env — API key cleared, stored login only.
  const stored = authPing({ ANTHROPIC_API_KEY: '' });
  if (stored.ok) return { ok: true, mode: 'oauth' };
  // Operator kill switch for the pay-per-token path specifically (the
  // launcher-wide switches ON_MONITOR_DISABLED / KILL_FILE stop everything;
  // this one says "OAuth or nothing").
  const fallbackAllowed = process.env.ON_MONITOR_NO_API_FALLBACK !== '1';
  const apiKeyPresent = fallbackAllowed && Boolean(process.env.ANTHROPIC_API_KEY);
  // Probe 2: only if a key exists — can the key path carry the pass?
  const keyed = apiKeyPresent ? authPing({}) : { ok: false, detail: fallbackAllowed ? 'no ANTHROPIC_API_KEY in env' : 'API fallback disabled (ON_MONITOR_NO_API_FALLBACK=1)' };
  const decision = resolvePassAuth({ storedLoginOk: false, apiKeyPresent, apiKeyPingOk: keyed.ok });
  if (decision.mode === 'api-key') {
    log(`preflight: stored login unreachable (${stored.detail.slice(0, 120)}) — falling back to ANTHROPIC_API_KEY (pay-per-token; spend hard-capped by NIGHTLY_USD_CAP $${NIGHTLY_USD_CAP}/night, disable with ON_MONITOR_NO_API_FALLBACK=1). Run \`claude setup-token\` + add CLAUDE_CODE_OAUTH_TOKEN to restore subscription billing.`);
    return { ok: true, mode: 'api-key', storedDetail: stored.detail };
  }
  return { ok: false, detail: `stored-login: ${stored.detail} | api-key: ${keyed.detail}` };
}

function buildSeed(windows, { attempt, rehearsal, key, now = new Date() }) {
  const template = fs.readFileSync(SEED_TEMPLATE, 'utf8');
  const showIds = windows.map(w => w.showId).join(', ');
  const windowEnd = new Date(Math.max(...windows.map(w => w.windowEnd.getTime()))).toISOString();
  // The pass's own hard deadline, as an absolute instant. Telling it "you get
  // one bounded pass" in prose did not stop pass 4 on 2026-08-12 from dying
  // inside a background task called "Poll for scoring run completion" — a wait
  // it could not have finished. An instant is checkable; an adjective is not.
  const deadline = new Date(now.getTime() + HEADLESS_MAX_WALL_MIN * 60 * 1000).toISOString();
  return template
    .replaceAll('{{SHOW_IDS}}', showIds)
    .replaceAll('{{WINDOW_END}}', windowEnd)
    .replaceAll('{{DEADLINE_UTC}}', deadline)
    .replaceAll('{{WALL_MIN}}', String(HEADLESS_MAX_WALL_MIN))
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
  const windowShows = windows.map(w => w.showId);
  let nightState = key ? readNightState(key) : { attempts: 0, consecutiveFailures: 0 };
  if (key) {
    // The night key is the window's ANCHOR date, and an evidence anchor can be
    // superseded mid-window by the real openingDate landing — the key flips and
    // a virgin state would reset BOTH brakes (usdTonight and the attempt count),
    // letting one night spend twice its cap and re-fire a settled escalation.
    // Merge forward from any prior state covering these same shows.
    const carried = carryForwardNightState(readAllNightStates(key), windowShows, nightState);
    if (carried.carriedFrom) {
      log(`carried night state forward from ${carried.carriedFrom} (anchor date changed mid-window): $${carried.usdTonight.toFixed(2)} spent, ${carried.attempts} attempts, ${carried.noProgressPasses} no-progress`);
    }
    nightState = carried;
  }
  // A new review landing RE-ARMS the no-progress brake: the long tail (a T1 at
  // 02:00) is the whole reason the monitor runs for 31h, so a stop must never
  // be permanent while real work is still arriving.
  const reviewCount = reviewCountFor(windowShows);
  if (reviewCount !== null && nightState.lastReviewCount !== undefined && reviewCount !== nightState.lastReviewCount) {
    log(`review count changed (${nightState.lastReviewCount} → ${reviewCount}) — re-arming the no-progress brake`);
    nightState = { ...nightState, noProgressPasses: 0 };
  }
  const meta = lockMeta();
  const state = {
    windows,
    killSwitch: fs.existsSync(KILL_FILE) || process.env.ON_MONITOR_DISABLED === '1',
    lockExists: fs.existsSync(LOCK_DIR),
    lockAgeSec: lockAgeSec(),
    metaExists: meta !== null,
    heartbeatAgeMin: heartbeatAgeMin(),
    // No cmux workspace exists to probe anymore — the heartbeat (seeded the
    // instant a pass starts, below) is the ONLY liveness signal now, which is
    // correct: a headless pass either finishes inside HEADLESS_MAX_WALL_MIN
    // (well under HEARTBEAT_STALE_MIN) or claude-cli's own SIGKILL timeout
    // ends it, so "heartbeat fresh" and "pass genuinely still running" never
    // diverge the way a sleeping-between-passes interactive session could.
    claudeAlive: false,
    attemptsTonight: nightState.consecutiveFailures,
    noProgressPasses: nightState.noProgressPasses || 0,
  };
  let decision = launchDecision(state);
  // External spend brake (see NIGHTLY_USD_CAP comment above) — evaluated
  // AFTER launchDecision, which only knows about liveness/failures, not $.
  // Applies to both 'launch' and 'reclaim-and-launch': either one is about
  // to start a real pass.
  if ((decision.action === 'launch' || decision.action === 'reclaim-and-launch') && (nightState.usdTonight || 0) >= NIGHTLY_USD_CAP) {
    decision = { action: 'escalate', reason: `nightly spend cap reached ($${(nightState.usdTonight || 0).toFixed(2)} >= $${NIGHTLY_USD_CAP})` };
  }

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
        title: `Opening-night monitor: escalating for ${windows.map(w => w.showId).join(', ')} — ${decision.reason}`,
        description: `${decision.reason} (${nightState.attempts} total passes tonight, $${(nightState.usdTonight || 0).toFixed(2)} spent) and the launcher will not start another until a night boundary resets the counters. ` +
          `Ledger: data/audit/dispatch-ledger.jsonl. State: ${nightStatePath(key)}. ` +
          `Coverage falls back to the standing pipeline; check the show page(s) in the morning.`,
        severity: 'error', disposition: 'human',
      });
      writeNightState(key, { ...nightState, escalated: true });
    }
    return 1;
  }

  if (decision.action === 'reclaim-and-launch') {
    // Adversarial ship-check finding: a lock that needs reclaiming means the
    // PREVIOUS pass never reached its own success/failure write (the node
    // process itself died — SIGKILL, OOM, machine sleep — not a normal
    // runMonitorPass failure). Without this, consecutiveFailures never
    // learns about it: a string of process-level crashes could reclaim
    // forever, every ~90 min (HEARTBEAT_STALE_MIN), without ever reaching
    // MAX_ATTEMPTS_PER_NIGHT and escalating to the owner. Count it as a
    // failed pass so the escalate threshold still catches this failure mode.
    log(`reclaiming dead session lock (launched ${meta && meta.launchedAt}, no completion recorded) — counting the abandoned attempt as a failure`);
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    nightState = { ...nightState, consecutiveFailures: (nightState.consecutiveFailures || 0) + 1 };
    writeNightState(key, nightState);
  }

  const auth = preflightAuth();
  if (!auth.ok) {
    await alert({
      conditionKey: `on-monitor-auth-failed-${now.toISOString().slice(0, 10)}`,
      title: 'Opening-night monitor: claude auth preflight failed — no session launched',
      description: `Ping failed: ${auth.detail}. A show is in its opening-night window (${windows.map(w => w.showId).join(', ')}). ` +
        'Stored login is Keychain-only (unreachable from launchd) and no working ANTHROPIC_API_KEY fallback. ' +
        'Fix: `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN in .env; the next 20-min tick retries automatically.',
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
  // auth, the headless pass itself) a later reclaimer could race past. Every
  // later destructive write to this lock (meta.json, or the dir itself) must
  // re-check this token is still current before touching it (#569): a
  // reclaim-and-launch on a later tick deletes+recreates LOCK_DIR based on a
  // stale in-memory decision, and if THIS process wasn't actually dead — just
  // slow — its eventual writes must not clobber the new owner.
  const myGenToken = claimLockGeneration(LOCK_DIR);

  const attemptNum = nightState.attempts + 1;
  const rehearsal = !!opts.rehearsal;
  const seed = buildSeed(windows, { attempt: attemptNum, rehearsal, key, now });

  // meta.json + heartbeat are written BEFORE the blocking pass starts, not
  // after it resolves: a headless pass runs up to HEADLESS_MAX_WALL_MIN
  // (minutes), far longer than the cmux launch's old ~90-240s verify window
  // that the in-flight grace period (opening-night-windows.js's
  // LAUNCH_INFLIGHT_GRACE_SEC) was sized for. Without this, a concurrent
  // tick landing mid-pass would see lockExists+!metaExists past that grace
  // window and wrongly reclaim a pass that is still running.
  fs.writeFileSync(LOCK_META, JSON.stringify({
    nightKey: key, launchedAt: now.toISOString(),
    attempt: attemptNum, shows: windows.map(w => w.showId), rehearsal, model: MODEL,
  }, null, 2));
  fs.writeFileSync(HEARTBEAT, JSON.stringify({ at: now.toISOString(), seededByLauncher: true }));
  writeNightState(key, { ...nightState, attempts: attemptNum, lastLaunchAt: now.toISOString() });

  // Progress baseline, captured BEFORE the pass so the after-comparison is
  // honest even if the pass is SIGTERM'd mid-work.
  const stateFileBefore = statFingerprint(path.join(MON_DIR, `session-state-${key}.json`));
  const passStartedAt = now.toISOString();

  log(`starting headless pass ${attemptNum} (model ${MODEL}, cap ${HEADLESS_MAX_WALL_MIN}min) for ${windows.map(w => w.showId).join(', ')}`);
  const result = await runMonitorPass({
    prompt: seed, cwd: REPO, model: MODEL, settingsPath: SETTINGS_PATH,
    maxWallMin: HEADLESS_MAX_WALL_MIN,
    // load-env.js (line ~56, added for RESEND_API_KEY/OWNER_EMAIL) also pulls
    // ANTHROPIC_API_KEY into process.env if .env has one set, and claude-cli.js's
    // strippedEnv forwards it — which would bill this pass pay-per-token
    // instead of the Mac's subscription OAuth login (autonomous-run.js never
    // hits this: its launchd wrapper never sources .env). Empty string clears
    // it for THIS spawned process only (falsy, so claude's own has-a-key
    // check falls through to the stored login) without touching process.env
    // for anything else in this run that reads it (e.g. preflightAuth).
    // RESEND_API_KEY/OWNER_EMAIL are forwarded explicitly: strippedEnv's
    // fixed allowlist (PATH/HOME/TERM/LANG/LC_ALL/ANTHROPIC_API_KEY/
    // CLAUDE_CODE_OAUTH_TOKEN) does not include them, so without this the
    // in-pass session's own parity/escalation report (monitor-v2.md step 2-3,
    // routeAlert via owner-alert-router.js) would silently no-op inside the
    // spawned child every time — the exact "RESEND_API_KEY or OWNER_EMAIL not
    // set, skipping email alert" failure this session's #457 fix (commit
    // 288e31efd69) already fixed for the LAUNCHER's own alerts, but never
    // extended to the pass it launches.
    // #457: auth.mode comes from preflightAuth(), which probed this exact
    // env shape. 'oauth' keeps the key cleared (subscription billing);
    // 'api-key' forwards it because the stored login is unreachable from
    // this (launchd) context — spend stays bounded by the attempt cap above.
    env: {
      ANTHROPIC_API_KEY: auth.mode === 'api-key' ? (process.env.ANTHROPIC_API_KEY || '') : '',
      RESEND_API_KEY: process.env.RESEND_API_KEY || '',
      OWNER_EMAIL: process.env.OWNER_EMAIL || '',
    },
    logFile: path.join(MON_DIR, `session-log-${key}-a${attemptNum}.log`),
  });

  // #569: re-verify ownership before any further destructive write — a
  // later tick may have reclaimed this lock as dead (past HEARTBEAT_STALE_MIN
  // with no fresh heartbeat) while this pass was still finishing up.
  if (!isLockGenerationOwner(LOCK_DIR, myGenToken)) {
    log(`lock generation changed while pass ${attemptNum} was running — another tick already reclaimed ${LOCK_DIR}; not touching its lock or state`);
    await alert({
      conditionKey: `on-monitor-generation-lost-${key}`,
      title: `Opening-night monitor: lock reclaimed mid-pass for ${windows.map(w => w.showId).join(', ')}`,
      description: `Pass ${attemptNum} finished (ok=${result.ok}) after another tick reclaimed the lock as dead. Not overwriting the newer generation's state.`,
      severity: 'warning', disposition: 'digest',
    });
    return 1;
  }

  // The whole point of the blocking design: only one process is EVER "the
  // session running" at a time, so the lock's job ends the moment this pass
  // resolves — no adoption/late-start ambiguity like the old detached-cmux
  // launch had.
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });

  const usdTonight = Math.round(((nightState.usdTonight || 0) + (result.usd || 0)) * 100) / 100;

  // Did this pass change anything? Two independent proofs, either sufficient.
  const commits = commitsSince(passStartedAt);
  const stateWritten = statFingerprint(path.join(MON_DIR, `session-state-${key}.json`)) !== stateFileBefore;
  const advancedState = stateWritten || commits > 0;
  const noProgressPasses = advancedState ? 0 : (nightState.noProgressPasses || 0) + 1;
  const progressNote = `state-write=${stateWritten}, data-commits=${commits}`;
  const countAfter = reviewCountFor(windowShows);

  if (!result.ok) {
    const consecutiveFailures = (nightState.consecutiveFailures || 0) + 1;
    writeNightState(key, {
      ...nightState, attempts: attemptNum, consecutiveFailures, usdTonight, noProgressPasses,
      shows: windowShows, lastReviewCount: countAfter === null ? nightState.lastReviewCount : countAfter,
      lastLaunchAt: now.toISOString(), lastFailure: { stage: result.stage, at: now.toISOString() },
    });
    // A failed pass still spent money and is exactly what the escalation
    // email points the owner at this ledger to investigate — a failure that
    // never lands here would be invisible in the one place meant to explain it.
    dispatchLedger.appendEntry({
      event: 'launch-failed', taskId: key,
      shows: windows.map(w => w.showId),
      attempt: attemptNum, model: MODEL, rehearsal, kind: 'on-monitor',
      stage: result.stage, wallMin: Math.round(result.wallMin * 10) / 10, usd: result.usd,
    });
    // Alert severity is about the OWNER's inbox, not about the exit code.
    //
    // The bug this replaces (2026-08-12, how-the-other-half-loves): every
    // !result.ok routed severity:error/disposition:human, so a pass killed by
    // the 15-min wall clock emailed "[CRITICAL] … FAILED" on attempt 1 — while
    // its own body said "next tick retries", and while the pass had in fact
    // committed a real review recovery. Two independent reasons that is not a
    // page:
    //   1. it produced work (advancedState), or
    //   2. the automatic retry hasn't been given a chance to fail yet.
    // A genuine credential outage is unaffected: preflightAuth() above fires
    // on-monitor-auth-failed on the FIRST tick, before an attempt is consumed,
    // and that alert is page-worthy in its own right.
    const retriesExhausted = consecutiveFailures >= MAX_ATTEMPTS_PER_NIGHT;
    const pageOwner = retriesExhausted && !advancedState;
    await alert({
      conditionKey: `on-monitor-launch-failed-${key}`,
      title: pageOwner
        ? `Opening-night monitor: ${consecutiveFailures} consecutive passes failed with no progress for ${windows.map(w => w.showId).join(', ')}`
        : `Opening-night monitor pass did not complete for ${windows.map(w => w.showId).join(', ')}`,
      description: `runMonitorPass: ${result.stage} — ${result.error}. Pass ${attemptNum}, ${consecutiveFailures} consecutive failure(s); ${progressNote}. `
        + (advancedState
          ? 'The pass DID advance state before it ended, so this is progress cut short, not a stalled monitor — next tick continues from it.'
          : retriesExhausted
            ? 'No pass has advanced state across the retry limit — the monitor is not making progress on its own.'
            : 'Next tick retries automatically; escalates only if the retries also make no progress.'),
      severity: pageOwner ? 'error' : 'info',
      disposition: pageOwner ? 'human' : 'digest',
      cooldownHours: 3,
    });
    return 1;
  }

  writeNightState(key, {
    ...nightState, attempts: attemptNum, consecutiveFailures: 0, usdTonight, noProgressPasses,
    shows: windowShows, lastReviewCount: countAfter === null ? nightState.lastReviewCount : countAfter,
    lastLaunchAt: now.toISOString(),
  });
  // dispatch-ledger requires {event, taskId}; taskId carries the night key.
  dispatchLedger.appendEntry({
    event: 'launch', taskId: key,
    shows: windows.map(w => w.showId),
    attempt: attemptNum, model: MODEL, rehearsal, kind: 'on-monitor',
    wallMin: Math.round(result.wallMin * 10) / 10, usd: result.usd,
  });
  await alert({
    conditionKey: `on-monitor-launched-${key}`,
    title: `Opening-night monitor pass complete: ${windows.map(w => w.showId).join(', ')}`,
    description: `Pass ${attemptNum}, model ${MODEL}${rehearsal ? ', REHEARSAL mode' : ''}, ${Math.round(result.wallMin)}min, $${result.usd.toFixed(2)}. ${result.resultText.slice(0, 800)}`,
    severity: 'info', disposition: 'digest',
  });
  log(`pass ${attemptNum} complete for ${windows.map(w => w.showId).join(', ')} (${Math.round(result.wallMin)}min, $${result.usd.toFixed(2)})`);
  return 0;
}

module.exports = { parseArgs, monitorCandidates, buildSeed, resolvePassAuth, alert, main };

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(`[on-monitor] tick crashed: ${e && e.stack || e}`);
    process.exit(1);
  });
}
