#!/usr/bin/env node
'use strict';
/**
 * daily-runner.js — the unattended Codex card worker (BRO-4745). The
 * codex-runner.yml workflow runs it five times a day; no Claude session
 * supervises the work itself.
 *
 *   node scripts/codex/daily-runner.js [--limit 10] [--ids BRO-1,BRO-2]
 *        [--max-minutes 420] [--max-weekly-pct 60] [--no-land] [--dry-run]
 *        [--check-max-usd 4] [--check-budget-usd 30] [--card-max-minutes 120]
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
  // The Claude check bills per review when run outside a subscription session (Actions):
  // each review stops at --check-max-usd, the run stops picking cards at --check-budget-usd.
  checkMaxUsd: Number(arg('check-max-usd', 4)),
  checkBudgetUsd: Number(arg('check-budget-usd', 30)),
  // One card's wall clock: a new Codex exec starts only if a whole exec (its 45-min
  // timeout) still fits, so a card cannot run past the job's timeout on fix rounds.
  cardMaxMinutes: Number(arg('card-max-minutes', 120)),
};
const CODEX_TIMEOUT_MS = 45 * 60_000;
let checkSpentUsd = 0;
let checkCount = 0;

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
 * Env for the Codex, unit-test and Claude-check shells: no service keys or tokens (so no
 * paid fetches, LLM rescoring or Linear writes) and git pushes rewritten to nowhere.
 * Only the reviewer keeps Claude's session vars (it needs them to authenticate).
 */
function scrubbedEnv({ reviewer = false } = {}) {
  return R.scrubEnv(process.env, { reviewer });
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** linear-brain.js with every --comment redacted; retries transient failures (429s), never a gate refusal (exit 5). */
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

function setupWorktree() {
  if (!fs.existsSync(path.join(WT, '.git'))) {
    sh('git', ['worktree', 'prune']);
    git(['fetch', 'origin', 'main'], ROOT);
    git(['worktree', 'add', '--detach', WT, 'origin/main'], ROOT);
  }
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(WT, 'node_modules'))) fs.symlinkSync(nm, path.join(WT, 'node_modules'));
}

/**
 * Give a freshly cleaned worktree the private data the main checkout has (R.DATA_FILES
 * copied, data/review-texts linked), since `git clean -x` removes it. reviewTexts: false
 * for the land-check batches: land.yml has no review texts either, and those batches run
 * outside the Codex sandbox, so a test write must not reach the shared clone.
 * -> { lines (for the prompts), dirs (real paths the reviewer may read) }
 */
function provideData(dest, { reviewTexts = true } = {}) {
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
    if (!reviewTexts || !fs.existsSync(from)) { if (reviewTexts) lines.push(`- data/${name}: not available in this run. If the card needs it, say so in a REMAINING line.`); continue; }
    const real = fs.realpathSync(from);
    let cfg = '';
    try { cfg = fs.readFileSync(path.join(real, '.git', 'config'), 'utf8'); } catch { /* not a clone */ }
    if (R.hasCredentialRemote(cfg)) { log(`provideData: ${real} keeps a credential in its remote URL; not linked`); lines.push(`- data/${name}: not available in this run.`); continue; }
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

function resetWorktree(branch) {
  git(['fetch', 'origin', 'main']);
  git(['checkout', '-f', '-B', branch, 'origin/main']);
  git(['reset', '--hard', 'origin/main']);
  // -x: gitignored files Codex or tests wrote must not carry into the next card.
  git(['clean', '-fdx', '-e', 'node_modules']);
  return provideData(WT);
}

function weeklyPct() {
  const dir = path.join(CODEX_HOME, 'sessions');
  const files = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { try { files.push({ p, m: fs.statSync(p).mtimeMs }); } catch { /* vanished */ } }
    }
  };
  walk(dir);
  // The newest rollout can be one that has not logged a rate-limit reading yet
  // (just started, or aborted early), so fall back through the next few.
  files.sort((a, b) => b.m - a.m);
  for (const f of files.slice(0, 8)) {
    try { const pct = R.latestWeeklyPercent(fs.readFileSync(f.p, 'utf8')); if (pct != null) return pct; } catch { /* unreadable */ }
  }
  return null;
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
  { cwd: WT, timeoutMs: CODEX_TIMEOUT_MS, env: scrubbedEnv(), input: '' });
  fs.writeFileSync(path.join(LOG_DIR, `${id}-${tag}.log`), r.out);
  saveLogin(); // refresh tokens rotate: persist the newest login after every exec
  let report = '';
  try { report = fs.readFileSync(last, 'utf8'); } catch { report = tail(r.out, 4000); }
  return { code: r.code, report };
}

