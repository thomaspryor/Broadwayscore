#!/usr/bin/env node
'use strict';
/**
 * daily-runner.js — the unattended Codex card worker (BRO-4745). The
 * "Board workers" cloud routine starts it every 2 hours
 * (docs/cloud-routines/board-workers.md; codex-runner.yml can still run it by
 * hand); no Claude session supervises the work itself.
 *
 *   node scripts/codex/daily-runner.js [--limit 10] [--ids BRO-1,BRO-2]
 *        [--max-minutes 105] [--max-weekly-pct 60] [--no-land] [--dry-run]
 *        [--check-max-usd 4] [--check-budget-usd 30] [--card-max-minutes 120]
 *        [--hard-stop-minutes 112] [--slots 3] [--lane cloud|gha]
 *   node scripts/codex/daily-runner.js --lock-status [--lane cloud|gha|all]   (exit 0 free, 3 a live run holds it, 4 unreadable)
 *   node scripts/codex/daily-runner.js --pr N [--head-sha SHA] [--no-land] [--retry]
 *        (BRO-5646, codex-pr-lander.yml: one Codex cloud PR through the same land checks,
 *        Claude check and land/ push as a card, no run lock or Linear card; see runPr)
 *
 * Per card (same picker rules as the hourly Claude cloud worker, minus
 * resumes and cards Codex already bounced):
 *   1. re-read the card; skip unless it is still unstarted, then claim it
 *      (linear-session.js claim; a noop means someone else has it)
 *   2. run the card's check on fresh main (the Done gate's own executor)
 *   3. `codex exec` (high reasoning effort, scripts/codex/runner-prompt.md,
 *      secrets kept out of its shell) in .claude/worktrees/codex-runner
 *   4. commit, run land's unit batches + lint-workflows audits (new failures
 *      go straight back to Codex once, same attempt), then the Claude check:
 *      `claude -p --model opus` with scripts/codex/check-prompt.md. Only
 *      `VERDICT: SHIP` passes.
 *   5. not SHIP: a Codex fix round with the findings (two after a
 *      SHIP-WITH-FIXES; a no-diff run the environment blocked retries once
 *      without using a round), within --card-max-minutes; still not SHIP:
 *      card back to Todo with the findings (BOUNCED_MARKER)
 *   6. SHIP: secret scan + land preflight, push land/codex-bro-N, at most
 *      2 landings in flight; landed -> Done through the Done gate (In Review
 *      if refused), or back to Todo with the reviewer's REMAINING items when
 *      the fix is partial; refused -> stays In Progress for the resume path
 *
 * --slots N (BRO-5384): N runners in parallel, started 2 min apart. Each slot is a full runner
 * with its own worktrees and its own run lock (scripts/lib/codex-runner.js slotNames), so an
 * overlapping firing never runs two runners on one slot. The slots of one launch share a run
 * dir: a card taken there is never claimed by a second slot, land checks run one slot at a
 * time (CPU), and a STOP file from a Codex failure or a Done refusal stops every slot. One slot
 * only when the Codex login could expire mid-run (R.slotsForLogin: one process refreshes it).
 * --lane (BRO-5730): the cloud lane runs slots 0-2, the gha lane (GitHub runner) slots 3-4, so both
 * run at once. Before claiming a card a runner names it in its lock and reads the other locks.
 *
 * Stops early on the time budget, the Codex weekly cap, 3 REJECTs in a row,
 * or a Done refusal (scripts/lib/codex-runner.js stopReason). A crash returns
 * the claimed card to Todo. Posts a run summary on the runner card.
 * Exit 0 ran, 2 no usable Codex login or a missing tool.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'scripts/lib/load-env')).loadEnv();
const linear = require(path.join(ROOT, 'scripts/lib/linear-client.js'));
const { verifyCommand } = require(path.join(ROOT, 'scripts/lib/linear-drain-parked.js'));
const { makeVerifyCmdEvidence } = require(path.join(ROOT, 'scripts/lib/linear-cmd-execution.js'));
const R = require(path.join(ROOT, 'scripts/lib/codex-runner.js'));
const DF = require(path.join(ROOT, 'scripts/lib/codex-data-fixes.js'));
const TL = require(path.join(ROOT, 'scripts/lib/codex-trust-ladder.js'));
const PF = require(path.join(ROOT, 'scripts/lib/codex-sandbox-preflight.js'));
const { createSandbox, sandboxUser, judgeLandSandboxed, readSandboxFile, JSON_MARK } = require(path.join(ROOT, 'scripts/lib/codex-sandbox.js'));

// BRO-6175: shown to Codex only while the data-fix route is on (CODEX_DATA_FIXES_DISABLED unset).
const DATA_FIX_RULE = `- Private data (shows.json, commercial.json, review fields) is never edited directly. Fix it with a plan: \`node scripts/new-fix-plan.js --id=<card id lowercase, e.g. bro-1234> --summary="..." --edit='<showId>.<field>=VALUE' --review-edit='<show>/<file>.json:<field>=VALUE'\` (--help for more; shape in scripts/pending-fix-actions.md). Allowed action types: data-edit, review-field-edit, drop-orphan-key, retitle-show, outlet-registry-flag, coverage-expectation-redecide; at most 25 actions. Keep the generated data/pending-fixes/<id>.json in your change (the runner applies it after the landing and checks it). Never put review text or reader contact details in a plan: the file is public. A fix needing anything else (add-show, retire-show, file moves, scraping) is not yours: say it in a REMAINING: line.`;
const RUNNER_CARD = process.env.CODEX_RUNNER_CARD || 'BRO-4745';
// --slot k (set by the --slots launcher): this runner's worktrees and lock (BRO-5384).
const SLOT = Number(arg('slot', 0)) || 0;
const SLOT_NAMES = R.slotNames(SLOT);
// BRO-5649: the tree's tests, collector, land preflight and the Claude check run as this keyless
// user: a same-uid child reads this process's keys from /proc/<ppid>/environ, scrubbed env or not.
const SB = createSandbox({ user: sandboxUser(SLOT), root: ROOT });
function requireSandbox() {
  const s = SB.ensure();
  if (!s.ok) throw new Error(`could not start the test sandbox, so the change was not judged: ${s.why}`);
}
// The launch's shared run dir (STOP file, card claims, land-check mutex); '' for a lone runner.
const RUN_DIR = typeof arg('run-dir', '') === 'string' ? arg('run-dir', '') : '';
const WT = path.join(ROOT, '.claude/worktrees', SLOT_NAMES.wt);
const LOG_DIR = process.env.CODEX_RUNNER_LOG_DIR || path.join(os.tmpdir(), 'codex-runner');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// Landings this runner keeps in flight; one per slot when several run, so three slots do not
// queue six land refs in front of the Claude lane's.
const MAX_IN_FLIGHT = RUN_DIR ? 1 : 2;
const CODEX_VERSION = '0.160.0';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
// --pr N (BRO-5646): land one Codex cloud pull request instead of working cards (runPr).
const PR_NUM = Number(arg('pr', 0)) || 0;
let timeLimits;
try {
  timeLimits = R.runnerTimeLimits({ lane: String(arg('lane', 'cloud')), pr: PR_NUM, maxMinutes: arg('max-minutes'), hardStopMinutes: arg('hard-stop-minutes') });
} catch (err) { console.error(err.message); process.exit(2); }
const OPTS = {
  limit: Number(arg('limit', 10)),
  ids: arg('ids', '') ? String(arg('ids')).split(',').map((s) => s.trim()).filter(Boolean) : null,
  maxMinutes: timeLimits.maxMinutes,
  maxWeeklyPct: Number(arg('max-weekly-pct', 60)),
  land: !process.argv.includes('--no-land'),
  dryRun: process.argv.includes('--dry-run'),
  // The Claude check bills per review when run outside a subscription session (Actions):
  // each review stops at --check-max-usd, the run stops picking cards at --check-budget-usd.
  checkMaxUsd: Number(arg('check-max-usd', 4)),
  // auto: Sonnet for a small low-risk diff, Opus otherwise (R.checkModel, BRO-5384); opus|sonnet forces one.
  checkModel: ['opus', 'sonnet'].includes(arg('check-model', 'auto')) ? arg('check-model', 'auto') : 'auto',
  checkBudgetUsd: Number(arg('check-budget-usd', 30)),
  // One card's wall clock: a fix-round exec starts only with 15+ min of exec plus the
  // review still inside it, and is cut to fit, so fix rounds cannot run past the budget.
  cardMaxMinutes: Number(arg('card-max-minutes', 120)),
  // The wall clock the run must be fully done by (summary posted, lock released).
  // Card defaults are host-bounded even when a launcher forgets the flags (BRO-5694).
  // PR mode has no hard stop unless explicitly requested, preserving its full landing wait.
  // The routine's background task is killed at 120 min, and a kill during a Codex exec or a
  // check never reaches the SIGTERM handler (spawnSync blocks it): on 2026-10-13 the 20:47
  // firing's runner died mid-card, posted no summary and left its lock and BRO-4277 stranded
  // (BRO-5287). Cards, fix rounds and landing waits are all cut to fit inside it.
  hardStopMinutes: timeLimits.hardStopMinutes,
  slots: Number(arg('slots', 1)) || 1,
  // --lane cloud|gha (BRO-5730): which slots a launch runs (R.LANES). The cloud routine is cloud, the GitHub runner gha.
  lane: String(arg('lane', 'cloud')),
  pickList: Number(arg('pick-list', 0)) || 0,
};
// A slot's hard stop counts from the launch, not from its own (staggered) start.
const RUN_STARTED_MS = Number(arg('run-started', 0)) || Date.now();
const HARD_END_MS = OPTS.hardStopMinutes > 0 ? RUN_STARTED_MS + OPTS.hardStopMinutes * 60_000 : Infinity;
// Time kept free before the hard stop for the summary, the login save and the lock release.
const WRAP_UP_MS = 8 * 60_000;
// A card starts only while R.cardStartMs (verify, a 15-min exec, the land checks, the 30-min
// review) fits before the wrap-up: the old flat 60 min started cards whose review could not
// fit, and 18 of them were handed back unjudged on 2026-10-17/18 (BRO-5384).
// Last measured land-check run, mutex wait included; sizes the exec and card-start reserves (R.execBudgetMs).
let landChecksMs = R.LAND_CHECKS_MS;
/** True while `ms` more still fits before the hard stop's wrap-up time. */
const fitsBeforeHardStop = (ms) => HARD_END_MS - WRAP_UP_MS - Date.now() >= ms;
const CODEX_TIMEOUT_MS = 45 * 60_000;
let checkSpentUsd = 0;
const checkByModel = {}; // model -> { n, usd }: the savings line in the summary
let checkCount = 0;

fs.mkdirSync(LOG_DIR, { recursive: true });
const RUN_LOG = path.join(LOG_DIR, `run-${new Date().toISOString().slice(0, 10)}${SLOT ? `-slot${SLOT}` : ''}.log`);
function log(msg) {
  const line = `[${new Date().toISOString()}]${RUN_DIR ? ` [slot ${SLOT}]` : ''} ${msg}`;
  console.log(line);
  fs.appendFileSync(RUN_LOG, `${line}\n`);
}

function sh(cmd, args, opts = {}) {
  // No git hooks, ever: core.hooksPath (set by npm ci's postinstall) is relative, so a hook
  // would run from the worktree, i.e. the code under review, with this process's env (BRO-5646).
  if (cmd === 'git') args = ['-c', 'core.hooksPath=/dev/null', ...args];
  const r = spawnSync(cmd, args, { cwd: opts.cwd || ROOT, encoding: 'utf8', timeout: opts.timeoutMs || 600_000, env: opts.env || process.env, input: opts.input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status == null ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}
function git(args, cwd = WT) {
  let r = sh('git', args, { cwd });
  // fetch/push go over the network; GitHub answers 503 now and then.
  for (let i = 0; r.code !== 0 && ['fetch', 'push'].includes(args[0]) && i < 4; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * 2 ** i);
    r = sh('git', args, { cwd });
  }
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.out.trim().split('\n').slice(-2).join(' ')}`);
  return r.stdout.trim();
}
const tail = (s, n = 1500) => (s.length > n ? `...${s.slice(-n)}` : s);
const fence = (s) => `\`\`\`\n${String(s).replace(/```/g, "'''")}\n\`\`\``;

// The run dir the slots of one launch share (R.launchRunDir, BRO-5384); no-ops for a lone runner.
const LAUNCH = R.launchRunDir(RUN_DIR, SLOT);
const runStop = () => LAUNCH.stopped();
const stopAllSlots = (why) => LAUNCH.stopAll(why);
const takeCardInRun = (id) => LAUNCH.takeCard(id);
// Re-stamp the run lock every 10 min while waiting for the land-check mutexes.
// A wait that would leave no time to run the checks before the hard stop gives up (LandWaitTimeout)
// instead of holding the run past it: the card is handed back unjudged, not crashed mid-land-checks.
class LandWaitTimeout extends Error {}
const withLandMutex = (fn) => {
  let lastStamp = Date.now();
  const onWait = () => {
    if (!fitsBeforeHardStop(landChecksMs)) throw new LandWaitTimeout('no time left to wait for the land-check slot before the hard stop');
    if (Date.now() - lastStamp > 10 * 60_000) { keepLock(); lastStamp = Date.now(); }
  };
  // Slots of this launch first, then any other land check in the container (land-local-check.js).
  return LAUNCH.withMutex('land-checks', () => R.withFileMutex(R.CONTAINER_LAND_MUTEX, fn, { onWait }), onWait);
};

/**
 * Env for the Codex shell: no service keys or tokens (so no paid fetches, LLM rescoring or
 * Linear writes) and git pushes rewritten to nowhere. The land checks and the Claude check
 * run as the sandbox user instead (SB, BRO-5649); Codex itself still runs as this uid.
 */
function scrubbedEnv() {
  return R.scrubEnv(process.env);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** linear-brain.js with every --comment redacted; retries transient failures (429s), never a gate refusal (exit 5). */
/**
 * BRO-6139 stage 2: a runner that exits without a summary says why, in one comment on the runner
 * card (R.standDownNote), so the lane alarm reads a reason instead of a quiet exit 0.
 */
// One attempt, 2 min at most: sh is spawnSync, so a timer cannot bound it, and linearBrain's retries
// (up to an hour) would hold a stopped run's job. --pr runs are not card runs and post nothing here.
let summaryPosted = false;
function standDown(cls, why, { holderStartedMs = NaN, loginExpiresMs = NaN, exitCode = null } = {}) {
  log(`not starting (${cls}): ${why}`);
  if (exitCode !== null) process.exitCode = exitCode;
  if (OPTS.dryRun || PR_NUM || summaryPosted) return;
  const body = R.redactSecrets(R.standDownNote({ lane: OPTS.lane, slot: SLOT, cls, why, holderStartedMs, loginExpiresMs }), process.env);
  const r = sh('node', ['scripts/linear-brain.js', 'update', RUNNER_CARD, '--comment', body], { timeoutMs: 120_000 });
  if (r.code !== 0 && r.code !== 5) log(`stand-down note not posted: exit ${r.code} ${tail(r.out, 200)}`);
}
// A failure that ends the run before it starts; main() turns it into a stand-down note.
const startFailure = (cls, message, exitCode = 2) => Object.assign(new Error(message), { standDownClass: cls, exitCode });

async function linearBrain(args) {
  const safe = args.map((a, i) => (args[i - 1] === '--comment' ? R.redactSecrets(a, process.env) : a));
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = sh('node', ['scripts/linear-brain.js', ...safe], { timeoutMs: 1_200_000 });
    if (r.code === 0 || r.code === 5) break;
    log(`linear-brain ${safe[0]} ${safe[1]}: exit ${r.code}, retry ${i + 1}`);
    await sleep(30_000 * (i + 1));
  }
  return r;
}

