#!/usr/bin/env node
'use strict';
/**
 * daily-runner.js — the unattended Codex card worker (BRO-4745). A daily
 * cloud routine runs it; no Claude session supervises the work itself.
 *
 *   node scripts/codex/daily-runner.js [--limit 10] [--ids BRO-1,BRO-2]
 *        [--max-minutes 420] [--max-weekly-pct 60] [--no-land] [--dry-run]
 *
 * Per card (same picker rules as the hourly Claude cloud worker, minus
 * resumes and cards Codex already bounced):
 *   1. re-read the card; skip unless it is still unstarted, then claim it
 *      (linear-session.js claim; a noop means someone else has it)
 *   2. run the card's check on fresh main (the Done gate's own executor)
 *   3. `codex exec` (high reasoning effort, scripts/codex/runner-prompt.md,
 *      secrets kept out of its shell) in .claude/worktrees/codex-runner
 *   4. commit, then the Claude check: `claude -p --model opus` with
 *      scripts/codex/check-prompt.md. Only `VERDICT: SHIP` passes.
 *   5. not SHIP: one Codex fix round with the findings, checked again;
 *      still not SHIP: card back to Todo with the findings (BOUNCED_MARKER)
 *   6. SHIP: secret scan + land preflight, push land/codex-bro-N, at most
 *      2 landings in flight; landed -> Done through the Done gate (In Review
 *      if refused); refused -> stays In Progress for the resume path
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

const RUNNER_CARD = process.env.CODEX_RUNNER_CARD || 'BRO-4745';
const WT = path.join(ROOT, '.claude/worktrees/codex-runner');
const LOG_DIR = process.env.CODEX_RUNNER_LOG_DIR || path.join(os.tmpdir(), 'codex-runner');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const MAX_IN_FLIGHT = 2;
const CODEX_VERSION = '0.160.0';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const OPTS = {
  limit: Number(arg('limit', 10)),
  ids: arg('ids', '') ? String(arg('ids')).split(',').map((s) => s.trim()).filter(Boolean) : null,
  maxMinutes: Number(arg('max-minutes', 420)),
  maxWeeklyPct: Number(arg('max-weekly-pct', 60)),
  land: !process.argv.includes('--no-land'),
  dryRun: process.argv.includes('--dry-run'),
};

fs.mkdirSync(LOG_DIR, { recursive: true });
const RUN_LOG = path.join(LOG_DIR, `run-${new Date().toISOString().slice(0, 10)}.log`);
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(RUN_LOG, `${line}\n`);
}

function sh(cmd, args, opts = {}) {
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

/**
 * Env for the Codex and Claude-check shells: no service keys or tokens, so no
 * paid fetches, LLM rescoring or Linear writes. Claude's own session vars stay
 * (the check needs them to authenticate).
 */
function scrubbedEnv() {
  return R.scrubEnv(process.env);
}

async function linearBrain(args) {
  const r = sh('node', ['scripts/linear-brain.js', ...args], { timeoutMs: 1_200_000 });
  return r;
}

function setupWorktree() {
  if (!fs.existsSync(path.join(WT, '.git'))) {
    sh('git', ['worktree', 'prune']);
    git(['fetch', 'origin', 'main'], ROOT);
    git(['worktree', 'add', '--detach', WT, 'origin/main'], ROOT);
  }
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(WT, 'node_modules'))) fs.symlinkSync(nm, path.join(WT, 'node_modules'));
}

function resetWorktree(branch) {
  git(['fetch', 'origin', 'main']);
  git(['checkout', '-f', '-B', branch, 'origin/main']);
  git(['reset', '--hard', 'origin/main']);
  git(['clean', '-fd', '-e', 'node_modules']);
}

function weeklyPct() {
  const dir = path.join(CODEX_HOME, 'sessions');
  let newest = null;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { const m = fs.statSync(p).mtimeMs; if (!newest || m > newest.m) newest = { p, m }; }
    }
  };
  walk(dir);
  if (!newest) return null;
  try { return R.latestWeeklyPercent(fs.readFileSync(newest.p, 'utf8')); } catch { return null; }
}

function saveLogin() {
  const r = sh('node', ['scripts/codex/auth-store.js', 'save'], { timeoutMs: 900_000 });
  if (r.code !== 0) log(`login save failed: ${tail(r.out, 300)}`);
}