function runCheck(card, body, codexReport, tag, data) {
  const tpl = fs.readFileSync(path.join(ROOT, 'scripts/codex/check-prompt.md'), 'utf8');
  const prompt = R.fillPrompt(tpl, { id: card.identifier, title: card.title, body, extra: fence(tail(codexReport, 6000)), data: data.lines.join('\n'), worktree: WT });
  fs.writeFileSync(path.join(LOG_DIR, `${card.identifier}-${tag}-prompt.md`), prompt);
  const head = git(['rev-parse', 'HEAD']);
  // The reviewer runs tests unsandboxed: drop the review-texts link so no test writes into the
  // shared clone (land.yml runs without it too). It reads the texts through --add-dir instead.
  for (const d of R.DATA_DIRS) fs.rmSync(path.join(WT, 'data', d), { force: true });
  // cwd is the worktree so plain git/node commands work; --setting-sources user keeps
  // the project's session hooks out of this one-shot reviewer (CLAUDE.md still loads).
  // Prompt on stdin: --allowedTools and --add-dir are variadic and swallow a positional.
  // --add-dir: the data the worktree links to (review texts live outside it), or the
  // reviewer is denied every read there.
  const r = sh('claude', ['-p', '--model', 'opus', '--setting-sources', 'user', '--output-format', 'json',
    '--max-budget-usd', String(OPTS.checkMaxUsd),
    ...(data.dirs.length ? ['--add-dir', ...data.dirs] : []),
    '--allowedTools', 'Read,Grep,Glob,Bash(git:*),Bash(node:*),Bash(npx tsc:*),Bash(cd:*),Bash(ls:*),Bash(find:*),Bash(rg:*),Bash(sed:*),Bash(grep:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(jq:*),Bash(cat:*),Bash(sort:*),Bash(diff:*)',
    '--disallowedTools', 'Edit,Write,NotebookEdit,Bash(git push:*),Bash(git commit:*),Bash(git reset:*),Bash(git checkout:*),Bash(git stash:*),Bash(git rebase:*),Bash(git merge:*),Bash(sed -i:*),Bash(sed --in-place:*),Bash(find * -delete*),Bash(find * -exec*),Bash(find * -execdir*),Bash(find * -ok*)',
  ], { cwd: WT, timeoutMs: 30 * 60_000, env: scrubbedEnv({ reviewer: true }), input: prompt });
  fs.writeFileSync(path.join(LOG_DIR, `${card.identifier}-${tag}.log`), r.out);
  // The verdict is about the committed HEAD. A moved HEAD means the reviewer committed or
  // checked out, so its verdict is void. Leftover files are test residue (tests rewrite
  // data/audit/*.json): clean them either way so they never reach the next commit.
  const tampered = git(['rev-parse', 'HEAD']) !== head;
  git(['reset', '-q', '--hard', head]);
  git(['clean', '-qfd', '-e', 'node_modules']);
  provideData(WT);
  const out = R.parseCheckOutput(r.stdout);
  checkSpentUsd += out.costUsd;
  checkCount += 1;
  log(`${card.identifier} ${tag}: Claude check cost $${out.costUsd.toFixed(2)}${out.error ? ` (${out.error})` : ''}`);
  const verdict = r.code === 0 && !tampered && !out.error ? R.parseVerdict(out.text) : 'NONE';
  return { verdict, text: tampered ? 'The reviewer changed the worktree, so its verdict was discarded.' : tail(out.text || r.out, 3000) };
}