/** ROOT's git common dir (absolute): every runner worktree's .git must point into its worktrees/. */
const gitCommonDir = () => git(['rev-parse', '--path-format=absolute', '--git-common-dir'], ROOT);
function setupWorktree() {
  if (SB.dropStale(WT, { gitCommon: gitCommonDir() })) log(`removed ${WT}: a sandboxed run that did not finish left it owned by the sandbox`);
  if (!fs.existsSync(path.join(WT, '.git'))) {
    sh('git', ['worktree', 'prune']);
    git(['fetch', 'origin', 'main'], ROOT);
    git(['worktree', 'add', '--detach', WT, 'origin/main'], ROOT);
  }
  linkNodeModules(WT);
}
/** Link <tree>/node_modules to ROOT's (a dangling link is replaced). Node finds ROOT's copy from a nested tree anyway, but tests that copy the tree to /tmp follow this link. */
function linkNodeModules(tree) {
  const link = path.join(tree, 'node_modules');
  const want = path.join(ROOT, 'node_modules');
  let ok = false;
  try { ok = fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === want; } catch { /* missing */ }
  // Anything else (a dangling link, or a dir the sandbox put there) is replaced.
  if (!ok) { fs.rmSync(link, { recursive: true, force: true }); fs.symlinkSync(want, link); }
}

/** Least free space across the worktrees and data copies (ROOT), Codex sessions and test temp files, or null. */
function freeDisk() {
  let free = null;
  for (const dir of [ROOT, CODEX_HOME, os.tmpdir()]) {
    try { const st = fs.statfsSync(dir); const b = st.bavail * st.bsize; free = free == null ? b : Math.min(free, b); } catch { /* missing dir: skip */ }
  }
  return free;
}

/** Process cwds, so a worktree a live process stands in is never a candidate. */
function liveCwds() {
  const out = [];
  try { for (const pid of fs.readdirSync('/proc')) if (/^\d+$/.test(pid)) { try { out.push(fs.readlinkSync(`/proc/${pid}/cwd`)); } catch { /* not ours or gone */ } } } catch { /* no /proc */ }
  return out;
}

/**
 * Remove .claude/worktrees/<name> a Claude worker lane left behind (BRO-6304: ~1.3 GB each filled
 * the cloud container: "only 1.4 GB of disk left"). R.staleClaudeWorktrees decides; this gathers the
 * facts, and a tree with any unknown fact is kept. Plain `git worktree remove`, never --force.
 */
function pruneClaudeWorktrees() {
  const dir = path.join(ROOT, '.claude/worktrees');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => !R.CODEX_SLOT_WORKTREE.test(n)); } catch { return; }
  if (!names.length) return;
  const now = Date.now();
  const cutoff = now - R.CLAUDE_WORKTREE_IDLE_MS;
  // unbounded-fetch-ok: the runner works in a full clone (never a fetch-depth:1 workflow checkout) and needs history for git cherry
  sh('git', ['fetch', '-q', 'origin', 'main'], { cwd: ROOT, timeoutMs: 60_000 });
  const lockedPaths = R.lockedWorktreePaths(sh('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT }).stdout);
  const cwds = liveCwds();
  const entries = names.map((name) => {
    const wt = path.join(dir, name);
    let real = wt;
    try { real = fs.realpathSync(wt); } catch { return { name }; }
    const entry = { name, liveCwd: R.cwdInside(cwds, real), locked: lockedPaths.has(wt) || lockedPaths.has(real) };
    let gitdir = null;
    try { gitdir = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() || null; } catch { /* not a worktree */ }
    if (!gitdir) return entry;
    let meta = 0;
    for (const f of ['HEAD', 'index', 'logs/HEAD']) { try { meta = Math.max(meta, fs.statSync(path.join(gitdir, f)).mtimeMs); } catch { /* absent */ } }
    // Cheapest checks first: a tree with a live process or a recent touch needs no git calls.
    if (entry.liveCwd || entry.locked || !meta || now - meta <= R.CLAUDE_WORKTREE_IDLE_MS) return { ...entry, newestMs: now - meta <= R.CLAUDE_WORKTREE_IDLE_MS ? meta : undefined };
    const newest = R.newestMtimeMs(wt, cutoff);
    const status = sh('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: wt, timeoutMs: 60_000 });
    // `git cherry`: a commit that landed rebased on main has an equivalent there ('-'); '+' is work main lacks.
    const ahead = sh('git', ['cherry', 'origin/main', 'HEAD'], { cwd: wt, timeoutMs: 60_000 });
    return {
      ...entry, newestMs: Math.max(meta, newest),
      // `git status` and `worktree remove` ignore gitignored files: a .env, or a real review-texts clone
      // with unpushed commits, would go with the tree. Keep any tree holding one (BRO-6304 ship-check).
      dirty: status.code === 0 ? status.stdout.trim() !== '' || R.holdsIgnoredWork(wt) : null,
      unpushed: ahead.code === 0 ? /^\+/m.test(ahead.stdout) : null,
    };
  });
  const doomed = R.staleClaudeWorktrees(entries, now);
  const removed = [];
  for (const name of doomed) {
    // Non-throwing: a sibling slot may have removed it already.
    const r = sh('git', ['worktree', 'remove', path.join(dir, name)], { cwd: ROOT, timeoutMs: 120_000 });
    if (r.code === 0) removed.push(name); else log(`pruneDisk: worktree ${name} kept (${tail(r.out, 120).trim()})`);
  }
  if (removed.length) log(`pruneDisk: removed ${removed.length} stale Claude worktree(s): ${removed.slice(0, 8).join(', ')}`);
  else log(`pruneDisk: ${names.length} non-runner worktree(s), none stale+clean+pushed`);
}

/** What holds the disk, for the run log when it runs low (BRO-6304): worktrees, temp dir, Codex home. */
function logDiskUsage(why) {
  const kb = (p) => { const r = sh('du', ['-sk', p], { timeoutMs: 30_000 }); return r.code === 0 || r.stdout ? Number(r.stdout.split('\t')[0]) || 0 : 0; };
  const rows = [];
  const add = (label, p) => { try { fs.statSync(p); rows.push([label, kb(p)]); } catch { /* absent */ } };
  try { for (const n of fs.readdirSync(path.join(ROOT, '.claude/worktrees'))) add(`worktrees/${n}`, path.join(ROOT, '.claude/worktrees', n)); } catch { /* none */ }
  try { for (const n of fs.readdirSync(os.tmpdir())) add(`tmp/${n}`, path.join(os.tmpdir(), n)); } catch { /* none */ }
  add('CODEX_HOME', CODEX_HOME);
  const top = rows.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, k]) => `${l} ${(k / 1e6).toFixed(1)}G`);
  log(`disk usage (${why}): ${top.join(', ') || 'nothing measurable'}`);
}

/**
 * Delete what killed tests and data copies left in the temp dir (R.staleTmpEntries: only known
 * prefixes, past an age no live run reaches, so a sibling slot's own temp dirs are safe) and
 * prune worktrees whose directory is gone. The routine fires into one long-lived session every
 * 2 h, so leaks pile up across firings (BRO-5422/5443: 1.7 GB per leaked /tmp/bro-5217-*).
 */
function pruneDisk() {
  const lowFree = freeDisk();
  if (lowFree != null && lowFree < R.MIN_FREE_DISK_BYTES * 3) logDiskUsage(`${(lowFree / 1e9).toFixed(1)} GB free, before pruning`);
  const tmp = os.tmpdir();
  let entries = [];
  try {
    entries = fs.readdirSync(tmp).map((name) => {
      try { return { name, mtimeMs: fs.lstatSync(path.join(tmp, name)).mtimeMs }; } catch { return null; }
    }).filter(Boolean);
  } catch { /* unreadable tmp: nothing to prune */ }
  const stale = R.staleTmpEntries(entries, Date.now());
  // A test that ignored TMPDIR leaves sandbox-owned entries: EACCES here, never a crash.
  for (const name of stale) { try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); } catch (e) { log(`pruneDisk: ${name} kept (${e.code || e.message})`); } }
  // Safe beside a sibling slot's `git worktree add`: git locks a worktree while it initializes.
  sh('git', ['worktree', 'prune'], { cwd: ROOT });
  pruneClaudeWorktrees();
  if (stale.length) log(`pruneDisk: removed ${stale.length} stale temp dir(s): ${stale.slice(0, 8).join(', ')}`);
}

/**
 * Give a freshly cleaned worktree the private data the main checkout has (R.DATA_FILES
 * copied, data/review-texts linked), since `git clean -x` removes it. reviewTexts: false
 * for the land-check batches: land.yml has no review texts either, and those batches run
 * outside the Codex sandbox, so a test write must not reach the shared clone. The default is the
 * trust ladder's review-texts rung (BRO-6303): unlocked links it, locked does not and says why.
 * -> { lines (for the prompts), dirs (real paths the reviewer may read) }
 */
function provideData(dest, { ladder = R.codexLadderAccess(), reviewTexts } = {}) {
  const rt = R.reviewTextsPlan({ ladder, reviewTexts });
  const src = path.join(ROOT, 'data');
  const provided = [];
  const missing = [];
  const present = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  for (const name of R.DATA_FILES) {
    const from = path.join(src, name);
    const to = path.join(dest, 'data', name);
    if (!fs.existsSync(from)) { if (['shows.json', 'reviews.json'].includes(name)) missing.push(`data/${name}`); continue; }
    if (present(to)) continue; // tracked in this checkout, or already provided
    fs.copyFileSync(fs.realpathSync(from), to);
    provided.push(`data/${name}`);
  }
  const dirs = [];
  const lines = [];
  for (const name of R.DATA_DIRS) {
    const from = path.join(src, name);
    const to = path.join(dest, 'data', name);
    if (!rt.link || !fs.existsSync(from)) {
      if (rt.link) lines.push(`- data/${name}: not available in this run. If the card needs it, say so in a REMAINING line.`);
      else if (rt.note) lines.push(`- data/${name}: ${rt.note}`);
      // A relock mid-run: a link an earlier card got (git clean without -x keeps it) goes now.
      if (!rt.link && present(to) && fs.lstatSync(to).isSymbolicLink()) fs.unlinkSync(to);
      continue;
    }
    const real = fs.realpathSync(from);
    let cfg = '';
    try { cfg = fs.readFileSync(path.join(real, '.git', 'config'), 'utf8'); } catch { /* not a clone */ }
    if (R.hasCredentialRemote(cfg)) { log(`provideData: ${real} keeps a credential in its remote URL; not linked`); lines.push(`- data/${name}: not available in this run.`); continue; }
    if (present(to) && !fs.lstatSync(to).isSymbolicLink()) R.dropDataDir(to, dest); // a dir a test made
    if (!present(to)) { fs.symlinkSync(real, to); provided.push(`data/${name}`); }
    dirs.push(real);
    lines.push(`- data/${name} -> ${real}: the private review-texts clone. Read it; never write there.`);
  }
  // Belt and braces: whatever we put there must be gitignored, or `git add -A` would commit it.
  const ignored = new Set();
  const candidates = R.DATA_FILES.map((n) => `data/${n}`).filter((p) => present(path.join(dest, p)));
  if (candidates.length || provided.length) {
    const ign = sh('git', ['check-ignore', ...new Set([...candidates, ...provided])], { cwd: dest });
    for (const l of ign.stdout.split('\n')) if (l.trim()) ignored.add(l.trim());
  }
  for (const p of provided.filter((x) => !ignored.has(x))) {
    log(`provideData: ${p} is not gitignored in ${dest}; removed`);
    fs.rmSync(path.join(dest, p), { force: true });
  }
  const copies = candidates.filter((p) => ignored.has(p)).map((p) => p.slice('data/'.length));
  if (copies.length) lines.unshift(`- data/{${copies.join(',')}}: copies of the private core-data repo for this card (edits stay in this checkout and are discarded afterwards; never committed).`);
  if (missing.length) lines.unshift(`- ${missing.join(', ')}: missing on this machine, so real-data checks cannot run. Say so in your report.`);
  return { lines, dirs };
}

// The main commit this card's branch starts from. Slots share one .git, so another slot's fetch
// moves origin/main mid-card; the land-check base, the reviewer's base and a carried patch all
// use this sha, so a test fixed on main meanwhile never reads as Codex's new failure (BRO-5384).
let cardBase = 'origin/main';
function resetWorktree(branch) {
  git(['fetch', 'origin', 'main']);
  cardBase = git(['rev-parse', 'origin/main']);
  git(['checkout', '-f', '-B', branch, cardBase]);
  git(['reset', '--hard', cardBase]);
  // -x: gitignored files Codex or tests wrote must not carry into the next card.
  git(['clean', '-fdx', '-e', 'node_modules']);
  return provideData(WT);
}

/** Newest Codex weekly allowance reading in this container's rollouts (scripts/lib/codex-runner.js), or null. */
function weeklyPct() {
  return R.weeklyPctFromSessions(CODEX_HOME);
}

function saveLogin() {
  const r = sh('node', ['scripts/codex/auth-store.js', 'save'], { timeoutMs: 900_000 });
  if (r.code !== 0) log(`login save failed: ${tail(r.out, 300)}`);
}

/** Codex's --sandbox mode, probed once per process (BRO-5856: bubblewrap cannot start in the cloud routine). */
let sandboxChoice = null;
function codexSandboxMode() {
  if (!sandboxChoice) {
    sandboxChoice = PF.chooseSandbox(PF.probeNamespaceSandbox((c, a) => sh(c, a, { timeoutMs: 30_000 })));
    log(`codex sandbox: ${sandboxChoice.mode || 'none'} (${sandboxChoice.reason})`);
  }
  if (!sandboxChoice.ok) throw new Error(sandboxChoice.reason);
  return sandboxChoice.mode;
}

// BRO-6236: the model and effort each card ran at, for the summary's settings line. Models come
// from CODEX_MODEL (a strongest-first list); an unknown-model refusal moves to the next one.
const codexUsed = { model: '', cards: {} };
let modelIdx = 0;

function runCodex(id, prompt, tag, timeoutMs = CODEX_TIMEOUT_MS) {
  const last = path.join(LOG_DIR, `${id}-${tag}-last.md`);
  fs.writeFileSync(path.join(LOG_DIR, `${id}-${tag}-prompt.md`), prompt);
  const cfg = R.codexSettings(process.env, id);
  const exec = () => {
    const model = cfg.models[modelIdx];
    return { model, r: sh('codex', ['exec', '--dangerously-bypass-hook-trust', '--sandbox', codexSandboxMode(), '--color', 'never',
      ...(model ? ['-m', model] : []),
      '-c', `model_reasoning_effort=${cfg.effort}`, '-o', last, '-C', WT, prompt],
    { cwd: WT, timeoutMs, env: scrubbedEnv(), input: '' }) };
  };
  let t0 = Date.now();
  let { model, r } = exec();
  // A model refusal comes back at once; a failure after minutes of work is not one, so it never
  // re-runs the exec or moves the whole run down the list.
  while (r.code > 0 && Date.now() - t0 < 3 * 60_000 && model && modelIdx < cfg.models.length - 1 && R.isUnknownModelError(r.out)) {
    log(`${id}: model ${model} refused by this login; trying ${cfg.models[modelIdx + 1]}`);
    log(`${id}: ${model} refusal: ${tail(r.out, 300).replace(/\s+/g, ' ')}`);
    modelIdx += 1;
    t0 = Date.now();
    ({ model, r } = exec());
  }
  if (model && !codexUsed.model.split(' then ').includes(model)) codexUsed.model = codexUsed.model ? `${codexUsed.model} then ${model}` : model;
  codexUsed.cards[id] = { effort: cfg.effort, model: model || '' };
  log(`${id}: codex exec model ${model || 'CLI default'}, effort ${cfg.effort}${cfg.arm ? ' (A/B arm)' : ''}`);
  fs.writeFileSync(path.join(LOG_DIR, `${id}-${tag}.log`), r.out);
  saveLogin(); // refresh tokens rotate: persist the newest login after every exec
  let report = '';
  try { report = fs.readFileSync(last, 'utf8'); } catch { report = tail(r.out, 4000); }
  return { code: r.code, report, out: r.out };
}