function runCodex(id, prompt, tag) {
  const last = path.join(LOG_DIR, `${id}-${tag}-last.md`);
  fs.writeFileSync(path.join(LOG_DIR, `${id}-${tag}-prompt.md`), prompt);
  const r = sh('codex', ['exec', '--dangerously-bypass-hook-trust', '--sandbox', 'workspace-write', '--color', 'never',
    '-c', 'model_reasoning_effort=high', '-o', last, '-C', WT, prompt],
  { cwd: WT, timeoutMs: 45 * 60_000, env: scrubbedEnv(), input: '' });
  fs.writeFileSync(path.join(LOG_DIR, `${id}-${tag}.log`), r.out);
  saveLogin(); // refresh tokens rotate: persist the newest login after every exec
  let report = '';
  try { report = fs.readFileSync(last, 'utf8'); } catch { report = tail(r.out, 4000); }
  return { code: r.code, report };
}

function runCheck(card, codexReport, tag) {
  const tpl = fs.readFileSync(path.join(ROOT, 'scripts/codex/check-prompt.md'), 'utf8');
  const prompt = R.fillPrompt(tpl, { id: card.identifier, title: card.title, body: (card.description || '').slice(0, 8000), extra: fence(tail(codexReport, 6000)) })
    .replace(/\{\{WORKTREE\}\}/g, WT);
  fs.writeFileSync(path.join(LOG_DIR, `${card.identifier}-${tag}-prompt.md`), prompt);
  const head = git(['rev-parse', 'HEAD']);
  // cwd is the worktree so plain git/node commands work; --setting-sources user keeps
  // the project's session hooks out of this one-shot reviewer (CLAUDE.md still loads).
  // Prompt on stdin: --allowedTools and --add-dir are variadic and swallow a positional.
  const r = sh('claude', ['-p', '--model', 'opus', '--setting-sources', 'user', '--output-format', 'text',
    '--allowedTools', 'Read,Grep,Glob,Bash(git:*),Bash(node:*),Bash(npx tsc:*),Bash(cd:*),Bash(ls:*),Bash(grep:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(jq:*),Bash(cat:*),Bash(sort:*),Bash(diff:*)',
    '--disallowedTools', 'Edit,Write,NotebookEdit,Bash(git push:*),Bash(git commit:*),Bash(git reset:*),Bash(git checkout:*),Bash(git stash:*),Bash(git rebase:*),Bash(git merge:*)',
  ], { cwd: WT, timeoutMs: 30 * 60_000, env: scrubbedEnv(), input: prompt });
  fs.writeFileSync(path.join(LOG_DIR, `${card.identifier}-${tag}.log`), r.out);
  // The reviewer is read-only; a moved HEAD or a dirty tree means it was not.
  const tampered = git(['rev-parse', 'HEAD']) !== head || git(['status', '--porcelain']) !== '';
  if (tampered) { git(['reset', '--hard', head]); git(['clean', '-fd', '-e', 'node_modules']); }
  const verdict = r.code === 0 && !tampered ? R.parseVerdict(r.stdout) : 'NONE';
  return { verdict, text: tampered ? 'The reviewer changed the worktree, so its verdict was discarded.' : tail(r.stdout || r.out, 3000) };
}

/** Commit Codex's working-tree changes. -> { hasDiff, blocked } */
function commitAttempt(card, attempt) {
  git(['add', '-A', '--', '.', ':!node_modules']);
  const names = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (!names.length) return { hasDiff: git(['rev-list', '--count', 'origin/main..HEAD']) !== '0', blocked: null };
  if (names.some((n) => n.startsWith('.github/workflows/'))) return { hasDiff: true, blocked: 'Codex edited .github/workflows/**, which the runner never lands' };
  if (R.looksLikeSecretLeak(git(['diff', '--cached']))) return { hasDiff: true, blocked: 'the diff looks like it carries token material' };
  git(['-c', 'user.name=Codex runner', '-c', 'user.email=codex-runner@broadwayscorecard.com', 'commit', '-q', '-m',
    `fix(${card.identifier}): ${card.title.slice(0, 80)}${attempt > 1 ? ' (review fixes)' : ''}\n\nWorked by the daily Codex runner; passed the independent check before landing.`]);
  return { hasDiff: true, blocked: null };
}