/** Commit Codex's working-tree changes. -> { hasDiff, blocked } */
function commitAttempt(card, attempt) {
  git(['add', '-A']); // node_modules is a gitignored symlink; naming it in a pathspec makes git add fail
  const names = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (!names.length) return { hasDiff: git(['rev-list', '--count', 'origin/main..HEAD']) !== '0', blocked: null };
  if (names.some((n) => n.startsWith('.github/workflows/'))) return { hasDiff: true, blocked: 'Codex edited .github/workflows/**, which the runner never lands' };
  // A staged symlink could point at the private data the runner links in (land refuses tracked symlinks too).
  if (/^:\d+ 120000 /m.test(git(['diff', '--cached', '--raw']))) return { hasDiff: true, blocked: 'the change adds a symlink, which the runner never lands' };
  if (R.looksLikeSecretLeak(git(['diff', '--cached']))) return { hasDiff: true, blocked: 'the diff looks like it carries token material' };
  git(['-c', 'user.name=Codex runner', '-c', 'user.email=codex-runner@broadwayscorecard.com', 'commit', '-q', '-m',
    `fix(${card.identifier}): ${card.title.slice(0, 80)}${attempt > 1 ? ' (review fixes)' : ''}\n\nWorked by the daily Codex runner; passed the independent check before landing.`]);
  return { hasDiff: true, blocked: null };
}