/** The reviewer's whole tool list: reading only (see runCheck). */
const CHECK_TOOLS = 'Read,Grep,Glob';
function runCheck(card, body, codexReport, tag, data) {
  const tpl = fs.readFileSync(path.join(ROOT, 'scripts/codex/check-prompt.md'), 'utf8');
  // Fresh main beside the change, so the reviewer counts only test failures the change adds
  // (BRO-5384: 16 of BRO-4820's 17 cited failures failed on main too). Same tree land judges against.
  let base = '';
  try { prepareBase(); base = BASE_WT; } catch (e) { log(`${card.identifier}: no base worktree for the check (${e.message.split('\n')[0]})`); }
  // The reviewer has no tool that runs code (BRO-5649), so the runner hands it the diff.
  const diff = (() => { try { return git(['diff', '--no-ext-diff', '--no-textconv', 'origin/main...HEAD'], WT); } catch (e) { return `(the diff could not be computed: ${e.message.split('\n')[0]})`; } })();
  const prompt = `${R.fillPrompt(tpl, { id: card.identifier, title: card.title, body, extra: fence(tail(codexReport, 6000)), data: data.lines.join('\n'), worktree: WT, base })}\n\n## The diff (origin/main...HEAD)\n\n${fence(diff.length > 120_000 ? `${diff.slice(0, 120_000)}\n... (truncated: read the rest of the changed files in the worktree)` : diff)}\n`;
  fs.writeFileSync(path.join(LOG_DIR, `${card.identifier}-${tag}-prompt.md`), prompt);
  const head = git(['rev-parse', 'HEAD']);
  // Drop the review-texts link (land.yml runs without it too); the reviewer reads the texts through --add-dir.
  for (const d of R.DATA_DIRS) R.dropDataDir(path.join(WT, 'data', d), WT);
  // cwd is the worktree, the root of what it may read; --restricted keeps the project's session
  // hooks and settings out of this one-shot reviewer.
  // Prompt on stdin: --add-dir is variadic and swallows a positional.
  // --add-dir: the data the worktree links to (review texts live outside it), or the
  // reviewer is denied every read there.
  const model = pickCheckModel(card.identifier);
  requireSandbox();
  // The reviewer holds Claude auth, so it gets no tool that runs code: any of Bash's commands (node,
  // git -c, sed's e, sort's compress-program) would run the tree's code next to that auth.
  // --restricted: no code-running tools and no settings files; --strict-mcp-config: no MCP servers.
  const args = ['-p', '--model', model, '--restricted', '--strict-mcp-config', '--output-format', 'json',
    '--max-budget-usd', String(OPTS.checkMaxUsd),
    ...(data.dirs.length || base ? ['--add-dir', ...data.dirs, ...(base ? [base] : [])] : []),
    // No --allowedTools: unallowed reads outside the worktree and --add-dir dirs are refused in -p mode,
    // so its reach is those dirs (minus REVIEWER_READ_DENY), never the rest of the machine.
    '--tools', CHECK_TOOLS,
  ];
  let r;
  if (R.reviewerSandboxAuth(process.env)) {
    // Auth is an env key (the GitHub lanes): run as the sandbox too, so a read the diff talks it
    // into cannot reach runner-only files. The key goes through a file, never argv.
    // Only the login itself (and ANTHROPIC_* endpoint config): the session's other CLAUDE_* tokens stay out.
    const auth = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^ANTHROPIC_/.test(k) || k === 'CLAUDE_CODE_OAUTH_TOKEN'));
    r = SB.run(WT, 'claude', [...args, '--settings', JSON.stringify({ permissions: { deny: R.REVIEWER_READ_DENY } })], { timeoutMs: 30 * 60_000, input: prompt, secretEnv: auth });
  } else {
    // A cloud container's login is a root-only file the sandbox cannot use, so the reviewer runs as
    // the runner with its reads denied on the places runner secrets live.
    r = sh('claude', [...args, '--settings', JSON.stringify({ permissions: { deny: R.REVIEWER_READ_DENY } })],
      { cwd: WT, timeoutMs: 30 * 60_000, env: R.scrubEnv(process.env, { reviewer: true }), input: prompt });
  }
  fs.writeFileSync(path.join(LOG_DIR, `${card.identifier}-${tag}.log`), r.out);
  // The verdict is about the committed HEAD. A moved HEAD means the reviewer committed or
  // checked out, so its verdict is void. Leftover files are test residue (tests rewrite
  // data/audit/*.json): clean them either way so they never reach the next commit.
  const tampered = git(['rev-parse', 'HEAD']) !== head;
  git(['reset', '-q', '--hard', head]);
  git(['clean', '-qfd', '-e', 'node_modules']);
  provideData(WT);
  if (base) { try { cleanTree(BASE_WT); } catch { /* the next prepareBase resets it */ } }
  const out = R.parseCheckOutput(r.stdout);
  checkSpentUsd += out.costUsd;
  checkCount += 1;
  const m = (checkByModel[model] = checkByModel[model] || { n: 0, usd: 0 });
  m.n += 1;
  m.usd += out.costUsd;
  log(`${card.identifier} ${tag}: Claude check (${model}) cost $${out.costUsd.toFixed(2)}${out.error ? ` (${out.error})` : ''}`);
  const verdict = r.code === 0 && !tampered && !out.error ? R.parseVerdict(out.text) : 'NONE';
  return { verdict, text: tampered ? 'The reviewer changed the worktree, so its verdict was discarded.' : tail(out.text || r.out, 3000) };
}

/** The check's model for the committed change (--check-model, else R.checkModel on its numstat). */
function pickCheckModel(id) {
  if (OPTS.checkModel !== 'auto') return OPTS.checkModel;
  let files = [];
  try {
    // -z: paths raw, never quoted ("data/caf\303\251.json" would slip past the risky-path check).
    files = git(['diff', '--numstat', '-z', '--no-renames', `${cardBase}...HEAD`]).split('\0').filter(Boolean).map((l) => {
      const [a, d, ...p] = l.split('\t');
      return { path: p.join('\t').trim(), changed: (Number(a) || 0) + (Number(d) || 0) + (a === '-' ? CHECK_BINARY_LINES : 0) };
    });
  } catch { /* unreadable diff: Opus */ }
  const { classifyChange } = require(path.join(ROOT, 'scripts/lib/infra-review-scope.js'));
  const c = R.checkModel({ files, classify: classifyChange });
  log(`${id}: Claude check on ${c.model} (${c.why})`);
  return c.model;
}
const CHECK_BINARY_LINES = 1000; // a binary file is never "small"

/** Commit Codex's working-tree changes (message: a --pr landing's own). -> { hasDiff, blocked } */
function commitAttempt(card, attempt, message = null) {
  git(['add', '-A']); // node_modules is a gitignored symlink; naming it in a pathspec makes git add fail
  const names = git(['diff', '--cached', '--name-only', '--no-renames']).split('\n').filter(Boolean);
  if (!names.length) return { hasDiff: git(['rev-list', '--count', 'origin/main..HEAD']) !== '0', blocked: null };
  if (names.some((n) => n.startsWith('.github/workflows/'))) return { hasDiff: true, blocked: 'Codex edited .github/workflows/**, which the runner never lands' };
  if (names.some((n) => TL.isProtectedPath(n))) return { hasDiff: true, blocked: 'Codex edited the trust ladder (its own grading rules or the inputs they read), which the runner never lands' };
  // A staged symlink could point at the private data the runner links in (land refuses tracked symlinks too).
  if (/^:\d+ 120000 /m.test(git(['diff', '--cached', '--raw']))) return { hasDiff: true, blocked: 'the change adds a symlink, which the runner never lands' };
  if (R.looksLikeSecretLeak(git(['diff', '--cached']))) return { hasDiff: true, blocked: 'the diff looks like it carries token material' };
  git(['-c', 'user.name=Codex runner', '-c', 'user.email=codex-runner@broadwayscorecard.com', 'commit', '-q', '-m',
    message || `fix(${card.identifier}): ${card.title.slice(0, 80)}${attempt > 1 ? ' (review fixes)' : ''}\n\nWorked by the daily Codex runner; passed the independent check before landing.`]);
  return { hasDiff: true, blocked: null };
}

// The land checks a Codex change can break without noticing (BRO-4745 follow-up): the node
// unit batch (collected by scripts/lib/unit-test-collection.js, BRO-2483), the scripts/lib/*.test.mjs batch, and the
// lint-workflows audit list (land-gauntlet.sh, GAUNTLET_GATES=lint-workflows), each judged the
// way land.yml judges it: failures the branch adds over fresh main (land-gate-delta.js). Only
// what fails on the branch re-runs on main, so the base side is cheap. Run without the review
// texts, like land.yml. Returns null when clean, else the failure text.
const BASE_WT = path.join(ROOT, '.claude/worktrees', SLOT_NAMES.base);
function unitBatch(cwd, files) {
  // As the sandbox (the caller hands it the tree): the file list and tests come from Codex's branch.
  const r = SB.run(cwd, 'node', ['--test', '--test-reporter=tap', '--test-timeout', '300000', ...files], { timeoutMs: 40 * 60_000 });
  return { exit: r.code, text: r.out, root: cwd };
}
function lintWorkflows(cwd, gauntlet) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lw-'));
  try {
    fs.chmodSync(out, 0o777); // the sandbox writes the gate's .exit and .log here
    SB.run(cwd, 'bash', [gauntlet, out], { timeoutMs: 30 * 60_000, env: { GAUNTLET_GATES: 'lint-workflows' } });
    // The sandbox wrote these: regular files only, so a planted symlink cannot make the runner read its own secrets.
    const exitText = readSandboxFile(path.join(out, 'lint-workflows.exit'));
    const exit = exitText === null ? NaN : Number(exitText.trim());
    return { exit: Number.isFinite(exit) ? exit : null, text: readSandboxFile(path.join(out, 'lint-workflows.log')) || '', root: cwd };
  } catch { return { exit: null, text: '', root: cwd }; } finally { SB.remove(out); }
}
function cleanTree(cwd) {
  git(['reset', '-q', '--hard', 'HEAD'], cwd);
  git(['clean', '-qfdx', '-e', 'node_modules'], cwd);
}
function prepareBase() {
  if (SB.dropStale(BASE_WT, { gitCommon: gitCommonDir() })) log(`removed ${BASE_WT}: a sandboxed run that did not finish left it owned by the sandbox`);
  if (!fs.existsSync(path.join(BASE_WT, '.git'))) {
    sh('git', ['worktree', 'prune'], { cwd: ROOT });
    git(['worktree', 'add', '--detach', BASE_WT, 'origin/main'], ROOT);
  }
  linkNodeModules(BASE_WT);
  git(['checkout', '-q', '-f', '--detach', cardBase], BASE_WT);
  git(['clean', '-qfdx', '-e', 'node_modules'], BASE_WT);
  provideData(BASE_WT, { reviewTexts: false });
}
function newLandFailures() {
  const t0 = Date.now();
  try { return withLandMutex(newLandFailuresNow); } finally { landChecksMs = Math.min(2 * R.LAND_CHECKS_MS, Math.max(R.LAND_CHECKS_MS, Date.now() - t0)); }
}
function newLandFailuresNow() {
  const D = require(path.join(ROOT, 'scripts/lib/land-gate-delta.js'));
  // The branch's own harness copy judges both trees, as land.yml does.
  // Its own dir, with the gauntlet's siblings (BRO-6152: a lone copy lost tsc-node-options.sh).
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-land-gauntlet-'));
  try {
    const gauntlet = require(path.join(ROOT, 'scripts/lib/land-local-check.js')).stageGauntletHarness(WT, harnessDir);
    return landFailuresWith(D, gauntlet);
  } finally { fs.rmSync(harnessDir, { recursive: true, force: true }); }
}
function landFailuresWith(D, gauntlet) {
  requireSandbox();
  for (const d of R.DATA_DIRS) R.dropDataDir(path.join(WT, 'data', d), WT); // the link, or a dir a test made
  // ROOT's nodeUnitTestsForTree loads the tree's own collector (the tree's code), so it runs in the sandbox. Anything but a list -> [].
  const nodeFiles = (() => {
    const { value } = SB.runMarked(WT, `const C=require(process.argv[1]);console.log(${JSON.stringify(JSON_MARK)}+JSON.stringify(C.nodeUnitTestsForTree(process.argv[2])))`,
      [path.join(ROOT, 'scripts/lib/unit-test-collection.js'), WT], { timeoutMs: 120_000 });
    return Array.isArray(value) && value.every((f) => typeof f === 'string') ? value : [];
  })();
  const libTests = fs.readdirSync(path.join(WT, 'scripts/lib')).filter((f) => f.endsWith('.test.mjs')).map((f) => `scripts/lib/${f}`);
  const batches = [
    // BRO-2483: the tree's own collector (or, in a pre-BRO-2483 tree, its manifest). Empty fails closed below.
    { gate: 'unit-tests-node', run: (cwd, files) => unitBatch(cwd, files), files: nodeFiles },
    { gate: 'scripts-lib-tests', run: (cwd, files) => unitBatch(cwd, files), files: libTests },
    { gate: 'lint-workflows', run: (cwd) => lintWorkflows(cwd, gauntlet), files: null },
  ];
  const branch = new Map();
  // Re-stamp before every batch: each one blocks up to 40 min and the keep-alive interval
  // cannot fire during spawnSync, so without this a live run outlives LOCK_STALE_MS here.
  SB.withTrees([WT], () => {
    for (const b of batches) {
      keepLock();
      const empty = R.emptyBatchVerdict(b.gate, b.files);
      branch.set(b.gate, empty ? { ...empty, root: WT } : b.run(WT, b.files));
    }
  });
  // Some tests rewrite tracked files (data/audit/*.json). The attempt is already committed,
  // so put the tree back: otherwise the next commit sweeps them in and the reviewer's
  // dirty-tree guard throws its verdict away.
  cleanTree(WT);
  provideData(WT);
  // actionlint is not installed in the cloud or on this job: its exit-127 failure is the same
  // on main, so it alone is no reason to spend another lint-workflows run on the base.
  const onlyMissingActionlint = (b) => b.gate === 'lint-workflows' && sh('actionlint', ['--version'], { timeoutMs: 30_000 }).code !== 0
    && [...D.parseGateFailures(b.gate, branch.get(b.gate).text, WT).values()].every((f) => f.name === 'actionlint')
    && D.parseGateFailures(b.gate, branch.get(b.gate).text, WT).size > 0;
  const red = batches.filter((b) => branch.get(b.gate).exit !== 0 && !onlyMissingActionlint(b));
  const report = [];
  if (red.length) {
    keepLock();
    prepareBase();
    SB.withTrees([BASE_WT], () => { for (const b of red) {
      keepLock();
      const br = branch.get(b.gate);
      let base;
      if (b.files) {
        const failing = [...new Set([...D.parseGateFailures(b.gate, br.text, WT).values()].map((f) => f.file))].filter((f) => f && f !== '?');
        const onBase = failing.filter((f) => fs.existsSync(path.join(BASE_WT, f)));
        base = onBase.length ? b.run(BASE_WT, onBase) : { exit: 0, text: '', root: BASE_WT };
      } else base = b.run(BASE_WT);
      const d = D.decideGateDelta({ gate: b.gate, base, branch: br });
      if (d.verdict === 'pass') continue;
      const lines = d.newFailures.map((f) => `- ${f.file}::${f.name}${f.payload ? `\n${String(f.payload).slice(0, 600)}` : ''}`);
      report.push(`${b.gate}: ${d.reason}\n${lines.join('\n') || tail(br.text, 2000)}`);
    } });
    cleanTree(BASE_WT);
  }
  return report.length ? R.redactSecrets(report.join('\n\n'), process.env) : null;
}

// main's land-preflight.mjs judges the tree, but loads and runs the tree's own collector, audit and
// workflow checks, so it runs in the sandbox (BRO-5649). The runner fetches; the sandbox writes the
// rebase preview's objects to its own object dir, reading the repo's through alternates. A preflight
// that cannot run blocks: it never counts as a pass.
async function landPreflight(ref) {
  requireSandbox();
  try { git(['-c', 'gc.auto=0', 'fetch', '-q', 'origin', 'main']); } catch (e) { log(`land preflight: fetch failed (${e.message.split('\n')[0]}); using cached main`); }
  const objects = git(['rev-parse', '--path-format=absolute', '--git-common-dir']) + '/objects';
  const { value, out } = judgeLandSandboxed(SB, { preflight: path.join(ROOT, 'scripts/lib/land-preflight.mjs'), cwd: WT, target: `refs/heads/${ref}`, objects });
  if (value && ['allow', 'block', 'skip'].includes(value.decision)) return value;
  return { decision: 'block', message: `the land preflight could not run in the test sandbox: ${R.redactSecrets(tail(out, 800), process.env)}` };
}