// The node unit batch land.yml runs (tests/unit-test-manifest.txt), judged the way land.yml
// judges it: failures the branch adds over fresh main. Only the files that fail on the branch
// re-run on main, so the base side is cheap. Returns null when clean, else the failure text.
const BASE_WT = path.join(ROOT, '.claude/worktrees/codex-runner-base');
function unitBatch(cwd, files) {
  const r = sh('node', ['--test', '--test-reporter=tap', '--test-timeout', '300000', ...files], { cwd, timeoutMs: 40 * 60_000 });
  return { exit: r.code, text: r.out, root: cwd };
}
function newUnitFailures() {
  const D = require(path.join(ROOT, 'scripts/lib/land-gate-delta.js'));
  const files = fs.readFileSync(path.join(WT, 'tests/unit-test-manifest.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const branch = unitBatch(WT, files);
  if (branch.exit === 0) return null;
  const failing = [...new Set([...D.parseGateFailures('unit-tests-node', branch.text, WT).values()].map((f) => f.file))]
    .filter((f) => f && f !== '?');
  if (!fs.existsSync(path.join(BASE_WT, '.git'))) {
    git(['worktree', 'add', '--detach', BASE_WT, 'origin/main'], ROOT);
    if (!fs.existsSync(path.join(BASE_WT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(BASE_WT, 'node_modules'));
  }
  git(['checkout', '-q', '-f', '--detach', 'origin/main'], BASE_WT);
  const onBase = failing.filter((f) => fs.existsSync(path.join(BASE_WT, f)));
  const base = onBase.length ? unitBatch(BASE_WT, onBase) : { exit: 0, text: '', root: BASE_WT };
  const d = D.decideGateDelta({ gate: 'unit-tests-node', base, branch });
  if (d.verdict === 'pass') return null;
  const lines = d.newFailures.map((f) => `- ${f.file}::${f.name}${f.payload ? `\n${String(f.payload).slice(0, 600)}` : ''}`);
  return `${d.reason}\n${lines.join('\n') || tail(branch.text, 2000)}`;
}

async function landPreflight(ref) {
  const { judgeLand } = await import(path.join(ROOT, 'scripts/lib/land-preflight.mjs'));
  return judgeLand({ cwd: WT, src: 'HEAD', target: `refs/heads/${ref}` });
}

function waitForLand(ref) {
  return new Promise((resolve) => {
    const p = spawn('node', ['scripts/lib/wait-for-land.js', ref, '90'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function finishLanding(entry, stats) {
  const res = await waitForLand(entry.ref);
  const { card, summary } = entry;
  if (res.code === 0) {
    const done = await moveCard(card.identifier, 'Done', `## Codex runner: landed\n\n${summary}\n\nLanded via \`${entry.ref}\`.`);
    if (done.code === 0) { stats.landed.push(card.identifier); return; }
    stats.doneRefusals += 1;
    stats.inReview.push(card.identifier);
    await moveCard(card.identifier, 'In Review', `## Codex runner: landed, but the Done gate refused\n\n${fence(tail(done.out, 1200))}\n\n${summary}`);
    return;
  }
  stats.landFailed.push(card.identifier);
  // Left In Progress on purpose: the Claude cloud worker resumes refused land/ refs.
  if (!OPTS.dryRun) await linearBrain(['update', card.identifier, '--comment', `## Codex runner: landing did not finish (wait-for-land exit ${res.code})\n\nThe land ref \`${entry.ref}\` is left for the cloud worker's resume step.\n\n${fence(tail(res.out, 1200))}`]);
}

async function pickCards() {
  if (OPTS.ids) return OPTS.ids.map((identifier) => ({ identifier }));
  const r = sh('node', ['scripts/cloud-worker-pick.js', `--list=${OPTS.limit + 5}`], { timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new Error(`picker failed: ${tail(r.out, 400)}`);
  return JSON.parse(r.stdout).picks || [];
}

async function workCard(pick, stats, inFlight) {
  const id = pick.identifier;
  const card = await linear.getIssue(id);
  if (!card) { log(`${id}: not found`); return 'skip'; }
  const stateType = card.state && card.state.type;
  if (!['unstarted', 'backlog', 'triage'].includes(stateType)) { log(`${id}: state ${card.state && card.state.name}, skipped`); return 'skip'; }
  if (OPTS.dryRun) { log(`dry-run: would work ${id} "${card.title}"`); return 'skip'; }

  const claim = sh('node', ['scripts/linear-session.js', 'claim', `--issue=${id}`], { timeoutMs: 900_000 });
  const claimJson = (claim.stdout.split('\n').reverse().find((l) => l.startsWith('{')) || '{}');
  let action = null; try { action = JSON.parse(claimJson).action; } catch { /* unparseable claim output */ }
  if (claim.code !== 0 || !action || action === 'noop') { log(`${id}: claim ${action || 'failed'}, skipped`); return 'skip'; }
  stats.claimed.push(id);
  current = id;

  let disposed = false;
  try {
    const branch = `codex/${id.toLowerCase()}`;
    resetWorktree(branch);
    const cmd = verifyCommand(card);
    let onMain = 'The card has no automatic check command.';
    if (cmd) {
      const v = makeVerifyCmdEvidence({ timeoutMs: 600_000 })(cmd);
      onMain = `\`${cmd}\` on fresh main: ${v.allowed ? 'PASSES already (the card may be fixed; confirm before changing code)' : `does not pass (${v.verdict}): ${String(v.reason).slice(0, 600)}`}`;
    }
    const tpl = fs.readFileSync(path.join(ROOT, 'scripts/codex/runner-prompt.md'), 'utf8');
    const body = (card.description || '').slice(0, 12000);
    let report = '';
    let check = null;
    let attempt = 1;
    let step = null;
    for (; attempt <= 2; attempt++) {
      const extra = attempt === 1 ? onMain
        : `${onMain}\n\nYour previous attempt is committed on this branch. It did not pass the checks (the repo's unit tests, or the independent reviewer). Fix every blocking issue below (or, if a finding is wrong, show the evidence in your report):\n${fence(check.text)}`;
      const cx = runCodex(id, R.fillPrompt(tpl, { id, title: card.title, body, extra }), `codex${attempt}`);
      report = cx.report;
      const c = commitAttempt(card, attempt);
      if (c.blocked) { check = { verdict: 'REJECT', text: `Blocked before review: ${c.blocked}.` }; step = 'bounce'; break; }
      // Land refuses new unit-test failures half an hour after the push, when the worktree has
      // moved on; catch them here and hand them straight back without spending a Claude check.
      const unitFails = c.hasDiff ? newUnitFailures() : null;
      if (unitFails) {
        check = { verdict: 'REJECT', text: `The repo's node unit batch (the one land.yml runs) has new failures on this branch that fresh main does not have:\n${unitFails}` };
        log(`${id}: attempt ${attempt} unit tests red`);
        step = R.nextStep({ verdict: 'REJECT', hasDiff: true, attempt });
        if (step !== 'fix-round') break;
        continue;
      }
      check = runCheck(card, report, `check${attempt}`);
      log(`${id}: attempt ${attempt} verdict ${check.verdict}${c.hasDiff ? '' : ' (no diff)'}`);
      step = R.nextStep({ verdict: check.verdict, hasDiff: c.hasDiff, attempt });
      if (step !== 'fix-round') break;
    }
    stats.rejectStreak = check.verdict === 'REJECT' ? stats.rejectStreak + 1 : 0;
    const summary = `### Codex report\n${fence(tail(report, 2500))}\n\n### Independent check (${check.verdict})\n${fence(tail(check.text, 2000))}`;

    if (step === 'land') {
      if (!OPTS.land) { stats.wouldLand.push(id); await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: passed the check, not landed (--no-land run)\n\n${summary}`); disposed = true; return 'done'; }
      const ref = `land/codex-${id.toLowerCase()}`;
      const pre = await landPreflight(ref);
      if (pre.decision === 'block') { step = 'bounce'; check.text = `Land preflight blocked it: ${pre.message}`; } else {
        while (inFlight.length >= MAX_IN_FLIGHT) await inFlight.shift().promise;
        // land/codex-* refs belong to the runner; a re-worked card's earlier ref (refused or
        // stale) must not block the new attempt. The claim keeps one runner per card.
        git(['push', '--force', 'origin', `HEAD:refs/heads/${ref}`]);
        log(`${id}: pushed ${ref}`);
        const entry = { ref, card, summary };
        entry.promise = finishLanding(entry, stats);
        inFlight.push(entry);
        disposed = true;
        return 'done';
      }
    }
    if (step === 'close-already-fixed') {
      const r = await moveCard(id, 'Done', `## Codex runner: already fixed on main, no code change\n\nThe independent check confirmed nothing was needed.\n\n${summary}`);
      if (r.code === 0) { stats.alreadyFixed.push(id); disposed = true; return 'done'; }
      stats.doneRefusals += 1;
    }
    stats.bounced.push(id);
    await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: not landed, left for the Claude worker\n\nTwo Codex attempts did not pass the independent check, so nothing was pushed. Findings for whoever takes it next:\n\n${summary}`);
    disposed = true;
    return 'done';
  } finally {
    current = null;
    if (!disposed) {
      stats.crashed.push(id);
      await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: stopped mid-card\n\nThe runner hit an error on this card and changed nothing on main. Back to Todo for the Claude worker.`).catch(() => {});
    }
  }
}

// The card claimed right now, so a kill (routine timeout, container stop) can hand it back.
let current = null;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (current && !OPTS.dryRun) {
      sh('node', ['scripts/linear-brain.js', 'update', current, '--state', 'Todo', '--comment',
        `## Codex runner: stopped (${sig}) mid-card\n\nNothing was landed for this card. Back to Todo.`], { timeoutMs: 600_000 });
    }
    log(`killed by ${sig}${current ? `; ${current} returned to Todo` : ''}`);
    process.exit(1);
  });
}

async function main() {
  const startedMs = Date.now();
  // Fresh cloud containers do not ship the Codex CLI; install the pinned version.
  if (sh('codex', ['--version'], { timeoutMs: 60_000 }).code !== 0) {
    const inst = sh('npm', ['install', '-g', `@openai/codex@${CODEX_VERSION}`], { timeoutMs: 600_000 });
    log(`installed Codex CLI ${CODEX_VERSION}: exit ${inst.code}`);
  }
  for (const tool of ['codex', 'claude']) {
    if (sh(tool, ['--version'], { timeoutMs: 60_000 }).code !== 0) { log(`${tool} CLI missing`); process.exit(2); }
  }
  const restore = sh('node', ['scripts/codex/auth-store.js', 'restore'], { timeoutMs: 900_000 });
  log(restore.out.trim());
  if (restore.code !== 0) {
    if (!OPTS.dryRun) await linearBrain(['update', RUNNER_CARD, '--comment', `## Codex runner did not start\n\nNo usable Codex login (it may have expired). Someone with the ChatGPT account must run \`codex login --device-auth\` in a cloud session, then \`node scripts/codex/auth-store.js save\`.\n\n${fence(tail(restore.out, 600))}`]);
    process.exit(2);
  }
  const install = sh('node', ['scripts/codex/install.js']);
  if (install.code !== 0) log(`codex install warning: ${tail(install.out, 300)}`);
  setupWorktree();

  const stats = { claimed: [], landed: [], alreadyFixed: [], bounced: [], inReview: [], landFailed: [], crashed: [], wouldLand: [], rejectStreak: 0, doneRefusals: 0 };
  const inFlight = [];
  let worked = 0;
  let stop = null;
  for (const pick of await pickCards()) {
    if (worked >= OPTS.limit) break;
    stop = R.stopReason({ startedMs, nowMs: Date.now(), maxMinutes: OPTS.maxMinutes, weeklyPct: weeklyPct(), maxWeeklyPct: OPTS.maxWeeklyPct, rejectStreak: stats.rejectStreak, doneRefusals: stats.doneRefusals });
    if (stop) { log(`stopping: ${stop}`); break; }
    try {
      if (await workCard(pick, stats, inFlight) === 'done') worked += 1;
    } catch (e) {
      log(`${pick.identifier}: error ${e && e.message ? e.message : e}`);
    }
  }
  await Promise.all(inFlight.map((e) => e.promise));
  saveLogin();

  const mins = Math.round((Date.now() - startedMs) / 60_000);
  const list = (a) => (a.length ? a.join(', ') : 'none');
  const text = [
    `## Codex runner ${new Date().toISOString().slice(0, 10)}: ${worked} card(s) worked in ${mins} min`,
    `- Landed and Done: ${list(stats.landed)}`,
    `- Already fixed, closed: ${list(stats.alreadyFixed)}`,
    `- Did not pass the Claude check, back to Todo: ${list(stats.bounced)}`,
    `- Landed but Done gate refused (In Review): ${list(stats.inReview)}`,
    `- Landing did not finish (left In Progress for resume): ${list(stats.landFailed)}`,
    `- Runner error mid-card (back to Todo): ${list(stats.crashed)}`,
    ...(stats.wouldLand.length ? [`- Passed, not landed (--no-land): ${list(stats.wouldLand)}`] : []),
    `- Codex weekly allowance used: ${weeklyPct() ?? 'unknown'}%`,
    `- Stopped early: ${stop || 'no'}`,
  ].join('\n');
  log(text);
  if (!OPTS.dryRun) await linearBrain(['update', RUNNER_CARD, '--comment', text]);
}

module.exports = { newUnitFailures };
if (require.main === module) main().catch((e) => { log(`runner failed: ${e && e.stack ? e.stack : e}`); process.exit(1); });