// The land checks a Codex change can break without noticing (BRO-4745 follow-up): the node
// unit batch (tests/unit-test-manifest.txt), the scripts/lib/*.test.mjs batch, and the
// lint-workflows audit list (land-gauntlet.sh, GAUNTLET_GATES=lint-workflows), each judged the
// way land.yml judges it: failures the branch adds over fresh main (land-gate-delta.js). Only
// what fails on the branch re-runs on main, so the base side is cheap. Run without the review
// texts, like land.yml. Returns null when clean, else the failure text.
const BASE_WT = path.join(ROOT, '.claude/worktrees/codex-runner-base');
function unitBatch(cwd, files) {
  // Same scrubbed env as Codex: the manifest and tests come from Codex's branch.
  const r = sh('node', ['--test', '--test-reporter=tap', '--test-timeout', '300000', ...files], { cwd, timeoutMs: 40 * 60_000, env: scrubbedEnv() });
  return { exit: r.code, text: r.out, root: cwd };
}
function lintWorkflows(cwd, gauntlet) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lw-'));
  try {
    sh('bash', [gauntlet, out], { cwd, timeoutMs: 30 * 60_000, env: { ...scrubbedEnv(), GAUNTLET_GATES: 'lint-workflows' } });
    const exit = Number(fs.readFileSync(path.join(out, 'lint-workflows.exit'), 'utf8').trim());
    return { exit: Number.isFinite(exit) ? exit : null, text: fs.readFileSync(path.join(out, 'lint-workflows.log'), 'utf8'), root: cwd };
  } catch { return { exit: null, text: '', root: cwd }; } finally { fs.rmSync(out, { recursive: true, force: true }); }
}
function cleanTree(cwd) {
  git(['reset', '-q', '--hard', 'HEAD'], cwd);
  git(['clean', '-qfdx', '-e', 'node_modules'], cwd);
}
function prepareBase() {
  if (!fs.existsSync(path.join(BASE_WT, '.git'))) {
    git(['worktree', 'add', '--detach', BASE_WT, 'origin/main'], ROOT);
    if (!fs.existsSync(path.join(BASE_WT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(BASE_WT, 'node_modules'));
  }
  git(['checkout', '-q', '-f', '--detach', 'origin/main'], BASE_WT);
  git(['clean', '-qfdx', '-e', 'node_modules'], BASE_WT);
  provideData(BASE_WT, { reviewTexts: false });
}
function newLandFailures() {
  const D = require(path.join(ROOT, 'scripts/lib/land-gate-delta.js'));
  // The branch's own harness copy judges both trees, as land.yml does.
  const gauntlet = path.join(os.tmpdir(), `codex-land-gauntlet-${process.pid}.sh`);
  fs.copyFileSync(path.join(WT, 'scripts/lib/land-gauntlet.sh'), gauntlet);
  try { return landFailuresWith(D, gauntlet); } finally { fs.rmSync(gauntlet, { force: true }); }
}
function landFailuresWith(D, gauntlet) {
  for (const d of R.DATA_DIRS) fs.rmSync(path.join(WT, 'data', d), { force: true }); // a symlink: removes the link only
  const read = (f) => { try { return fs.readFileSync(path.join(WT, f), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; } };
  const libTests = fs.readdirSync(path.join(WT, 'scripts/lib')).filter((f) => f.endsWith('.test.mjs')).map((f) => `scripts/lib/${f}`);
  const batches = [
    { gate: 'unit-tests-node', run: (cwd, files) => unitBatch(cwd, files), files: read('tests/unit-test-manifest.txt') },
    { gate: 'scripts-lib-tests', run: (cwd, files) => unitBatch(cwd, files), files: libTests },
    { gate: 'lint-workflows', run: (cwd) => lintWorkflows(cwd, gauntlet), files: null },
  ];
  const branch = new Map();
  for (const b of batches) branch.set(b.gate, b.files && !b.files.length ? { exit: 0, text: '', root: WT } : b.run(WT, b.files));
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
    prepareBase();
    for (const b of red) {
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
    }
    cleanTree(BASE_WT);
  }
  return report.length ? R.redactSecrets(report.join('\n\n'), process.env) : null;
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

/** The card's runner commit is on origin/main (a landing that outlived wait-for-land). */
function landedOnMain(id, sinceMs) {
  try {
    git(['fetch', 'origin', 'main']);
    const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : '4.days';
    return git(['log', 'origin/main', `--since=${since}`, '--author=Codex runner', '--format=%H', '-F', `--grep=fix(${id}):`]) !== '';
  } catch { return false; }
}

/**
 * The one place a landed runner commit settles its card: Done through the Done gate (In
 * Review if refused), or, for a partial fix (PARTIAL_MARKER on the card since the claim),
 * back to Todo for the Claude worker with what is left. -> true when the card was moved.
 */
async function settleLanded(id, stats, { partial, remaining = [], body, countRefusal = false }) {
  if (partial) {
    const left = remaining.length ? `Still open on this card:\n${remaining.map((x) => `- ${x}`).join('\n')}\n\n` : 'Some card items are still open (see the runner\'s "landing a partial fix" note).\n\n';
    const r = await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: landed part of this card\n\n${left}${body}\n\n${R.PARTIAL_MARKER}`);
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
  // Comments carry acceptance corrections and the bounce marker; never work a card blind to them.
  let comments;
  try { comments = (await linear.listIssueComments([id])).get(id) || []; } catch (e) { log(`${id}: comments unreadable (${e && e.message ? e.message.split('\n')[0] : e}), skipped`); return 'skip'; }
  if (R.codexBouncedRecently(comments, Date.now())) { log(`${id}: Codex bounced it recently, skipped`); return 'skip'; }
  const body = R.cardBody(card.description, comments);
  if (OPTS.dryRun) { log(`dry-run: would work ${id} "${card.title}" (${body.length} chars with comments)`); return 'skip'; }

  const claimedMs = Date.now();
  const claim = sh('node', ['scripts/linear-session.js', 'claim', `--issue=${id}`], { timeoutMs: 900_000 });
  const claimJson = (claim.stdout.split('\n').reverse().find((l) => l.startsWith('{')) || '{}');
  let action = null; try { action = JSON.parse(claimJson).action; } catch { /* unparseable claim output */ }
  if (claim.code !== 0 || !action || action === 'noop') { log(`${id}: claim ${action || 'failed'}, skipped`); return 'skip'; }
  stats.claimed.push(id);
  current = id;
  openCards.add(id);

  // disposed: this card's outcome is handled (no generic hand-back in finally).
  // handedBack: its Linear move really succeeded, so it can leave the lock.
  let disposed = false;
  let handedBack = false;
  try {
    // Record the claim in the lock, so a run that dies from here on leaves this card named.
    if (!refreshLock()) throw new Error('lost the run lock to another run');
    const branch = `codex/${id.toLowerCase()}`;
    const data = resetWorktree(branch);
    const cmd = verifyCommand(card);
    let onMain = 'The card has no automatic check command.';
    if (cmd) {
      const v = makeVerifyCmdEvidence({ timeoutMs: 600_000 })(cmd);
      onMain = `\`${cmd}\` on fresh main: ${v.allowed ? 'PASSES already (the card may be fixed; confirm before changing code)' : `does not pass (${v.verdict}): ${String(v.reason).slice(0, 600)}`}`;
    }
    const tpl = fs.readFileSync(path.join(ROOT, 'scripts/codex/runner-prompt.md'), 'utf8');
    const prompt = (extra) => R.fillPrompt(tpl, { id, title: card.title, body, extra, data: data.lines.join('\n') });
    // A new Codex exec starts only while a whole one (its timeout) plus the review after it
    // still fits the card budget. The land checks and review after the last exec still run, so
    // a card can overrun the budget by those (bounded by their own timeouts).
    const cardDeadline = claimedMs + OPTS.cardMaxMinutes * 60_000;
    const execFits = () => cardDeadline - Date.now() >= CODEX_TIMEOUT_MS + 30 * 60_000;
    let report = '';
    let check = null;
    let attempt = 1;
    let execs = 0;
    let step = null;
    let abort = null;
    let envRetryUsed = false;
    let envBlocked = null;
    let extra = onMain;
    for (;;) {
      keepLock();
      const cx = runCodex(id, prompt(extra), `codex${++execs}`);
      report = cx.report;
      // A failed exec (quota, login, crash) is not a fix attempt: hand back unmarked and stop the run.
      if (cx.code !== 0) { abort = `Codex exited ${cx.code}: ${tail(R.redactSecrets(report, process.env), 400)}`; break; }
      let c = commitAttempt(card, attempt);
      if (c.blocked) { check = { verdict: 'REJECT', text: `Blocked before review: ${c.blocked}.` }; step = 'bounce'; break; }
      // Land refuses new unit/audit failures half an hour after the push, when the worktree has
      // moved on; catch them here and hand them straight back to Codex in the same attempt.
      keepLock();
      let landFails = c.hasDiff ? newLandFailures() : null;
      if (landFails && execFits()) {
        log(`${id}: attempt ${attempt} land checks red, back to Codex`);
        keepLock();
        const fx = runCodex(id, prompt(`${onMain}\n\nYour change is committed on this branch, but the checks land runs found failures it adds over fresh main. Fix them (or, if one is not caused by your change, show the evidence in your report), then report as before:\n${fence(landFails)}${check ? `\n\nThe reviewer's earlier findings still apply:\n${fence(check.text)}` : ''}`), `codex${++execs}`);
        if (fx.code !== 0) { abort = `Codex exited ${fx.code}: ${tail(R.redactSecrets(fx.report, process.env), 400)}`; break; }
        report = `${report}\n\n--- after fixing the land-check failures ---\n${fx.report}`;
        c = commitAttempt(card, attempt);
        if (c.blocked) { check = { verdict: 'REJECT', text: `Blocked before review: ${c.blocked}.` }; step = 'bounce'; break; }
        keepLock();
        landFails = newLandFailures();
      }
      envBlocked = null;
      if (landFails) {
        check = { verdict: 'REJECT', text: `The checks land runs (node unit batch, scripts/lib tests, lint-workflows audits) have new failures on this branch that fresh main does not have:\n${landFails}` };
        log(`${id}: attempt ${attempt} land checks red`);
        step = R.nextStep({ verdict: 'REJECT', hasDiff: true, attempt });
      } else {
        keepLock();
        check = runCheck(card, body, report, `check${execs}`, data);
        log(`${id}: attempt ${attempt} verdict ${check.verdict}${c.hasDiff ? '' : ' (no diff)'}`);
        // No verdict means the reviewer is broken (auth, crash), not that the work is bad.
        if (check.verdict === 'NONE') { abort = `the Claude check gave no verdict: ${tail(R.redactSecrets(check.text, process.env), 400)}`; break; }
        envBlocked = c.hasDiff ? null : R.parseEnvBlocked(report);
        step = R.nextStep({ verdict: check.verdict, hasDiff: c.hasDiff, attempt, envBlocked: !!envBlocked, envRetryUsed });
      }
      if (step !== 'fix-round' && step !== 'env-retry') break;
      if (!execFits()) { step = 'bounce'; check.text += `\n\n(The runner's ${OPTS.cardMaxMinutes}-minute card budget ran out before another round.)`; break; }
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
    if (abort) {
      stats.aborted = abort;
      stats.crashed.push(id);
      handedBack = (await moveCard(id, 'Todo', `## Codex runner: stopped before finishing this card\n\n${abort}\n\nNothing was landed. The run stopped; the card is free for any worker.`)).code === 0;
      disposed = true;
      return 'done';
    }
    // An environment block is not Codex's miss, so it does not feed the REJECT streak.
    stats.rejectStreak = check.verdict === 'REJECT' && !envBlocked ? stats.rejectStreak + 1 : 0;
    const summary = `### Codex report\n${fence(tail(report, 2500))}\n\n### Independent check (${check.verdict})\n${fence(tail(check.text, 2000))}`;
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
          git(['push', '--force', 'origin', `HEAD:refs/heads/${ref}`]);
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
      if (r.code === 5) stats.doneRefusals += 1;
    }
    stats.bounced.push(id);
    const why = remaining.length && !landBlocked ? `Nothing needed landing, but these card items are still open:\n${remaining.map((x) => `- ${x}`).join('\n')}`
      : `${attempt} Codex attempt(s) did not pass the checks, so nothing was pushed.`;
    handedBack = (await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: not landed, left for the Claude worker\n\n${why} Findings for whoever takes it next:\n\n${summary}`)).code === 0;
    disposed = true;
    return 'done';
  } finally {
    if (!disposed) {
      stats.crashed.push(id);
      const back = await moveCard(id, 'Todo', `${R.BOUNCED_MARKER}\n## Codex runner: stopped mid-card\n\nThe runner hit an error on this card and changed nothing on main. Back to Todo for the Claude worker.`).catch(() => ({ code: 1 }));
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
const LOCK_REF = process.env.CODEX_RUNNER_LOCK_REF || 'refs/heads/codex-runner-lock';
// Refreshed before each blocking step of a card (Codex, unit batch, check; the longest is
// Codex at 45 min) and every 30 min while landings wait, so a live run never looks stale.
// A killed run (SIGKILL skips the release) blocks the next run only until it goes stale.
const LOCK_STALE_MS = 5 * 3600_000;
let lockSha = null;
// Cards this run claimed and has not finished (working or waiting on a landing); written
// into every lock stamp. orphanCards: the ones a dead run left in the stale lock we took over.
const openCards = new Set();
let orphanCards = [];
let orphanLockMs = NaN;
const lockStamp = () => R.lockMessage(new Date().toISOString(), [...openCards]);
function lockCommit(msg) {
  const tree = git(['rev-parse', 'origin/main^{tree}'], ROOT);
  return git(['-c', 'user.name=Codex runner', '-c', 'user.email=codex-runner@broadwayscorecard.com', 'commit-tree', tree, '-m', msg], ROOT);
}
function lockPush(sha, expect) {
  for (let i = 0; i < 3; i++) {
    if (i) sh('sleep', [String(5 * i)]);
    if (sh('git', ['push', '-q', `--force-with-lease=${LOCK_REF}:${expect}`, 'origin', `${sha}:${LOCK_REF}`]).code === 0) return true;
    // A lease rejection means another run moved the lock; retrying cannot win, so stop.
    const now = sh('git', ['ls-remote', 'origin', LOCK_REF]);
    const tip = now.code === 0 ? (now.stdout.split(/\s/)[0] || '') : null;
    if (tip === sha) return true; // the push landed but its reply was lost
    if (tip !== null && tip !== expect) return false;
  }
  return false;
}
/** -> null when taken, else why not. */
function takeLock() {
  git(['fetch', '-q', 'origin', 'main'], ROOT);
  const ls = sh('git', ['ls-remote', 'origin', LOCK_REF]);
  if (ls.code !== 0) return `lock unreadable: ${tail(ls.out, 200)}`;
  const cur = ls.stdout.split(/\s/)[0] || '';
  let stale = [];
  let staleMs = NaN;
  if (cur) {
    git(['fetch', '-q', 'origin', LOCK_REF], ROOT);
    const [ct, ...msg] = git(['log', '-1', '--format=%ct %s', 'FETCH_HEAD'], ROOT).split(' ');
    const age = Date.now() - Number(ct) * 1000;
    if (msg.join(' ').startsWith('locked') && age < LOCK_STALE_MS) return `another run holds the lock (${msg.join(' ')}, ${Math.round(age / 60_000)} min old)`;
    stale = R.lockCards(msg.join(' '));
    staleMs = Number(ct) * 1000;
  }
  // Adopted orphans stay named in our stamps until handled, so dying again does not lose them.
  for (const id of stale) openCards.add(id);
  const sha = lockCommit(lockStamp());
  if (!lockPush(sha, cur)) return 'another run took the lock first';
  lockSha = sha;
  orphanCards = stale;
  orphanLockMs = staleMs;
  return null;
}
/** Re-stamp the lock so a long healthy run never looks stale. -> false if another run took it. */
/** Re-stamp between blocking steps; a lost lock stops this card (the finally hands it back). */
function keepLock() {
  let held = true;
  try { held = refreshLock(); } catch { /* transient: the next stamp retries */ }
  if (!held) throw new Error('lost the run lock to another run');
}

function refreshLock() {
  if (!lockSha) return true;
  const sha = lockCommit(lockStamp());
  if (!lockPush(sha, lockSha)) return false;
  lockSha = sha;
  return true;
}
function releaseLock() {
  if (!lockSha) return;
  // Unfinished cards (landing still pending): keep the lock stamped with them, so the run
  // that takes it over once stale lands or hands them back (recoverOrphans).
  if (openCards.size) {
    try { if (lockPush(lockCommit(R.lockMessage(new Date().toISOString(), [...openCards], 'released')), lockSha)) lockSha = null; } catch { /* stale stamp still names them */ }
    return;
  }
  try { if (lockPush(lockCommit('unlocked'), lockSha)) lockSha = null; } catch { /* stale after 11h anyway */ }
}

// The card claimed right now, so a kill (routine timeout, container stop) can hand it back.
let current = null;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (current && !OPTS.dryRun) {
      const back = sh('node', ['scripts/linear-brain.js', 'update', current, '--state', 'Todo', '--comment',
        `## Codex runner: stopped (${sig}) mid-card\n\nNothing was landed for this card. Back to Todo.`], { timeoutMs: 600_000 });
      if (back.code === 0) openCards.delete(current); // else it stays named in the released lock
    }
    log(`killed by ${sig}${current ? `; ${current} returned to Todo` : ''}`);
    releaseLock();
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
  if (!OPTS.dryRun) {
    const held = takeLock();
    if (held) { log(`not starting: ${held}`); return; }
  }
  // Re-stamp while waiting on slow steps (landings, in-flight slots), so a long healthy run
  // never looks stale to the next one.
  const keepAlive = OPTS.dryRun ? null : setInterval(() => { try { refreshLock(); } catch { /* next tick */ } }, 30 * 60_000);
  try { await runLocked(startedMs); } finally { if (keepAlive) clearInterval(keepAlive); releaseLock(); }
}

/** Close cards whose runner commit reached main after an earlier run stopped waiting (left In Progress). */
async function reconcileLanded(stats) {
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
      if (git(['ls-remote', 'origin', `refs/heads/${ref}`]) !== '') {
        git(['fetch', '-q', 'origin', `refs/heads/${ref}`]);
        landRefMs = Number(git(['log', '-1', '--format=%ct', 'FETCH_HEAD'])) * 1000;
      }
    } catch { /* treat as no landing */ }
    const action = R.orphanAction({
      stateName: issue && issue.state && issue.state.name,
      startedAtMs: issue && issue.startedAt ? Date.parse(issue.startedAt) : NaN,
      lockMs: orphanLockMs, onMain: issue && issue.startedAt ? landedOnMain(id, Date.parse(issue.startedAt)) : false, landRefMs,
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
      handled = (await moveCard(id, 'Todo', '## Codex runner: stopped mid-card\n\nAn earlier run ended (its session stopped) before finishing this card, and nothing reached main. Back to Todo.')).code === 0;
    }
    if (handled) openCards.delete(id);
  }
  try { refreshLock(); } catch { /* next stamp covers it */ }
}

async function runLocked(startedMs) {
  const stats = { claimed: [], landed: [], landedPartial: [], alreadyFixed: [], bounced: [], inReview: [], landFailed: [], crashed: [], wouldLand: [], rejectStreak: 0, doneRefusals: 0 };
  // Tidying an earlier run's cards needs only git and Linear, so it runs even without a Codex login.
  if (!OPTS.dryRun) { await reconcileLanded(stats); await recoverOrphans(stats); }
  const restore = sh('node', ['scripts/codex/auth-store.js', 'restore'], { timeoutMs: 900_000 });
  log(restore.out.trim());
  if (restore.code !== 0) {
    if (!OPTS.dryRun) await linearBrain(['update', RUNNER_CARD, '--comment', `## Codex runner did not start\n\nNo usable Codex login (it may have expired). Someone with the ChatGPT account must run \`codex login --device-auth\` in a cloud session, then \`node scripts/codex/auth-store.js save\`.\n\n${fence(tail(restore.out, 600))}`]);
    process.exitCode = 2;
    return;
  }
  const install = sh('node', ['scripts/codex/install.js']);
  if (install.code !== 0) log(`codex install warning: ${tail(install.out, 300)}`);
  setupWorktree();

  const inFlight = [];
  let worked = 0;
  let stop = null;
  for (const pick of await pickCards()) {
    if (worked >= OPTS.limit) break;
    stop = R.stopReason({ startedMs, nowMs: Date.now(), maxMinutes: OPTS.maxMinutes, weeklyPct: weeklyPct(), maxWeeklyPct: OPTS.maxWeeklyPct, rejectStreak: stats.rejectStreak, doneRefusals: stats.doneRefusals, checkSpentUsd, checkBudgetUsd: OPTS.checkBudgetUsd });
    if (!stop && stats.aborted) stop = stats.aborted;
    let held = true;
    try { held = refreshLock(); } catch { /* transient git error: the keep-alive retries */ }
    if (!stop && !OPTS.dryRun && !held) stop = 'another run took the lock';
    if (stop) { log(`stopping: ${stop}`); break; }
    try {
      if (await workCard(pick, stats, inFlight) === 'done') worked += 1;
    } catch (e) {
      log(`${pick.identifier}: error ${e && e.message ? e.message : e}`);
    }
  }
  await Promise.all(inFlight.map((e) => e.promise));
  if (!stop && stats.aborted) stop = stats.aborted;
  saveLogin();

  const mins = Math.round((Date.now() - startedMs) / 60_000);
  const list = (a) => (a.length ? a.join(', ') : 'none');
  const text = [
    `## Codex runner ${new Date().toISOString().slice(0, 10)}: ${worked} card(s) worked in ${mins} min`,
    `- Landed and Done: ${list(stats.landed)}`,
    `- Landed part, back to Todo with what is left: ${list(stats.landedPartial)}`,
    `- Already fixed, closed: ${list(stats.alreadyFixed)}`,
    `- Did not pass the Claude check, back to Todo: ${list(stats.bounced)}`,
    `- Landed but Done gate refused (In Review): ${list(stats.inReview)}`,
    `- Landing did not finish (left In Progress for resume): ${list(stats.landFailed)}`,
    `- Runner error mid-card (back to Todo): ${list(stats.crashed)}`,
    ...(stats.wouldLand.length ? [`- Passed, not landed (--no-land): ${list(stats.wouldLand)}`] : []),
    `- Codex weekly allowance used: ${weeklyPct() ?? 'unknown'}%`,
    `- Claude check: ${checkCount} review(s), $${checkSpentUsd.toFixed(2)} API cost`,
    `- Stopped early: ${stop || 'no'}`,
  ].join('\n');
  log(text);
  if (!OPTS.dryRun) await linearBrain(['update', RUNNER_CARD, '--comment', text]);
}

module.exports = { newLandFailures, provideData, takeLock, releaseLock, weeklyPct, recoverOrphans };
if (require.main === module) main().catch((e) => { log(`runner failed: ${e && e.stack ? e.stack : e}`); process.exit(1); });