function waitForLand(ref) {
  // Never past the hard stop: an unfinished landing stays In Progress for the resume path.
  const minutes = R.landWaitMinutes({ hardEndMs: HARD_END_MS, wrapUpMs: WRAP_UP_MS, nowMs: Date.now() });
  if (minutes < 1) return Promise.resolve({ code: 2, out: 'not waited for: the run reached its hard stop' });
  return new Promise((resolve) => {
    const p = spawn('node', ['scripts/lib/wait-for-land.js', ref, String(minutes)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function moveCard(id, state, comment) {
  if (OPTS.dryRun) { log(`dry-run: ${id} -> ${state}`); return { code: 0, out: '' }; }
  const r = await linearBrain(['update', id, '--state', state, '--comment', comment]);
  log(`${id} -> ${state}: exit ${r.code}`);
  return r;
}

/** The card's runner commit is on origin/main (a landing that outlived wait-for-land). */
// ROOT, not WT: recoverOrphans runs before setupWorktree, and in a fresh container the runner
// worktree does not exist yet, so a WT git call threw and read as "not on main" (BRO-5287:
// BRO-4233's landed fix was handed back as "nothing reached main" on 2026-10-14).
// onError: what an unreadable main reads as (recoverOrphans passes null: unknown is not "not landed").
function landedOnMain(id, sinceMs, { onError = false } = {}) {
  try {
    git(['fetch', 'origin', 'main'], ROOT);
    const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : '4.days';
    return git(['log', 'origin/main', `--since=${since}`, '--author=Codex runner', '--format=%H', '-F', `--grep=fix(${id}):`], ROOT) !== '';
  } catch { return onError; }
}

/**
 * The one place a landed runner commit settles its card: Done through the Done gate (In
 * Review if refused), or, for a partial fix (PARTIAL_MARKER on the card since the claim),
 * back to Todo for the Claude worker with what is left. -> true when the card was moved.
 */
/** Runs the runner-side apply of the card's landed data-fix plans (codex-data-fixes.js); never throws. */
async function applyLandedPlans(id, opts = {}) {
  const io = {
    git: (args) => git(args, ROOT),
    log,
    dispatch: (args) => new Promise((resolve) => {
      const p = spawn('node', ['scripts/cloud-dispatch.js', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
      p.on('close', (code) => resolve({ code: code == null ? -1 : code, out: R.redactSecrets(out, process.env) }));
    }),
  };
  try { return await DF.applyCardFixPlans(id, io, opts); } catch (e) { return { kind: 'failed', why: `could not check or apply the plan: ${String(e.message).split('\n')[0]}`, lines: [] }; }
}

// Starts with the heading reconcileLanded looks for, so a deferred apply is retried by a dispatch-capable runner.
const DEFER_HEADING = '## Codex runner: landing did not finish (data-fix apply deferred)';

async function settleLanded(id, stats, { partial, remaining = [], body, countRefusal = false }) {
  // BRO-6175: a data-fix plan this card landed is applied before the card closes. Every path that settles a
  // landing comes through here, so a recovered or reconciled landing cannot reach Done unapplied.
  // With the kill switch on, a pending plan still bounces the card (never Done unapplied), it is just not dispatched.
  if (!OPTS.dryRun) {
    const ap = await applyLandedPlans(id, { dispatch: DF.dataFixesEnabled(), canDispatch: DF.canDispatchWorkflows(), applyWaitMin: R.landWaitMinutes({ hardEndMs: HARD_END_MS, wrapUpMs: WRAP_UP_MS, nowMs: Date.now() }) });
    if (ap.kind === 'deferred') {
      // Not a failure and not a bounce (a bounce would hide the card from the GHA lane for 14 days): the card stays
      // In Progress with its landing on main, and a runner that can dispatch applies it on its next reconcile.
      log(`${id}: data-fix apply deferred: ${ap.why}`);
      // reconcileLanded picks a card up only when the runner's newest note says the landing did not finish, so leave
      // that note (once: a runner that cannot dispatch re-reads the same card every run).
      const notes = ((await linear.listIssueComments([id]).catch(() => new Map())).get(id) || []).filter((c) => String(c.body || '').startsWith('## Codex runner'));
      if (!notes.length || !notes[0].body.startsWith(DEFER_HEADING)) await linearBrain(['update', id, '--comment', `${DEFER_HEADING}\n\n${ap.why}\n\nThe plan is on main and the card stays In Progress; a runner that can dispatch workflows applies it and closes the card.`]);
      return false;
    }
    if (ap.kind === 'failed') {
      stats.bounced.push(id);
      const r = await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: landed, but the data-fix plan was not applied\n${R.bounceClassLine('genuine-failure')}\n\n${ap.why}\n\n${fence(tail(ap.lines.join('\n'), 800))}\n\nThe plan file is on main. Fix the plan (a stale oldValue, a refused action) or apply it by hand per .claude/CLOUD.md "Fixing private data from cloud".\n\n${body}`);
      return r.code === 0;
    }
    if (ap.kind === 'applied') body = `${body}\n\n### Data-fix plan applied\n${ap.lines.map((l) => `- ${l}`).join('\n')}\n\nAny item above that asks to approve or apply this plan is already done; only the other items remain.`;
  }
  if (partial) {
    const left = remaining.length ? `Still open on this card:\n${remaining.map((x) => `- ${x}`).join('\n')}\n\n` : 'Some card items are still open (see the runner\'s "landing a partial fix" note).\n\n';
    const r = await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n${R.PARTIAL_HEADING}\n\n${left}${body}\n\n${R.PARTIAL_MARKER}`);
    if (r.code === 0) stats.landedPartial.push(id);
    return r.code === 0;
  }
  const done = await moveCard(id, 'Done', `## Codex runner: landed\n\n${body}`);
  if (done.code === 0) { stats.landed.push(id); return true; }
  if (done.code !== 5) return false;
  // Only a card this run worked stops the run; a leftover from an earlier run just goes to review.
  if (countRefusal) stats.doneRefusals += 1;
  stats.inReview.push(id);
  const rev = await moveCard(id, 'In Review', `## Codex runner: landed, but the Done gate refused\n\n${fence(tail(done.out, 1200))}\n\n${body}`);
  return rev.code === 0;
}

/** Comments + startedAt of a card, to tell whether its pending landing is partial. */
async function partialLanding(id, startedAtMs) {
  let sinceMs = startedAtMs;
  if (!Number.isFinite(sinceMs)) {
    try { const i = (await linear.graphql('query($id: String!) { issue(id: $id) { startedAt } }', { id })).issue; sinceMs = i && i.startedAt ? Date.parse(i.startedAt) : NaN; } catch { /* unknown */ }
  }
  const comments = (await linear.listIssueComments([id]).catch(() => new Map())).get(id) || [];
  return R.landingIsPartial(comments, sinceMs);
}

async function finishLanding(entry, stats) {
  const res = await waitForLand(entry.ref);
  const { card, summary } = entry;
  const partial = entry.remaining.length > 0;
  if (res.code === 0 || landedOnMain(card.identifier, entry.claimedMs)) {
    return settleLanded(card.identifier, stats, { partial, remaining: entry.remaining, body: `${summary}\n\nLanded via \`${entry.ref}\`.`, countRefusal: true });
  }
  stats.landFailed.push(card.identifier);
  // Left In Progress on purpose: the Claude cloud worker resumes refused land/ refs, and
  // main() re-checks main for these before it exits.
  if (!OPTS.dryRun) await linearBrain(['update', card.identifier, '--comment', `## Codex runner: landing did not finish (wait-for-land exit ${res.code})\n\nThe land ref \`${entry.ref}\` is left for the cloud worker's resume step.\n\n${fence(tail(res.out, 1200))}${partial ? `\n\n${R.PARTIAL_MARKER}` : ''}`]);
  return true;
}

/**
 * A failure the full disk caused is the machine's, not Codex's: throw, so the card goes back
 * unmarked as a runner error instead of a REJECT bounce (BRO-5384: 11 of 30 rejections were
 * ENOSPC test failures). Returns text unchanged otherwise.
 */
function throwIfDisk(text, where) {
  if (text && R.isDiskFailure(text, freeDisk())) throw new Error(`No space left on device during ${where}: ${tail(String(text), 300)}`);
  return text;
}

async function pickCards() {
  if (OPTS.ids) return OPTS.ids.map((identifier) => ({ identifier }));
  // --list --codex: the picker drops cards unfit for Codex and puts the best-suited first (BRO-5287).
  // A slot gets the launch's whole list (--pick-list): the slots share it and skip each other's cards.
  const r = sh('node', ['scripts/cloud-worker-pick.js', `--list=${OPTS.pickList || OPTS.limit + 5}`, '--codex'], { timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new Error(`picker failed: ${tail(r.out, 400)}`);
  return JSON.parse(r.stdout).picks || [];
}

const PICK_TIER = { p0p1: 'p0p1', 'p2-fallback': 'p2', 'p3-fallback': 'p3' };
/** Why a picked card is no longer the picker's to give out (recent activity, a recent pause), or null. */
async function pickedCardNowUnfit(id, card, comments, tier) {
  const P = require(path.join(ROOT, 'scripts/lib/cloud-worker-pick.js'));
  let times = null;
  try { times = (await linear.graphql('query($id: String!) { issue(id: $id) { updatedAt createdAt } }', { id })).issue; } catch { return 'updatedAt unreadable'; }
  const nowMs = Date.now();
  return P.skipReason({ ...card, ...times }, nowMs, { tier: PICK_TIER[tier] || 'p0p1', codex: true }) || P.historySkipReason(card, comments, nowMs);
}

async function workCard(pick, stats, inFlight) {
  const id = pick.identifier;
  const card = await linear.getIssue(id);
  if (!card) { log(`${id}: not found`); return 'skip'; }
  const stateType = card.state && card.state.type;
  if (!['unstarted', 'backlog', 'triage'].includes(stateType)) { log(`${id}: state ${card.state && card.state.name}, skipped`); return 'skip'; }
  // Comments carry acceptance corrections and the bounce marker; never work a card blind to them.
  let comments;
  try { comments = (await linear.listIssueComments([id])).get(id) || []; } catch (e) { log(`${id}: comments unreadable (${e && e.message ? e.message.split('\n')[0] : e}), skipped`); return 'skip'; }
  if (R.codexBouncedRecently(comments, Date.now())) { log(`${id}: Codex bounced it recently, skipped`); return 'skip'; }
  // The pick list is up to --max-minutes old by now: re-ask the picker's own rules on the card as
  // it is now, so a card a Claude worker touched or paused since then is left alone (BRO-5287:
  // BRO-3634 was paused by a Claude session at 17:09 and claimed by this runner at 17:52).
  if (pick.tier) {
    const why = await pickedCardNowUnfit(id, card, comments, pick.tier);
    if (why) { log(`${id}: no longer pickable (${why}), skipped`); return 'skip'; }
  }
  // The trust ladder as it is now (BRO-6303): a rung relocked since the pick, or an --ids card it rules out.
  const ladderWhy = R.ladderSkip({ title: card.title, description: card.description, verify: verifyCommand(card) || '', comments, nowMs: Date.now() });
  if (ladderWhy) { log(`${id}: the trust ladder rules it out now (${ladderWhy}), skipped`); return 'skip'; }
  const body = R.cardBody(card.description, comments);
  // A SHIP-WITH-FIXES round an earlier run had no time for: resume it (BRO-5384).
  const carry = R.parseSwfCarry(comments, Date.now());
  if (OPTS.dryRun) { log(`dry-run: would work ${id} "${card.title}" (${body.length} chars with comments${carry ? ', resuming a carried fix round' : ''})`); return 'skip'; }
  if (!takeCardInRun(id)) { log(`${id}: another slot of this launch has it, skipped`); return 'skip'; }
  // Across lanes (BRO-5730): name the card in our lock first, then read every other slot's lock.
  // Two runners that both stamp before they read cannot both miss each other; both may back off.
  openCards.add(id);
  if (!lockStamped()) { dropOpenCard(id); log(`${id}: could not name it in the run lock first, skipped`); return 'skip'; }
  const rival = otherLockCards();
  // Unreadable rival locks: skip rather than claim blind (the claim's started check is read-then-write).
  if (!rival || rival.has(id)) { dropOpenCard(id); log(`${id}: ${rival ? "another Codex lane's run lock names it" : 'other lanes\' run locks could not be read'}, skipped`); return 'skip'; }

  const claimedMs = Date.now();
  const claim = sh('node', ['scripts/linear-session.js', 'claim', `--issue=${id}`, '--worker-model=codex'], { timeoutMs: 900_000 });
  const claimJson = (claim.stdout.split('\n').reverse().find((l) => l.startsWith('{')) || '{}');
  let action = null; try { action = JSON.parse(claimJson).action; } catch { /* unparseable claim output */ }
  if (claim.code !== 0 || !action || action === 'noop') { dropOpenCard(id); log(`${id}: claim ${action || 'failed'}, skipped`); return 'skip'; }
  stats.claimed.push(id);
  current = id;
  openCards.add(id);

  // disposed: this card's outcome is handled (no generic hand-back in finally).
  // handedBack: its Linear move really succeeded, so it can leave the lock.
  let disposed = false;
  let handedBack = false;
  let crashReason = '';
  try {
    lockPhase = 'prepare-card';
    // Record the claim in the lock, so a run that dies from here on leaves this card named.
    if (!refreshLock(MAX_STAMP_GAP_MS)) throw new Error('lost the run lock (another run took it, or it could not be re-stamped before going stale)');
    const branch = `codex/${id.toLowerCase()}`;
    const data = resetWorktree(branch);
    const cmd = verifyCommand(card);
    let onMain = 'The card has no automatic check command.';
    if (cmd) {
      const v = makeVerifyCmdEvidence({ timeoutMs: 600_000 })(cmd);
      onMain = `\`${cmd}\` on fresh main: ${v.allowed ? 'PASSES already (the card may be fixed; confirm before changing code)' : `does not pass (${v.verdict}): ${String(v.reason).slice(0, 600)}`}`;
    }
    const tpl = fs.readFileSync(path.join(ROOT, 'scripts/codex/runner-prompt.md'), 'utf8').replace('{{DATA_FIX_RULE}}', DF.dataFixesEnabled() && DF.canDispatchWorkflows() ? DATA_FIX_RULE : '');
    const prompt = (extra) => R.fillPrompt(tpl, { id, title: card.title, body, extra, data: data.lines.join('\n') });
    // A fix-round exec starts only while 15 min of exec plus the review after it still fit the
    // card budget. The land checks and review after the last exec still run, so
    // a card can overrun the budget by those (bounded by their own timeouts).
    const cardDeadline = Math.min(claimedMs + OPTS.cardMaxMinutes * 60_000, HARD_END_MS - WRAP_UP_MS);
    // The current round's deadline: the card budget, or for the first SHIP-WITH-FIXES round and a REJECT
    // round the rest of the run (R.fixRoundDeadline, BRO-5384, BRO-6260).
    let roundDeadline = cardDeadline;
    // A fix round's exec gets what is left after the review (down to 15 min), not a fixed 45:
    // reserving a whole 45-min exec + 30-min review never fit the routine's 60-min card budget,
    // so no card ever got a second attempt (BRO-5287).
    const { REVIEW_RESERVE_MS, FIX_EXEC_MIN_MS: MIN_FIX_EXEC_MS } = R;
    const execFits = (deadline = roundDeadline) => R.fixRoundFits({ deadlineMs: deadline, nowMs: Date.now(), hardEndMs: HARD_END_MS, wrapUpMs: WRAP_UP_MS, landChecksMs });
    const runExecMs = () => R.execBudgetMs({ untilMs: HARD_END_MS - WRAP_UP_MS, nowMs: Date.now(), capMs: CODEX_TIMEOUT_MS, landChecksMs });
    const firstExecMs = runExecMs;
    // Every exec is followed by the land checks and the review, so it also leaves those before the hard stop.
    const fixExecMs = () => Math.min(runExecMs(), Math.max(MIN_FIX_EXEC_MS, roundDeadline - Date.now() - REVIEW_RESERVE_MS));
    let report = '';
    let check = null;
    let attempt = 1;
    let execs = 0;
    let step = null;
    let abort = null;
    let envRetryUsed = false;
    let envBlocked = null;
    let extra = onMain;
    // swfRoundUsed: the one SHIP-WITH-FIXES round past the card budget is spent. carryOver: it did
    // not fit this run, so the card goes back with Codex's change for the next run.
    let swfRoundUsed = false;
    let carryOver = false;
    if (carry) {
      // Re-apply the carried change and go straight to its fix round (it is that round).
      swfRoundUsed = true;
      attempt = carry.attempt + 1;
      const applied = carry.patch ? sh('git', ['apply', '--index', '--whitespace=nowarn', '-'], { cwd: WT, input: carry.patch }) : { code: 1, out: 'no change carried' };
      const committed = applied.code === 0 && !commitAttempt(card, carry.attempt).blocked;
      if (!committed) { git(['reset', '-q', '--hard', cardBase]); git(['clean', '-qfd', '-e', 'node_modules']); provideData(WT); }
      log(`${id}: resuming a carried SHIP-WITH-FIXES round (attempt ${attempt}; change ${committed ? 're-applied' : `not re-applied: ${tail(applied.out.trim(), 200)}`})`);
      const where = committed ? 'An earlier run\'s attempt at this card is committed on this branch.'
        : carry.patch ? 'An earlier run\'s attempt at this card no longer applies to main, so redo it on this branch.'
          : 'An earlier run\'s attempt at this card was too large to carry over, so redo it on this branch.';
      extra = `${onMain}\n\n${where} The independent reviewer judged it SHIP-WITH-FIXES (the approach is right, specific fixes are needed). Fix every blocking issue below (or, if a finding is wrong, show the evidence in your report):\n${fence(carry.findings || 'See the newest card comment ("fix round carried to the next run").')}`;
    }
    // Set when the hard stop leaves no room for the land checks or the review: the work is
    // unjudged, so the card goes back without the bounce marker and outside the REJECT streak.
    let outOfTime = null;
    // One Codex exec, retried (from the same commit) when it failed for a provider reason such as
    // "Selected model is at capacity" (BRO-5287, 2026-10-13 06:55), at most twice, while it fits.
    // A provider error fails within seconds, so a retry needs only the time left, not a whole exec.
    const exec = async (text, timeoutMs = fixExecMs()) => {
      const base = git(['rev-parse', 'HEAD']);
      for (let retry = 0; ; retry++) {
        keepLock(MAX_STAMP_GAP_MS, 'codex');
        const cx = runCodex(id, text, `codex${++execs}`, retry ? Math.min(timeoutMs, fixExecMs()) : timeoutMs);
        const transient = cx.code !== 0 ? R.codexExitTransient(cx.out) : null;
        if (!transient || retry >= 2 || roundDeadline - Date.now() < 15 * 60_000) return cx;
        log(`${id}: Codex exited ${cx.code} on a provider error (${transient}); retry ${retry + 1} in 4 min`);
        git(['reset', '-q', '--hard', base]);
        git(['clean', '-qfd', '-e', 'node_modules']);
        provideData(WT);
        await sleep(4 * 60_000); // async, so a SIGTERM can still hand the card back meanwhile
      }
    };
    const failed = (cx) => `Codex exited ${cx.code}: ${tail(R.stripHookNoise(R.redactSecrets(R.codexExitTransient(cx.out) ? cx.out : cx.report, process.env)).trim(), 400)}`;
    for (;;) {
      // The first exec gets the full timeout unless the hard stop is near; fix rounds fit the card budget.
      const cx = await exec(prompt(extra), execs === 0 ? firstExecMs() : fixExecMs());
      report = cx.report;
      // A failed exec (quota, login, crash) is not a fix attempt: hand back unmarked and stop the run.
      if (cx.code !== 0) { abort = failed(cx); break; }
      let c = commitAttempt(card, attempt);
      if (c.blocked) { check = { verdict: 'REJECT', text: `Blocked before review: ${c.blocked}.` }; step = 'bounce'; break; }
      // Land refuses new unit/audit failures half an hour after the push, when the worktree has
      // moved on; catch them here and hand them straight back to Codex in the same attempt.
      if (c.hasDiff && !fitsBeforeHardStop(landChecksMs + REVIEW_RESERVE_MS)) { outOfTime = 'the land checks and the review'; break; }
      keepLock(MAX_STAMP_GAP_MS, 'land-checks');
      let landFails;
      try { landFails = c.hasDiff ? throwIfDisk(newLandFailures(), 'the land checks') : null; } catch (e) { if (e instanceof LandWaitTimeout) { outOfTime = 'the land checks'; break; } throw e; }
      if (landFails && execFits()) {
        log(`${id}: attempt ${attempt} land checks red, back to Codex`);
        const fx = await exec(prompt(`${onMain}\n\nYour change is committed on this branch, but the checks land runs found failures it adds over fresh main. Fix them (or, if one is not caused by your change, show the evidence in your report), then report as before:\n${fence(landFails)}${check ? `\n\nThe reviewer's earlier findings still apply:\n${fence(check.text)}` : ''}`));
        if (fx.code !== 0) { abort = failed(fx); break; }
        report = `${report}\n\n--- after fixing the land-check failures ---\n${fx.report}`;
        c = commitAttempt(card, attempt);
        if (c.blocked) { check = { verdict: 'REJECT', text: `Blocked before review: ${c.blocked}.` }; step = 'bounce'; break; }
        keepLock(MAX_STAMP_GAP_MS, 'land-checks');
        try { landFails = throwIfDisk(newLandFailures(), 'the land checks'); } catch (e) { if (e instanceof LandWaitTimeout) { outOfTime = 'the land checks'; break; } throw e; }
      }
      envBlocked = null;
      if (landFails) {
        check = { verdict: 'REJECT', text: `The checks land runs (node unit batch, scripts/lib tests, lint-workflows audits) have new failures on this branch that fresh main does not have:\n${landFails}` };
        log(`${id}: attempt ${attempt} land checks red`);
        step = R.nextStep({ verdict: 'REJECT', hasDiff: true, attempt });
      } else if (!fitsBeforeHardStop(REVIEW_RESERVE_MS)) {
        // A review the hard stop would kill mid-way lands nothing and strands the card.
        outOfTime = 'the review';
        break;
      } else {
        keepLock(MAX_STAMP_GAP_MS, 'review');
        check = runCheck(card, body, report, `check${execs}`, data);
        if (check.verdict !== 'SHIP') throwIfDisk(check.text, 'the Claude check');
        log(`${id}: attempt ${attempt} verdict ${check.verdict}${c.hasDiff ? '' : ' (no diff)'}`);
        // No verdict means the reviewer is broken (auth, crash), not that the work is bad.
        if (check.verdict === 'NONE') { abort = `the Claude check gave no verdict: ${tail(R.redactSecrets(check.text, process.env), 400)}`; break; }
        envBlocked = c.hasDiff ? null : R.parseEnvBlocked(report);
        step = R.nextStep({ verdict: check.verdict, hasDiff: c.hasDiff, attempt, envBlocked: !!envBlocked, envRetryUsed });
      }
      if (step !== 'fix-round' && step !== 'env-retry') break;
      const deadline = step === 'fix-round'
        ? R.fixRoundDeadline({ verdict: check.verdict, swfRoundUsed, cardDeadlineMs: cardDeadline, runEndMs: HARD_END_MS - WRAP_UP_MS, rejectRunEnd: process.env.CODEX_REJECT_RUN_END !== '0' })
        : roundDeadline;
      const swfRound = step === 'fix-round' && check.verdict === 'SHIP-WITH-FIXES' && !swfRoundUsed;
      if (!execFits(deadline)) {
        // A SHIP-WITH-FIXES verdict always gets its fix round: in the next run if not in this one.
        if (swfRound) { carryOver = true; break; }
        step = 'bounce'; check.text += check.verdict === 'REJECT' && process.env.CODEX_REJECT_RUN_END !== '0' ? '\n\n(The run had no time left for another round.)' : `\n\n(The runner's ${OPTS.cardMaxMinutes}-minute card budget ran out before another round.)`; break;
      }
      roundDeadline = deadline;
      if (swfRound) swfRoundUsed = true;
      if (step === 'env-retry') {
        // Not a fix round: the environment, not the work, failed. Same attempt number, once per card.
        envRetryUsed = true;
        log(`${id}: attempt ${attempt} blocked by the environment (${envBlocked}), retrying once`);
        extra = `${onMain}\n\nYour last run made no change and reported that the environment blocked it: ${envBlocked}\nThe independent reviewer's notes on that run:\n${fence(check.text)}\nTry again with that in mind (the data paths above are real). If the block is real and unavoidable, report it the same way.`;
        continue;
      }
      attempt += 1;
      extra = `${onMain}\n\nYour previous attempt is committed on this branch. It did not pass the checks (land's test batches, or the independent reviewer). Fix every blocking issue below (or, if a finding is wrong, show the evidence in your report):\n${fence(check.text)}`;
    }
    if (carryOver) {
      // Not a bounce (no BOUNCED_MARKER, outside the REJECT streak): the next run resumes it first.
      log(`${id}: SHIP-WITH-FIXES with no time left for the fix round; carried to the next run`);
      stats.carried.push(id);
      const patch = R.carryPatch(WT, cardBase);
      const summary = `### Independent check (SHIP-WITH-FIXES)\n${fence(tail(check.text, 2500))}\n\n### Codex report\n${fence(tail(report, 1500))}`;
      handedBack = (await moveCard(id, 'Todo', R.swfCarryBody({ attempt, patch, summary }))).code === 0;
      disposed = true;
      return 'done';
    }
    if (outOfTime) {
      log(`${id}: no time left before the hard stop for ${outOfTime}; handed back unjudged`);
      stats.outOfTime.push(id);
      handedBack = (await moveCard(id, 'Todo', `## Codex runner: out of time before ${outOfTime}\n\nThe run reached its ${OPTS.hardStopMinutes}-min hard stop before ${outOfTime} could run, so Codex's change was not judged and nothing was landed. The card is free for any worker, Codex included.`)).code === 0;
      disposed = true;
      return 'done';
    }
    if (abort) {
      stats.aborted = abort;
      stats.crashed.push(id);
      handedBack = (await moveCard(id, 'Todo', `## Codex runner: stopped before finishing this card\n\n${abort}\n\nNothing was landed. The run stopped; the card is free for any worker.`)).code === 0;
      disposed = true;
      return 'done';
    }
    // An environment block is not Codex's miss, so it does not feed the REJECT streak.
    stats.rejectStreak = check.verdict === 'REJECT' && !envBlocked ? stats.rejectStreak + 1 : 0;
    let summary = `### Codex report\n${fence(tail(report, 2500))}\n\n### Independent check (${check.verdict})\n${fence(tail(check.text, 2000))}`;
    // Card items the reviewer found correctly left undone (SHIP with REMAINING lines).
    const remaining = step === 'land' || step === 'close-already-fixed' ? R.parseRemaining(check.text) : [];
    if (step === 'close-already-fixed' && remaining.length) step = 'bounce'; // nothing to land, items still open
    let landBlocked = false;

    if (step === 'land') {
      if (!OPTS.land) { stats.wouldLand.push(id); handedBack = (await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: passed the check, not landed (--no-land run)\n\n${summary}`)).code === 0; disposed = true; return 'done'; }
      const ref = `land/codex-${id.toLowerCase()}`;
      const pre = await landPreflight(ref);
      if (pre.decision === 'block') { step = 'bounce'; landBlocked = true; check.text = `Land preflight blocked it: ${pre.message}`; } else {
        while (inFlight.length >= MAX_IN_FLIGHT) await inFlight.shift().promise;
        // A partial fix is recorded on the card BEFORE the push, so every path that later settles
        // this landing (finishLanding, reconcileLanded, recoverOrphans) sends it back to Todo, not
        // Done. No record, no push.
        if (remaining.length) {
          const note = await linearBrain(['update', id, '--comment', `## Codex runner: landing a partial fix\n\nThe independent check passed this change, but these card items stay open:\n${remaining.map((x) => `- ${x}`).join('\n')}\n\n${R.PARTIAL_MARKER}`]);
          if (!note || note.code !== 0) throw new Error('could not record the partial-fix note on the card, so the landing was not pushed');
        }
        // land/codex-* refs belong to the runner; a re-worked card's earlier ref (refused or
        // stale) must not block the new attempt. The claim keeps one runner per card.
        const sha = git(['rev-parse', 'HEAD']);
        try {
          // --no-verify: the session's pre-push hook (scripts/hooks/pre-push: repo audits, tsc on
          // whatever this checkout holds) is not this change's gate; land.yml runs those checks
          // on the merged tree, after the land batches above and the Claude check. With the hook,
          // a red audit unrelated to the change failed the push 4 times and crashed the card
          // after it had passed review (BRO-4530, 2026-10-14 05:37 -> 05:41; BRO-5287).
          git(['push', '--no-verify', '--force', 'origin', `HEAD:refs/heads/${ref}`]);
        } catch (e) {
          // The push can land remotely while its reply is lost; only a missing ref is a failed push.
          let remote = '';
          try { remote = git(['ls-remote', 'origin', `refs/heads/${ref}`]).split(/\s/)[0]; } catch { /* treat as not pushed */ }
          if (remote !== sha) throw e;
        }
        log(`${id}: pushed ${ref}`);
        const entry = { ref, card, summary, claimedMs, remaining };
        // Unlist only once the card is settled; a failed move keeps it named for recoverOrphans.
        entry.promise = finishLanding(entry, stats).then((settled) => { if (settled) { openCards.delete(id); try { refreshLock(); } catch { /* next stamp covers it */ } } });
        inFlight.push(entry);
        disposed = true;
        return 'done';
      }
    }
    if (step === 'close-already-fixed') {
      const r = await moveCard(id, 'Done', `## Codex runner: already fixed on main, no code change\n\nThe independent check confirmed nothing was needed.\n\n${summary}`);
      if (r.code === 0) { stats.alreadyFixed.push(id); handedBack = true; disposed = true; return 'done'; }
      // Refused: the card's own check still fails, so it is not fixed after all. That is this
      // card's answer, not a sign the checks are broken: hand it back like any unfinished card.
      // Counting it as a Done refusal stopped all three slots of the 2026-10-15 12:47 launch
      // after one card (BRO-4791). A refused LANDED change still stops the launch (settleLanded).
      // No runnable check on the card at all (no VERIFY, no acceptance command): nothing says it
      // is unfixed, so a person decides (BRO-4791/5193 bounced to Todo and came back to Codex).
      if (r.code === 5 && /\bno-done-evidence\b/.test(r.out || '')) {
        const rev = await moveCard(id, 'In Review', `## Codex runner: already fixed on main, no code change\n\nThe independent check found nothing left to do, but the card has no check the Done gate can run, so it waits here for a person to close it.\n\n${summary}`);
        if (rev.code === 0) { stats.inReview.push(id); handedBack = true; disposed = true; return 'done'; }
      }
      if (r.code === 5) summary += `\n\n### Not fixed after all\nThe reviewer judged it already fixed, but the card's own check still fails on main (the Done gate refused to close it):\n${fence(tail(R.redactSecrets(r.out || '', process.env), 800))}`;
    }
    stats.bounced.push(id);
    const why = remaining.length && !landBlocked ? `Nothing needed landing, but these card items are still open:\n${remaining.map((x) => `- ${x}`).join('\n')}`
      : `${attempt} Codex attempt(s) did not pass the checks, so nothing was pushed.`;
    // BRO-6144: name why, so a card that needs the owner, the Mac, a credential or files Codex may not
    // edit (or is already fixed) is not offered to Codex again when a timer runs out. After the heading line.
    const blockedText = /^Blocked before review: /.test(check.text || '') ? check.text : null;
    const bounceClass = R.classifyBounce({ envBlocked, blocked: blockedText, remaining: [...remaining, ...R.parseRemaining(check.text)], report });
    log(`${id}: bounce class ${bounceClass}`);
    handedBack = (await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: not landed, left for the Claude worker\n${R.bounceClassLine(bounceClass)}\n\n${why} Findings for whoever takes it next:\n\n${summary}`)).code === 0;
    disposed = true;
    return 'done';
  } catch (e) {
    crashReason = e && e.message ? e.message : String(e);
    throw e;
  } finally {
    if (!disposed) {
      stats.crashed.push(id);
      // Name the error on the card: without it a crash could only be diagnosed from a run log
      // that dies with the routine's container (BRO-5287).
      const why = crashReason ? `\n\nError: ${fence(tail(R.redactSecrets(crashReason, process.env), 600))}` : '';
      // No BOUNCED_MARKER: a runner error is not Codex failing the card (see R.isCodexBounce).
      stats.crashStreak = (stats.crashStreak || 0) + 1;
      stats.lastCrash = crashReason;
      const back = await moveCard(id, 'Todo', `## Codex runner: stopped mid-card\n\nThe runner hit an error on this card and changed nothing on main. Back to Todo; the card is free for any worker, Codex included.${why}`).catch(() => ({ code: 1 }));
      handedBack = back.code === 0;
    }
    // Only once the card is really handed back: drop it from the lock. If the hand-back
    // failed it stays named, and the next run's recoverOrphans retries it.
    current = null;
    if (handedBack && !inFlight.some((e) => e.card.identifier === id)) { openCards.delete(id); try { refreshLock(); } catch { /* next stamp covers it */ } }
  }
}

// One run at a time across containers (runs share one rotating Codex login and the same
// cards). The lock is a branch whose tip commit says "locked <iso>" or "unlocked"; it is
// taken and released with --force-with-lease, so two runs cannot both win. The proxy
// refuses ref deletes, hence the "unlocked" commit. No workflow triggers on this branch.
// CODEX_RUNNER_LOCK_REF: tests only (refs/heads/codex-runner-locktest).
const LOCK_REF = process.env.CODEX_RUNNER_LOCK_REF || SLOT_NAMES.lockRef;
// Refreshed before each blocking step of a card (Codex, unit batch, check; the longest is
// Codex at 45 min) and every 30 min while landings wait, so a live run never looks stale.
// A killed run (SIGKILL skips the release) blocks the next run only until it goes stale.
// 90 min: the longest gap between stamps is one blocking step (Codex 45 min, unit batch
// 40 min), so a live run never reaches it. It was 5 h, and a routine session that ended
// mid-run (container reclaimed, no release) idled every Codex runner for 5 h on 2026-10-11.
const LOCK_STALE_MS = 90 * 60_000;
let lockSha = null;
// Every lock commit this run made (commit-tree) -> its commit time: a remote tip among them is
// still our lock, and other runs judge its age by that time, not by when the push finished.
const ownLockShas = new Map();
// Commit time of our stamp the remote holds; a lock we cannot re-stamp goes stale from here.
let lastStampOkMs = NaN;
const RUN_ID = R.runnerId();
const LOCK_GIT_MS = 120_000; // one lock push/read; the 600 s default let a hung push eat a card's budget
// Cards this run claimed and has not finished (working or waiting on a landing); written
// into every lock stamp. orphanCards: the ones a dead run left in the stale lock we took over.
const openCards = new Set();
let orphanCards = [];
let orphanLockMs = NaN;
let orphanLock = {};
let lockPhase = 'startup';
const lockStamp = () => R.lockMessage(new Date().toISOString(), [...openCards]);
function lockCommit(msg) {
  const tree = git(['rev-parse', 'origin/main^{tree}'], ROOT);
  const body = R.runnerLockBody({ run: RUN_ID, startedMs: RUN_STARTED_MS, hardEndMs: HARD_END_MS, phase: lockPhase });
  const sha = git(['-c', 'user.name=Codex runner', '-c', 'user.email=codex-runner@broadwayscorecard.com', 'commit-tree', tree, '-m', msg, '-m', body], ROOT);
  // %ct is whole seconds; flooring keeps our idea of the stamp's age never younger than theirs.
  ownLockShas.set(sha, Number(git(['log', '-1', '--format=%ct', sha], ROOT)) * 1000);
  return sha;
}
/** Remote lock sha, '' when the ref is absent, null when unreadable. */
function lockRemoteTip(ref = LOCK_REF) {
  const r = sh('git', ['ls-remote', 'origin', ref], { timeoutMs: LOCK_GIT_MS });
  return r.code === 0 ? (r.stdout.split(/\s/)[0] || '') : null;
}
/**
 * Push a stamp with a lease on `expect`. -> { state, tip }: 'pushed'; 'kept' (the push failed
 * but the remote tip is still one of our stamps, `tip`); 'unknown' (the tip stayed unreadable);
 * 'lost' (a stamp this run never made, so another run moved the lock).
 */
function lockPush(sha, expect) {
  let verdict = 'retry';
  let tip = null;
  for (let i = 0; i < 3; i++) {
    if (i) sh('sleep', [String(5 * i)]);
    // --no-verify: the lock is a parentless bookkeeping commit, not code. The repo's pre-push hook
    // (scripts/hooks/pre-push, installed in routine sessions) runs code audits on it and refused
    // every stamp while one audit was red: the real cause of the "lost the run lock" stops
    // (BRO-5287, run log 2026-10-14 01:47: "Bypass for emergencies: git push --no-verify").
    const p = sh('git', ['push', '-q', '--no-verify', `--force-with-lease=${LOCK_REF}:${expect}`, 'origin', `${sha}:${LOCK_REF}`], { timeoutMs: LOCK_GIT_MS });
    if (p.code === 0) return { state: 'pushed', tip: sha };
    tip = lockRemoteTip();
    if (tip === sha) return { state: 'pushed', tip: sha }; // the push landed but its reply was lost
    verdict = R.lockTipVerdict({ tip, ownShas: ownLockShas });
    log(`lock push ${i + 1}/3 failed (exit ${p.code}; remote tip ${tip === null ? 'unreadable' : (tip.slice(0, 8) || 'absent')} -> ${verdict}): ${tail(p.out.trim(), 300)}`);
    if (verdict === 'lost') return { state: 'lost', tip };
    if (verdict === 'ours') expect = tip; // lease on what is really there
  }
  if (verdict !== 'ours') {
    const ps = sh('curl', ['-sS', '-m', '20', `${process.env.HTTPS_PROXY || ''}/__agentproxy/status`], { timeoutMs: 30_000 });
    if (process.env.HTTPS_PROXY) log(`agent proxy status: ${tail(ps.out.trim(), 300)}`);
  }
  return { state: verdict === 'ours' ? 'kept' : 'unknown', tip };
}
/** The lock as the remote has it: { sha, subject, run, ms } ('' sha = no lock), or { error }. */
function readLock(ref = LOCK_REF) {
  const sha = lockRemoteTip(ref);
  if (sha === null) return { error: 'ls-remote failed' };
  if (!sha) return { sha: '' };
  const f = sh('git', ['fetch', '-q', 'origin', ref], { cwd: ROOT, timeoutMs: LOCK_GIT_MS }); // unbounded-fetch-ok: lock commits are parentless (commit-tree), so this is always one commit
  if (f.code !== 0) return { error: `fetching the lock timed out or failed: ${tail(f.out.trim(), 200)}` };
  // By sha, not FETCH_HEAD: another slot's fetch in ROOT can rewrite FETCH_HEAD in between.
  const meta = sh('git', ['log', '-1', '--format=%ct%n%s%n%b', sha], { cwd: ROOT });
  const [ct, subject, ...body] = meta.stdout.split('\n');
  if (meta.code !== 0 || !Number.isFinite(Number(ct)) || !Number(ct)) return { error: `cannot read the lock commit: ${tail(meta.out.trim(), 200)}` };
  return { sha, subject: subject || '', run: R.lockRun(body.join('\n')), body: body.join('\n'), ms: Number(ct) * 1000 };
}
const lockHeld = (l) => !!l.sha && l.subject.startsWith('locked') && Date.now() - l.ms < LOCK_STALE_MS;
const describeLock = (l) => (l.error ? `unreadable (${l.error})` : !l.sha ? 'free (no lock yet)'
  : `${l.subject}${l.run ? ` by ${l.run}` : ''}, ${Math.round((Date.now() - l.ms) / 60_000)} min old${lockHeld(l) ? '' : ' (free)'}`);
// The lock takeLock last read, so a stand-down note can say when the holder started.
let lastLockSeen = {};
/** -> null when taken, else why not. */
function takeLock() {
  try { git(['fetch', '-q', 'origin', 'main'], ROOT); } catch (e) { return `cannot fetch main: ${e.message}`; }
  const cur = readLock();
  lastLockSeen = cur;
  if (cur.error) return `lock unreadable: ${cur.error}`;
  // A "locked" stamp inside LOCK_STALE_MS is never taken over; "released"/"unlocked" are free.
  if (lockHeld(cur)) return `another run holds the lock (${describeLock(cur)})`;
  const stale = cur.sha ? R.lockCards(cur.subject) : [];
  // Adopted orphans stay named in our stamps until handled, so dying again does not lose them.
  for (const id of stale) openCards.add(id);
  const sha = lockCommit(lockStamp());
  const took = lockPush(sha, cur.sha);
  if (took.state !== 'pushed') {
    for (const id of stale) openCards.delete(id);
    // Our stamp may have landed unseen: free it again rather than block every runner for 90 min.
    if (took.state !== 'lost') lockPush(lockCommit('unlocked'), took.tip || sha);
    return took.state === 'lost' ? 'another run took the lock first' : `could not push the lock (${took.state}); see the log`;
  }
  lockSha = sha;
  lastStampOkMs = ownLockShas.get(sha);
  orphanCards = stale;
  orphanLockMs = cur.sha ? cur.ms : NaN;
  orphanLock = cur;
  log(`took the run lock as ${RUN_ID}${cur.sha ? ` (was: ${describeLock(cur)})` : ''}`);
  return null;
}
/**
 * Re-stamp between blocking steps; a lost lock stops this card (the finally hands it back).
 * nextBlockMs: the longest the coming step can block without a stamp (Codex's exec timeout).
 */
// Longest stretch between two stamps: a Codex exec, the login save after it (up to 15 min) and a
// provider-error retry wait (5 min); unit batches (40 min) and the check (30 min) are shorter.
const MAX_STAMP_GAP_MS = CODEX_TIMEOUT_MS + 20 * 60_000;
function keepLock(nextBlockMs = MAX_STAMP_GAP_MS, phase) {
  if (phase) lockPhase = phase;
  let held = true;
  try { held = refreshLock(nextBlockMs); } catch { /* transient: the next stamp retries */ }
  if (!held) throw new Error('lost the run lock (another run took it, or it could not be re-stamped before going stale)');
}

/** Re-stamp the lock so a long healthy run never looks stale. -> false if the lock is lost. */
function refreshLock(nextBlockMs = 0) {
  if (!lockSha) return true;
  const sha = lockCommit(lockStamp());
  const res = lockPush(sha, lockSha);
  if (res.state === 'pushed') { lockSha = sha; lastStampOkMs = ownLockShas.get(sha); return true; }
  if (res.state === 'lost') { log(`lock lost: the remote tip ${String(res.tip).slice(0, 8)} is not a stamp of this run (${RUN_ID})`); return false; }
  if (res.state === 'kept') { lockSha = res.tip; lastStampOkMs = ownLockShas.get(res.tip); }
  // Push trouble, not another run: still ours until it could go stale under us.
  const tooOld = R.lockStampTooOld({ lastStampOkMs, nowMs: Date.now(), staleMs: LOCK_STALE_MS, nextBlockMs });
  log(`lock not re-stamped (${res.state}); last good stamp ${Math.round((Date.now() - lastStampOkMs) / 60_000)} min ago -> ${tooOld ? 'stopping' : 'still held'}`);
  return !tooOld;
}
/** Stamp the lock now (openCards changed before a claim). -> false when it could not be stamped. */
// Only a stamp that reached the remote counts: a 'kept' or 'unknown' push leaves the remote on
// an older stamp that does not name the card, and the cross-lane check relies on both runners
// stamping before they read.
function lockStamped() {
  if (!lockSha) return false;
  try {
    const sha = lockCommit(lockStamp());
    const res = lockPush(sha, lockSha);
    if (res.state === 'pushed' || (res.state === 'kept' && res.tip === sha)) { lockSha = sha; lastStampOkMs = ownLockShas.get(sha); return true; }
    if (res.state === 'kept') { lockSha = res.tip; lastStampOkMs = ownLockShas.get(res.tip); }
    return false;
  } catch { return false; }
}
function dropOpenCard(id) {
  openCards.delete(id);
  try { refreshLock(); } catch { /* the next stamp drops it */ }
}
/**
 * Cards named by every other slot's run lock (R.cardsInLocks), any lane. One ls-remote and one
 * fetch for all of them. null when unreadable: the caller goes on, and the claim's own
 * started-state check still stops a second claim.
 */
function otherLockCards() {
  const refs = [...Array(MAX_SLOTS).keys()].map((k) => R.slotNames(k).lockRef).filter((r) => r !== LOCK_REF);
  const ls = sh('git', ['ls-remote', 'origin', ...refs], { timeoutMs: LOCK_GIT_MS });
  if (ls.code !== 0) return null;
  const shas = ls.stdout.split('\n').map((l) => l.split(/\s+/)[0]).filter((x) => /^[0-9a-f]{40}$/.test(x));
  if (!shas.length) return new Set();
  const present = new Set(ls.stdout.split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean));
  const f = sh('git', ['fetch', '-q', 'origin', ...refs.filter((r) => present.has(r))], { cwd: ROOT, timeoutMs: LOCK_GIT_MS }); // unbounded-fetch-ok: lock commits are parentless, one commit each
  if (f.code !== 0) return null;
  const logs = shas.map((sha) => sh('git', ['log', '-1', '--format=%s', sha], { cwd: ROOT }));
  if (logs.some((l) => l.code !== 0)) return null;
  const subjects = logs.map((l) => l.stdout.trim());
  return R.cardsInLocks(subjects, { nowMs: Date.now(), staleMs: LOCK_STALE_MS });
}
function releaseLock() {
  if (!lockSha) return;
  // Unfinished cards (landing still pending): keep the lock stamped with them, so the run
  // that takes it over once stale lands or hands them back (recoverOrphans).
  if (openCards.size) {
    try { if (lockPush(lockCommit(R.lockMessage(new Date().toISOString(), [...openCards], 'released')), lockSha).state === 'pushed') lockSha = null; } catch { /* stale stamp still names them */ }
    return;
  }
  try { if (lockPush(lockCommit('unlocked'), lockSha).state === 'pushed') lockSha = null; } catch { /* goes stale after LOCK_STALE_MS anyway */ }
}

// The card claimed right now, so a kill (routine timeout, container stop) can hand it back.
let current = null;
// A --slots launcher's slot runners: a signal to the launcher reaches each, and each hands its own card back.
const slotChildren = [];
let dying = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (dying) return; // the launcher and the process group can both deliver it
    dying = true;
    if (slotChildren.length) {
      // The launcher: stay until the slots have handed their cards back (up to 2 min), so the
      // routine does not read this run as finished while they still work.
      for (const c of slotChildren) { try { c.kill(sig); } catch { /* already gone */ } }
      log(`killed by ${sig}; waiting for ${slotChildren.length} slot(s) to hand their cards back`);
      const gone = slotChildren.map((c) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((res) => c.once('exit', res))));
      Promise.race([Promise.all(gone), sleep(120_000)]).then(() => process.exit(1));
      return;
    }
    if (current && !OPTS.dryRun) {
      const back = sh('node', ['scripts/linear-brain.js', 'update', current, '--state', 'Todo', '--comment',
        `## Codex runner: stopped (${sig}) mid-card\n\nNothing was landed for this card. Back to Todo.`], { timeoutMs: 600_000 });
      if (back.code === 0) openCards.delete(current); // else it stays named in the released lock
    }
    log(`killed by ${sig}${current ? `; ${current} returned to Todo` : ''}`);
    releaseLock();
    // A kill (routine timeout, cancel) before the summary says so too (BRO-6139).
    try { standDown('crash', `killed by ${sig} before the run summary${current ? ` (on ${current}, returned to Todo)` : ''}`); } catch { /* exit anyway */ }
    process.exit(1);
  });
}

// Slots any launch may run, over every lane; --lock-status reads every one of their locks.
const MAX_SLOTS = R.MAX_SLOTS;
const SLOT_STAGGER_MS = 2 * 60_000;

/** Fresh cloud containers do not ship the Codex CLI: install the pinned version; exit 2 if a tool is missing. */
function ensureTools({ codex = true } = {}) {
  if (codex && sh('codex', ['--version'], { timeoutMs: 60_000 }).code !== 0) {
    const inst = sh('npm', ['install', '-g', `@openai/codex@${CODEX_VERSION}`], { timeoutMs: 600_000 });
    log(`installed Codex CLI ${CODEX_VERSION}: exit ${inst.code}`);
  }
  for (const tool of codex ? ['codex', 'claude'] : ['claude']) {
    if (sh(tool, ['--version'], { timeoutMs: 60_000 }).code !== 0) throw startFailure('tools', `the ${tool} CLI is missing`);
  }
  // A cloud container can start without node_modules. Then the land checks fail ~300 tests on
  // both trees, and a slot linked before another lane installs them fails tests that copy the
  // repo to /tmp (they link <tree>/node_modules) while the base passes: REJECTs Codex did not cause.
  // Only when there is no node_modules at all: npm ci deletes it first, and another lane may be using or installing it.
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    const ci = sh('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { timeoutMs: 900_000 });
    log(`node_modules was missing, npm ci: exit ${ci.code}${ci.code ? ` ${tail(ci.out, 300)}` : ''}`);
    if (ci.code !== 0) throw startFailure('tools', `npm ci failed: ${tail(ci.out, 300)}`);
  }
}

/**
 * --slots N: start N slot runners 2 min apart (worktree creation and the first Codex exec do not
 * overlap) and wait for them. One slot when the login could expire mid-run or will not restore.
 */
async function launchSlots() {
  ensureTools(); // once, before the slots: concurrent `npm i -g` would race
  const laneMax = R.LANES[OPTS.lane].max;
  if (OPTS.slots > laneMax) { log(`--slots ${OPTS.slots} is over the ${OPTS.lane} lane's ${laneMax}; running ${laneMax}`); OPTS.slots = laneMax; }
  const restore = sh('node', ['scripts/codex/auth-store.js', 'restore'], { timeoutMs: 900_000 });
  log(restore.out.trim());
  let authText = '';
  try { authText = fs.readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf8'); } catch { /* slot 0 reports a missing login */ }
  const runMs = (Number.isFinite(HARD_END_MS) ? HARD_END_MS : RUN_STARTED_MS + OPTS.maxMinutes * 60_000) - Date.now();
  // The lane's slots (R.laneForLogin): a later lane falls back to slot 0 when the login may refresh.
  const plan = restore.code === 0 ? R.laneForLogin({ lane: OPTS.lane, slots: OPTS.slots, authText, nowMs: Date.now(), runMs }) : { lane: 'cloud', base: 0, slots: 1, why: 'the Codex login did not restore' };
  // A deliberate fallback (the login may refresh) only from a login that restored; the expiry it saw goes in the note.
  const fallback = restore.code === 0 && plan.lane !== OPTS.lane ? { CODEX_LANE_FALLBACK: plan.why || `${OPTS.lane} lane fell back to slot ${plan.base}`, CODEX_LANE_FALLBACK_EXPIRES: R.authAccessExpires(authText) } : {};
  authText = '';
  if (!plan.slots) { standDown(/login/i.test(plan.why || '') ? 'login-refresh' : 'lane', plan.why || 'no slot to run on'); return; }
  pruneDisk();
  const missingBySlot = [...Array(plan.slots).keys()].map((k) => {
    const n = R.slotNames(plan.base + k);
    return [n.wt, n.base].filter((w) => !fs.existsSync(path.join(ROOT, '.claude/worktrees', w, '.git'))).length;
  });
  const disk = R.slotsForDisk({ slots: plan.slots, freeBytes: freeDisk(), missingBySlot });
  if (disk.slots < plan.slots) Object.assign(plan, { slots: disk.slots, why: [plan.why, disk.why].filter(Boolean).join('; ') });
  log(`launching ${plan.slots} slot(s) from slot ${plan.base} (${plan.lane} lane)${plan.why ? ` instead of ${OPTS.slots}: ${plan.why}` : ''}`);
  // One slot: no run dir, so it runs exactly as a lone runner (2 landings in flight, plain summary).
  const runDir = plan.slots > 1 ? fs.mkdtempSync(path.join(LOG_DIR, 'launch-')) : '';
  const exits = [];
  for (let k = 0; k < plan.slots; k++) {
    if (k) await sleep(SLOT_STAGGER_MS);
    if (dying || (runDir && fs.existsSync(path.join(runDir, 'STOP')))) break;
    const args = R.slotArgs(process.argv.slice(2), { slot: plan.base + k, runDir, runStartedMs: RUN_STARTED_MS, limit: Math.ceil(OPTS.limit / plan.slots), checkBudgetUsd: OPTS.checkBudgetUsd / plan.slots, pickList: OPTS.limit + 5 * plan.slots });
    const child = spawn(process.execPath, [__filename, ...args], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...(plan.slots < OPTS.slots ? { CODEX_SLOT_SHORTFALL: `${plan.slots} of ${OPTS.slots} requested: ${plan.why || 'disk or lane limit'}` } : {}),
      // A lane that fell back to another lane's slot (the login may refresh) stands down by design if that slot is busy.
      ...fallback } });
    slotChildren.push(child);
    exits.push(new Promise((res) => child.on('exit', (code) => res(code == null ? 1 : code))));
  }
  process.exitCode = Math.max(0, ...(await Promise.all(exits)));
}

async function main() {
  const startedMs = RUN_STARTED_MS; // a slot's --max-minutes counts from the launch too
  // --lock-status: is a runner alive anywhere (any session or container)? The board-workers
  // routine and check-claude.js ask this before starting Codex; pgrep only sees its own container.
  // Every slot's lock: exit 3 if any is held, 4 if one is unreadable, else 0.
  if (process.argv.includes('--lock-status')) {
    // One ls-remote for every slot's ref, then only the refs that exist are read (check-claude.js
    // gives this 180 s; four sequential reads of up to 120 s each would not fit).
    // --lane cloud|gha|all (default all): only that lane's slots (BRO-5730), so a live GitHub lane
    // does not make the cloud routine skip its own lane.
    const slotList = R.laneSlotList(String(arg('lane', 'all')));
    if (!slotList) { console.error(`--lane must be one of ${Object.keys(R.LANES).join('|')}|all`); process.exit(2); }
    const refs = slotList.map((k) => (k === 0 && process.env.CODEX_RUNNER_LOCK_REF ? process.env.CODEX_RUNNER_LOCK_REF : R.slotNames(k).lockRef));
    const ls = sh('git', ['ls-remote', 'origin', ...refs], { timeoutMs: LOCK_GIT_MS });
    const present = new Set(ls.code === 0 ? ls.stdout.split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean) : []);
    const locks = ls.code !== 0 ? [{ error: 'ls-remote failed' }] : refs.map((ref) => (present.has(ref) ? readLock(ref) : { sha: '' }));
    locks.forEach((l, i) => { const k = slotList[i]; if (i === 0 || l.error || l.sha) console.log(`codex runner lock${k ? ` (slot ${k})` : ''}: ${describeLock(l)}`); });
    console.log(`held slots: ${slotList.filter((k, i) => locks[i] && !locks[i].error && lockHeld(locks[i])).join(',') || 'none'}`);
    process.exit(locks.some(lockHeld) ? 3 : locks.some((l) => l.error) ? 4 : 0);
  }
  if (PR_NUM) { await runPr(PR_NUM); await Promise.allSettled(prMail); return; }
  if (!R.LANES[OPTS.lane]) { log(`--lane must be one of ${Object.keys(R.LANES).join('|')}`); process.exit(2); }
  // A later lane always goes through the launcher, so even one slot runs on that lane's slot.
  if ((OPTS.slots > 1 || OPTS.lane !== 'cloud') && !process.argv.includes('--slot')) { await launchSlots(); return; }
  ensureTools();
  if (!OPTS.dryRun) {
    const held = takeLock();
    if (held) {
      // Busy because this lane fell back onto the cloud lane's slot: the deliberate login-refresh stand-down, not a fault.
      const busy = /^another run (holds|took) the lock/.test(held);
      const cls = busy ? (process.env.CODEX_LANE_FALLBACK ? 'login-refresh' : 'lock-held') : 'lane';
      // The holder's start only when we read the holder's own stamp: a run that won the race just now is not in lastLockSeen.
      standDown(cls, process.env.CODEX_LANE_FALLBACK && busy ? `${held}; ${process.env.CODEX_LANE_FALLBACK}` : held, {
        holderStartedMs: held.startsWith('another run holds the lock') ? R.lockStartedMs(lastLockSeen.body) : NaN,
        loginExpiresMs: Date.parse(process.env.CODEX_LANE_FALLBACK_EXPIRES || ''),
      });
      return;
    }
  }
  // Re-stamp while waiting on slow steps (landings, in-flight slots), so a long healthy run
  // never looks stale to the next one.
  const keepAlive = OPTS.dryRun ? null : setInterval(() => { try { refreshLock(); } catch { /* next tick */ } }, 30 * 60_000);
  try { await runLocked(startedMs); } finally { if (keepAlive) clearInterval(keepAlive); releaseLock(); }
}

/** Cards (distinct BRO ids) landed on main in the last 24h by this runner vs the Claude sessions (R.landedPerLane). */
function landedPerLane() {
  try {
    const lane = R.landedPerLane(git(['log', 'origin/main', '--since=24.hours', `--format=${R.LANDED_LOG_FORMAT}`], ROOT));
    return `Codex runner ${lane.codex} card(s), Claude sessions ${lane.claude} card(s)`;
  } catch { return 'unknown (git log failed)'; }
}

/** The trust ladder access this run started under (BRO-6303), for the summary; a mid-run change says so. */
let runLadder = null;
function ladderLine() {
  try {
    const now = R.codexLadderAccess();
    const start = runLadder || now;
    const same = ['source', 'minScore', 'cloudDataRouteLocked', 'reviewTextsLocked'].every((k) => start[k] === now[k]);
    return `${TL.accessLine(start)}${same ? '' : ` (changed mid-run, now: ${TL.accessLine(now).replace(/^- Trust ladder: /, '')})`}`;
  } catch (e) { return `- Trust ladder: unreadable (${String(e && e.message || e).slice(0, 80)})`; }
}

/** Close cards whose runner commit reached main after an earlier run stopped waiting (left In Progress). */
async function reconcileLanded(stats, { onlyDeferred = false } = {}) {
  let subjects = '';
  try { subjects = git(['log', 'origin/main', '--since=4.days', '--author=Codex runner', '--format=%s'], ROOT); } catch { return; }
  const ids = [...new Set(subjects.split('\n').map((l) => (l.match(/^fix\((BRO-\d+)\):/) || [])[1]).filter(Boolean))];
  for (const id of ids) {
    const card = await linear.getIssue(id).catch(() => null);
    if (!card || !card.state || card.state.type !== 'started') continue;
    // Only when the runner's own newest note on the card is "landing did not finish" (not a reopen).
    const notes = ((await linear.listIssueComments([id]).catch(() => new Map())).get(id) || [])
      .filter((c) => String(c.body || '').startsWith('## Codex runner'));
    if (!notes.length || !notes[0].body.startsWith('## Codex runner: landing did not finish')) continue;
    // A deferred data-fix apply is for a runner that can dispatch; a cloud slot re-reading it would only defer again.
    const deferred = notes[0].body.startsWith(DEFER_HEADING);
    if (DF.reconcileSkips({ deferred, onlyDeferred, canDispatch: DF.canReconcileDeferred() })) continue;
    await settleLanded(id, stats, { partial: await partialLanding(id, NaN), body: 'The runner\'s commit for this card is on main; an earlier run stopped waiting before the landing finished.' });
  }
}

/** Cards a dead run left claimed (named in the stale lock we took over): close, park for the land resume, or hand back. */
async function recoverOrphans(stats) {
  for (const id of orphanCards) {
    let issue = null;
    try { issue = (await linear.graphql('query($id: String!) { issue(id: $id) { startedAt state { name } } }', { id })).issue; } catch { /* unreadable: leave it named */ continue; }
    const ref = `land/codex-${id.toLowerCase()}`;
    let landRefMs = NaN;
    try {
      const refSha = git(['ls-remote', 'origin', `refs/heads/${ref}`], ROOT).split(/\s/)[0];
      if (refSha) {
        git(['fetch', '-q', 'origin', `refs/heads/${ref}`], ROOT); // unbounded-fetch-ok: one land ref
        landRefMs = Number(git(['log', '-1', '--format=%ct', refSha], ROOT)) * 1000; // by sha: slots share FETCH_HEAD
      }
    } catch { log(`${id}: could not read ${ref}; left named for the next run`); continue; } // a failed read is not "no landing": handing back could re-work a card already on Land
    const onMain = issue && issue.startedAt ? landedOnMain(id, Date.parse(issue.startedAt), { onError: null }) : false;
    if (onMain === null) { log(`${id}: could not read main; left named for the next run`); continue; }
    const action = R.orphanAction({
      stateName: issue && issue.state && issue.state.name,
      startedAtMs: issue && issue.startedAt ? Date.parse(issue.startedAt) : NaN,
      lockMs: orphanLockMs, onMain, landRefMs,
    });
    log(`${id}: named in a stopped run's lock -> ${action}`);
    let handled = true;
    const startedAtMs = issue && issue.startedAt ? Date.parse(issue.startedAt) : NaN;
    if (action === 'done') {
      handled = await settleLanded(id, stats, { partial: await partialLanding(id, startedAtMs), body: 'An earlier run stopped before closing this card; its commit is on main.' });
    } else if (action === 'park') {
      const partial = await partialLanding(id, startedAtMs);
      handled = (await linearBrain(['update', id, '--comment', `## Codex runner: landing did not finish (an earlier run stopped)\n\nThe land ref \`${ref}\` is left for the cloud worker's resume step.${partial ? `\n\n${R.PARTIAL_MARKER}` : ''}`])).code === 0;
    } else if (action === 'todo') {
      stats.crashed.push(id);
      const details = R.orphanStopDetails(orphanLock);
      stats.recoveredStops.push(`${id}: ${details}`);
      log(`${id}: ${details}`);
      handled = (await moveCard(id, 'Todo', `## Codex runner: stopped mid-card\n\nAn earlier run ended before finishing this card, and nothing reached main. Back to Todo.\n\n${details}`)).code === 0;
    }
    if (handled) openCards.delete(id);
  }
  try { refreshLock(); } catch { /* next stamp covers it */ }
}

async function runLocked(startedMs) {
  const stats = { claimed: [], landed: [], landedPartial: [], alreadyFixed: [], bounced: [], inReview: [], landFailed: [], crashed: [], recoveredStops: [], outOfTime: [], carried: [], wouldLand: [], rejectStreak: 0, doneRefusals: 0 };
  // Tidying an earlier run's cards needs only git and Linear, so it runs even without a Codex login.
  // reconcileLanded scans every runner commit on main, so one slot does it (two would settle a card twice).
  if (!OPTS.dryRun) { if (SLOT === 0) await reconcileLanded(stats); else if (SLOT === R.LANES[OPTS.lane].base) await reconcileLanded(stats, { onlyDeferred: true }); await recoverOrphans(stats); }
  const restore = sh('node', ['scripts/codex/auth-store.js', 'restore'], { timeoutMs: 900_000 });
  log(restore.out.trim());
  if (restore.code !== 0) {
    standDown('login', `No usable Codex login (it may have expired). Someone with the ChatGPT account must run \`codex login --device-auth\` in a cloud session, then \`node scripts/codex/auth-store.js save\`.\n\n${fence(tail(restore.out, 600))}`, { exitCode: 2 });
    return;
  }
  // Unusable namespace sandbox outside the cloud VM: stop before claiming any card (BRO-5856).
  try { codexSandboxMode(); } catch (e) {
    standDown('sandbox', `${e.message}. No card was claimed, so the Claude lane keeps them.`, { exitCode: 2 });
    return;
  }
  const install = sh('node', ['scripts/codex/install.js']);
  if (install.code !== 0) log(`codex install warning: ${tail(install.out, 300)}`);
  pruneDisk();
  setupWorktree();

  const inFlight = [];
  let worked = 0;
  let stop = null;
  let picks;
  runLadder = R.codexLadderAccess(); // what this run starts under, for the summary (BRO-6303)
  try { picks = await pickCards(); } catch (e) { throw startFailure('picker', e.message, 1); }
  let skipped = 0;
  for (const pick of picks) {
    if (worked >= OPTS.limit) break;
    let freeDiskBytes = freeDisk();
    if (freeDiskBytes != null && freeDiskBytes < R.MIN_FREE_DISK_BYTES) { pruneDisk(); freeDiskBytes = freeDisk(); }
    const diskLow = freeDiskBytes != null && freeDiskBytes < R.MIN_FREE_DISK_BYTES;
    stop = R.stopReason({ startedMs, nowMs: Date.now(), maxMinutes: OPTS.maxMinutes, weeklyPct: weeklyPct(), maxWeeklyPct: OPTS.maxWeeklyPct, rejectStreak: stats.rejectStreak, doneRefusals: stats.doneRefusals, checkSpentUsd, checkBudgetUsd: OPTS.checkBudgetUsd, crashStreak: stats.crashStreak, lastCrash: stats.lastCrash, freeDiskBytes });
    if (!stop && stats.aborted) stop = stats.aborted;
    // Launch-wide: a broken reviewer/gate, or a full disk (the slots share it). Two runner errors
    // in a row stop only this slot: they can be this slot's cards.
    if (stop && (stats.aborted || stats.doneRefusals || diskLow)) stopAllSlots(stop);
    if (!stop) { const other = runStop(); if (other) stop = `another slot stopped this launch (${other})`; }
    if (!stop && !fitsBeforeHardStop(R.cardStartMs(landChecksMs, { laterCard: worked > 0 }))) stop = `under ${Math.round((R.cardStartMs(landChecksMs, { laterCard: worked > 0 }) + WRAP_UP_MS) / 60_000)} min left before the ${OPTS.hardStopMinutes}-min hard stop (a card's exec, land checks and review would not fit)`;
    let held = true;
    try { held = refreshLock(MAX_STAMP_GAP_MS); } catch { /* transient git error: the keep-alive retries */ }
    if (!stop && !OPTS.dryRun && !held) stop = 'lost the run lock (see the run log: another run took it, or it could not be re-stamped)';
    if (stop) { log(`stopping: ${stop}`); break; }
    try {
      const crashedBefore = stats.crashed.length;
      const outcome = await workCard(pick, stats, inFlight);
      if (outcome === 'done') worked += 1;
      else if (outcome === 'skip') skipped += 1;
      if (stats.crashed.length === crashedBefore) stats.crashStreak = 0;
    } catch (e) {
      log(`${pick.identifier}: error ${e && e.message ? e.message : e}`);
    }
  }
  await Promise.all(inFlight.map((e) => e.promise));
  if (!stop && stats.aborted) stop = stats.aborted;
  if (stats.aborted || stats.doneRefusals) stopAllSlots(stop || 'the Done gate refused a card the Claude check passed');
  else if (stats.crashStreak >= 1 && R.isDiskFailure(stats.lastCrash, freeDisk())) stopAllSlots(`out of disk: ${String(stats.lastCrash).slice(0, 160)}`);
  saveLogin();

  const mins = Math.round((Date.now() - startedMs) / 60_000);
  const text = R.runnerSummaryText({
    heading: R.summaryHeading({ date: new Date().toISOString().slice(0, 10), worked, mins, slot: SLOT, lane: OPTS.lane }),
    stats, worked, skipped, picks, stop,
    settingsLine: R.codexSettingsLine(codexUsed),
    weeklyPct: weeklyPct(),
    checkCount, checkSpentUsd, checkByModel,
    slotShortfall: process.env.CODEX_SLOT_SHORTFALL,
    landedPerLane: SLOT === 0 ? landedPerLane() : null,
    ladderLine: ladderLine(),
  });
  log(text);
  if (!OPTS.dryRun) await linearBrain(['update', RUNNER_CARD, '--comment', text]);
  summaryPosted = true; // a later crash is not a run that "did not start"
}

/**
 * --pr N (BRO-5646): one Codex cloud PR (R.codexCloudPr) through the card path's own gates:
 * squash onto fresh main, commitAttempt's guards, the land batches, the Claude check (SHIP
 * only, no fix round: Codex cloud is the owner's to re-run), land preflight, land/codex-pr-N,
 * wait for land. Every outcome is one plain-English PR comment (R.prLanderComment); a landing
 * also closes the PR and deletes its branch. One attempt per head sha unless --retry.
 */
// The owner's end-of-run email(s) for --pr, awaited before the process ends.
const prMail = [];
async function runPr(n) {
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  const gh = (args, input) => sh('gh', args, { timeoutMs: 120_000, input });
  const view = gh(['api', `repos/${repo}/pulls/${n}`]);
  if (view.code !== 0) { log(`PR #${n}: unreadable (${tail(view.out, 300)})`); process.exitCode = 1; return; }
  const pr = JSON.parse(view.stdout);
  const fit = R.codexCloudPr(pr, repo);
  const sha = pr.head && pr.head.sha;
  // One comment per run: the started comment, edited into the verdict (a new one if that failed).
  let statusId = '';
  const say = (outcome, extra = {}) => {
    const body = R.redactSecrets(R.prLanderComment({ outcome, sha, ...extra }), process.env);
    log(`PR #${n} ${String(sha).slice(0, 7)}: ${outcome}`);
    const mail = R.prLanderEmail({ outcome, title: pr.title, minutes: (Date.now() - Date.parse(pr.created_at)) / 60000, site: extra.site, why: extra.why, prUrl: pr.html_url });
    if (OPTS.dryRun) { log(body); if (mail) log(`email: ${mail.subject}\n${mail.lines.join('\n')}`); return; }
    // One per head commit and outcome: a re-run's repeat is a no-op at Resend for 24h, while a
    // different answer (e.g. a timed-out landing that a retry finds on main) still goes out.
    if (mail) {
      prMail.push(require(path.join(ROOT, 'scripts/lib/discord-notify.js')).sendEmailAlert({
        title: mail.subject, description: mail.lines.join('\n'), url: 'https://broadwayscorecard.com',
        subjectLabel: '', idempotencyKey: `codex-pr-lander:${n}:${sha}:${outcome}`,
      }).catch((e) => log(`PR #${n}: owner email failed (${e.message})`)));
    }
    const post = (id) => gh(['api', '-X', id ? 'PATCH' : 'POST', id ? `repos/${repo}/issues/comments/${id}` : `repos/${repo}/issues/${n}/comments`, '--input', '-', '--jq', '.id'], JSON.stringify({ body }));
    let c = post(statusId);
    // The started comment is gone (deleted, or the edit failed): the verdict goes in a new one.
    if (c.code !== 0 && statusId) { log(`PR #${n}: comment edit failed (${tail(c.out, 300)}); posting a new one`); statusId = ''; c = post(''); }
    if (c.code !== 0) { log(`PR #${n}: comment failed (${tail(c.out, 300)})`); return; }
    if (outcome === 'started') statusId = c.stdout.trim();
  };
  if (!fit.ok) {
    log(`PR #${n}: not landing (${fit.why})`);
    // A Codex-looking PR from an account the lander does not know: say so rather than stay silent.
    if (fit.unknownAuthor) say('unknownAuthor', { details: fit.why });
    return;
  }
  const want = arg('head-sha', '');
  if (typeof want === 'string' && want && want !== sha) { log(`PR #${n}: head moved to ${sha.slice(0, 7)} since ${want.slice(0, 7)}; the newer push's run handles it`); return; }
  const short = sha.slice(0, 7);
  if (!process.argv.includes('--retry')) {
    const seen = gh(['api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[].body']);
    // One verdict per head commit; a run that errored out did not judge it, so a reopen retries.
    if (seen.code === 0 && R.prLanderJudged(seen.stdout, short)) { log(`PR #${n}: ${short} already judged`); return; }
  }
  // Tell the PR straight away (the Codex app links here) how long a result usually takes.
  const runs = gh(['api', `repos/${repo}/actions/workflows/codex-pr-lander.yml/runs?status=completed&per_page=40`, '--jq', '.workflow_runs']);
  let minutes = null;
  try { if (runs.code === 0) minutes = R.typicalLanderMinutes(JSON.parse(runs.stdout)); } catch { /* the plain range */ }
  say('started', { minutes });
  const card = { identifier: `PR-${n}`, title: String(pr.title || `Codex PR #${n}`) };
  const ref = `land/codex-pr-${n}`;
  function landedOnMain() {
    git(['fetch', 'origin', 'main']);
    return git(['log', 'origin/main', '-n', '200', '--format=%H', '--fixed-strings', `--grep=(Codex PR #${n})`]).split('\n')[0] || '';
  }
  let site = true; // unknown (an earlier run's landing) reads as a website change
  function finishLanded(remaining) {
    say('landed', { mainSha: landedOnMain(), site, remaining });
    if (OPTS.dryRun) return;
    // Codex pushed again while this landed: leave the PR and branch to the newer push's run.
    const now = gh(['api', `repos/${repo}/pulls/${n}`]);
    let cur = null;
    try { cur = now.code === 0 ? JSON.parse(now.stdout) : null; } catch { /* unreadable reads as moved */ }
    if (!cur || !cur.head || cur.head.sha !== sha) { log(`PR #${n}: head moved during the landing; left open for the newer push`); return; }
    // A closed PR reads as a rejection in GitHub and Codex; the title (as it is now) says it landed.
    const title = gh(['api', '-X', 'PATCH', `repos/${repo}/pulls/${n}`, '-f', `title=${R.prLanderTitle(cur.title || pr.title, 'Landed')}`, '--jq', '.title']);
    if (title.code !== 0) log(`PR #${n}: title not updated (${tail(title.out, 300)})`);
    const close = gh(['pr', 'close', String(n), '--repo', repo]);
    if (close.code !== 0) log(`PR #${n}: close failed (${tail(close.out, 300)})`);
    // The codex/ branch is spent once its change is on main; the lease keeps a newer push.
    try { git(['push', '--no-verify', `--force-with-lease=refs/heads/${pr.head.ref}:${sha}`, 'origin', `:refs/heads/${pr.head.ref}`]); } catch (e) { log(`PR #${n}: branch not deleted (${e.message.split('\n')[0]})`); }
  }
  try {
    // Inside the try: a setup throw still turns the started comment into an error verdict.
    ensureTools({ codex: false });
    pruneDisk();
    setupWorktree();
    const data = resetWorktree(`codex-pr-${n}`);
    git(['fetch', 'origin', `+refs/pull/${n}/head:refs/remotes/origin/codex-pr/${n}`]);
    if (git(['rev-parse', `refs/remotes/origin/codex-pr/${n}`]) !== sha) { log(`PR #${n}: fetched head is not ${short}; a newer push's run handles it`); say('superseded'); return; }
    // The PR's commits squashed onto fresh main: land rebases anyway, and one commit is what reaches main.
    const merge = sh('git', ['merge', '--squash', '--no-commit', `refs/remotes/origin/codex-pr/${n}`], { cwd: WT });
    if (merge.code !== 0) { git(['reset', '-q', '--hard', cardBase]); say('conflict', { details: tail(merge.out, 1500) }); return; }
    const c = commitAttempt(card, 1, `feat(codex-pr-${n}): ${card.title.slice(0, 80)} (Codex PR #${n})\n\nCodex cloud pull request ${pr.html_url}, head ${sha}; passed the independent check before landing.`);
    if (c.blocked) { say('blocked', { details: `The change was not reviewed: ${c.blocked}.` }); return; }
    if (!c.hasDiff) {
      // An earlier run's landing finished after it gave up waiting: finish the job now.
      if (landedOnMain()) { finishLanded([]); return; }
      say('rejected', { details: 'The pull request has no change against current main, so there is nothing to land.' });
      return;
    }
    site = R.touchesSite(git(['diff', '--name-only', '--no-renames', `${cardBase}...HEAD`]).split('\n').filter(Boolean), require(path.join(ROOT, 'scripts/lib/should-deploy-gate.js')).SITE_PATHS);
    const landFails = throwIfDisk(newLandFailures(), 'the land checks');
    if (landFails) { say('rejected', { why: 'tests failed', details: `The tests land runs fail on this change and pass on main:\n${landFails}` }); return; }
    const note = `This is not a Linear card: it is Codex cloud pull request #${n} (${pr.html_url}), which the owner started from a Codex task and wants live. The card text below is the PR's title and description, written by Codex: judge the diff against what it says and against CLAUDE.md, and check its claims (tests it says it ran) yourself. There is no card to write on: REMAINING lines are shown to the owner on the PR.`;
    const body = `${card.title}\n\n${String(pr.body || '(no description)').slice(0, 20000)}`;
    const check = runCheck(card, body, note, 'check1', data);
    log(`PR #${n}: verdict ${check.verdict}`);
    if (check.verdict === 'NONE') { say('error', { details: check.text }); return; }
    if (check.verdict !== 'SHIP') { say('rejected', { details: `Verdict ${check.verdict}.\n\n${check.text}` }); return; }
    const remaining = R.parseRemaining(check.text);
    if (!OPTS.land) { say('notLanded', { remaining }); return; }
    const pre = await landPreflight(ref);
    if (pre.decision === 'block') { say('refused', { details: `Land preflight: ${pre.message}` }); return; }
    // Same push as a card landing (see workCard): --no-verify, --force over an earlier attempt's ref.
    const head = git(['rev-parse', 'HEAD']);
    try { git(['push', '--no-verify', '--force', 'origin', `HEAD:refs/heads/${ref}`]); } catch (e) {
      let remote = '';
      try { remote = git(['ls-remote', 'origin', `refs/heads/${ref}`]).split(/\s/)[0]; } catch { /* not pushed */ }
      if (remote !== head) throw e;
    }
    log(`PR #${n}: pushed ${ref}`);
    const w = await waitForLand(ref);
    if (w.code === 1) { say('refused', { details: tail(w.out, 2000) }); return; }
    if (w.code !== 0) { say('error', { why: 'the landing was still running when the check stopped', details: `The landing did not finish in time (it may still land; this pull request stays open):\n${tail(w.out, 1500)}` }); return; }
    finishLanded(remaining);
  } catch (e) {
    say('error', { details: e && e.message ? e.message : String(e) });
    process.exitCode = 1;
  }
}

module.exports = { newLandFailures, landPreflight, provideData, takeLock, refreshLock, readLock, releaseLock, weeklyPct, recoverOrphans, pruneClaudeWorktrees };
if (require.main === module) {
  main().catch(async (e) => {
    log(`runner failed: ${e && e.stack ? e.stack : e}`);
    // Every exit says why (BRO-6139): a crash or a missing tool posts a stand-down note too.
    try { standDown(e && e.standDownClass ? e.standDownClass : 'crash', `${e && e.standDownClass ? '' : 'runner failed: '}${e && e.message ? e.message : e}`); } catch { /* exit anyway */ }
    process.exit(e && e.exitCode ? e.exitCode : 1);
  });
}
