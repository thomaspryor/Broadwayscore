#!/usr/bin/env node
/**
 * land-fast-tests.js — the cheap part of the land gauntlet, run first (BRO-7150).
 *
 * land.yml's unit gates run ~3,400 test files for ~16-25 min, and most refusals come from a
 * handful of cheap repo-wide invariant tests (byte caps, generated-file freshness, registry
 * counts, plain-wording ratchets) or from tests that name the file a branch changed. On
 * 2026-11-08 two such refusals arrived after 31 and 19 minutes; each test runs in seconds.
 *
 * This module picks those tests for a diff:
 *   1. INVARIANT_TESTS: repo-wide tests that refused real lands (every test file behind 2+
 *      refusals in the 7 days to 2026-11-08, per `land-timing-report.js --json`, plus the
 *      two refusals of BRO-7131). They always run.
 *   2. Tests that name a changed file: its repo path, its basename, or a distinctive stem
 *      (8+ chars), and a changed test file itself.
 *   3. Tests that scan a changed file's directory as a literal ('.github/workflows', '.claude'),
 *      unless the directory is too broad to mean anything (scripts/, src/, tests/unit/).
 * Tiers 2-3 are kept in that order until MAX_TARGETED files; known-slow files are left to the
 * full gauntlet (SLOW_TESTS), so the run stays inside about a minute.
 *
 * Each picked file is mapped to its land gate (unit-tests-node, scripts-lib-tests,
 * unit-tests-tsx), so the same list can scope land-gauntlet.sh (GAUNTLET_SCOPE_DIR) in land.yml
 * and drive the local pre-push run (land-preflight.mjs), judged the same way: a failure counts
 * only when the base passes it (land-gate-delta.js parseGateFailures).
 *
 * CLI:
 *   node scripts/lib/land-fast-tests.js select --base B [--tip T] [--scope-dir D] [--profile ci|local] [--json]
 *       print (or write <gate>.files into D and print the gate list) the picked tests
 *   node scripts/lib/land-fast-tests.js run --base B [--tip HEAD] [--profile local|ci] [--json]
 *       run them on T (this checkout when it is T and clean, else a throwaway worktree), re-run red
 *       files on B in a throwaway worktree, print the new failures.
 *       Exit 0 clean | 1 new failures | 2 usage | 3 could not judge
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// Repo-wide invariant tests behind real land refusals. Keep sorted; the test checks each exists.
// Refresh from the ranked causes in `node scripts/lib/land-timing-report.js --days=7 --json`
// (a test file that refused 2+ lands belongs here).
const INVARIANT_TESTS = [
  'scripts/V1-V3-dispatch-status.test.mjs',
  'scripts/audit-broadway-category-predicate.test.mjs',
  'scripts/audit-test-yml-lib-deps.test.mjs',
  'scripts/audit-toplevel-script-test-yml-coverage.test.mjs',
  'scripts/audit-venue-write-guard.test.mjs',
  'scripts/lib/api-fallback-writer-drift.test.mjs',
  'scripts/lib/core-data-merge-registry.test.mjs',
  'scripts/lib/core-data-registry-coverage.test.mjs',
  'scripts/lib/review-text-sidecars.test.mjs',
  'scripts/lib/run-push-audits.test.mjs',
  'scripts/lib/test-yml-manifest-paths.test.mjs',
  'scripts/tests/global-instructions.test.mjs',
  'scripts/tests/help-flag-safety-guard.test.mjs',
  'scripts/validate-workflow-dependencies.test.mjs',
  'tests/unit/audit-orphaned-audit-writes.test.mjs',
  'tests/unit/audit-push-retry-budgets-residual.test.mjs',
  'tests/unit/audit-script-wiring.test.mjs',
  'tests/unit/audit-writer.test.mjs',
  'tests/unit/count-plurals.test.mjs',
  'tests/unit/gemini-thinking-budget-guard.test.mjs',
  'tests/unit/morning-digest-quiet.test.mjs',
  'tests/unit/sanitize-venue-guard.test.mjs',
  'tests/unit/sibling-matchers-diacritics.test.mjs',
  'tests/unit/timeout-audit.test.mjs',
  'tests/unit/tmp-git-repo-teardown-retries.test.mjs',
  'tests/unit/workflow-secret-gaps-budget.test.mjs',
];

// Directories whose name, as a literal, says nothing about what a test reads.
const BROAD_DIRS = new Set(['.', 'scripts', 'scripts/lib', 'scripts/tests', 'src', 'src/lib', 'src/app', 'src/components',
  'src/config', 'tests', 'tests/unit', 'tests/e2e', 'data', 'public', 'docs', 'memory', 'cloud-memory', 'scripts/llm-scoring']);
// Stems so common they match half the suite.
const COMMON_STEMS = new Set(['index', 'package', 'shows', 'reviews', 'README', 'CLAUDE', 'MEMORY', 'utils', 'config', 'constants']);
// Test files that take 20s+ alone (measured 2026-11-08): left to the full gauntlet unless invariant.
const SLOW_TESTS = new Set([
  'scripts/lib/land-branch.test.mjs',
  'scripts/tests/gc-dry-run-parity.test.mjs',
  'scripts/tests/session-start-staleness.test.mjs',
  'scripts/tests/verify-edits-cloud-session-gates.test.mjs',
  'scripts/tests/verify-edits-scoring-gate.test.mjs',
  'tests/unit/linear-next.test.mjs',
  'tests/unit/pre-push-visual-gate.test.mjs',
  'tests/unit/push-via-git-api.test.mjs',
  'tests/unit/push-with-retry-abort-preserves-head.test.mjs',
  'tests/unit/rebuild-fast-push-retry.test.mjs',
  'tests/unit/validate-data-dry-run.test.mjs',
  'tests/unit/validate-data-push-refusal-sentinel.test.mjs',
  'tests/unit/verify-edits-prefix.test.mjs',
]);
// Invariants left out of the LOCAL run only: run-push-audits.test.mjs spends ~80s of its 87s
// running the push audits end-to-end, and scripts/hooks/pre-push already runs those audits on
// every push. land.yml's fast-fail step still runs it first.
const LOCAL_SKIP = new Set(['scripts/lib/run-push-audits.test.mjs']);
const MAX_TARGETED = 40;

const GATE_NODE = 'unit-tests-node';
const GATE_LIB = 'scripts-lib-tests';
const GATE_TSX = 'unit-tests-tsx';
const FAST_GATES = [GATE_NODE, GATE_LIB, GATE_TSX];

/** The land gate a test file runs in, or null when no fast gate runs it. */
function gateFor(file, { nodeSet, tsxSet }) {
  if (/^scripts\/lib\/[^/]+\.test\.mjs$/.test(file)) return GATE_LIB;
  if (nodeSet.has(file)) return GATE_NODE;
  if (tsxSet.has(file)) return GATE_TSX;
  return null;
}

/** Which tier a changed file pulls a test in at (lower is stronger), or null. */
function matchTier(changedFile, testFile, text) {
  if (changedFile === testFile) return { tier: 0, why: 'changed test' };
  if (text.includes(changedFile)) return { tier: 1, why: `names ${changedFile}` };
  const bn = path.basename(changedFile);
  if (bn.length >= 6 && text.includes(bn)) return { tier: 2, why: `names ${bn}` };
  const stem = bn.replace(/\.[^.]+$/, '').replace(/\.test$/, '');
  if (stem.length >= 8 && !COMMON_STEMS.has(stem) && text.includes(stem)) return { tier: 3, why: `names ${stem}` };
  const dir = path.dirname(changedFile);
  if (!BROAD_DIRS.has(dir) && ["'", '"', '`'].some((q) => text.includes(q + dir + q) || text.includes(q + dir + '/'))) return { tier: 4, why: `scans ${dir}/` };
  return null;
}

/**
 * -> { files: [{ file, gate, why }], skipped: { slow, overCap } }
 * changed: repo paths the branch changes; universe: { nodeSet, tsxSet, libFiles }; readText(file) -> source.
 */
// A diff wider than this makes targeted matching cost minutes (2,957 files took 139 s) for a set the
// cap would cut anyway: such a branch runs the invariants plus its own changed tests (BRO-7150).
const MAX_CHANGED_FOR_TARGETING = 300;

function selectFastTests({ changed, universe, readText, invariants = INVARIANT_TESTS, maxTargeted = MAX_TARGETED, slow = SLOW_TESTS, skip = new Set(), maxChanged = MAX_CHANGED_FOR_TARGETING }) {
  const wide = changed.length > maxChanged;
  const all = [...new Set([...universe.nodeSet, ...universe.tsxSet, ...universe.libFiles])].sort();
  const picked = new Map();
  for (const f of invariants) {
    if (skip.has(f) && !changed.includes(f)) continue;
    const gate = gateFor(f, universe);
    if (gate && all.includes(f)) picked.set(f, { file: f, gate, why: 'invariant', tier: -1 });
  }
  const targeted = [];
  for (const f of all) {
    if (picked.has(f)) continue;
    if (wide) { if (changed.includes(f)) targeted.push({ file: f, gate: gateFor(f, universe), tier: 0, why: 'changed test' }); continue; }
    let text;
    try { text = readText(f); } catch { continue; }
    let best = null;
    for (const c of changed) {
      const m = matchTier(c, f, text);
      if (m && (!best || m.tier < best.tier)) best = m;
      if (best && best.tier === 0) break;
    }
    if (best) targeted.push({ file: f, gate: gateFor(f, universe), ...best });
  }
  targeted.sort((a, b) => a.tier - b.tier || a.file.localeCompare(b.file));
  let slowSkipped = 0;
  let overCap = 0;
  for (const t of targeted) {
    if (!t.gate) continue;
    if ((slow.has(t.file) || skip.has(t.file)) && t.tier > 0) { slowSkipped++; continue; }
    if ([...picked.values()].filter((p) => p.tier >= 0).length >= maxTargeted) { overCap++; continue; }
    picked.set(t.file, t);
  }
  return { files: [...picked.values()].map(({ file, gate, why }) => ({ file, gate, why })), skipped: { slow: slowSkipped, overCap, wideDiff: wide ? changed.length : 0 } };
}

/** The tree's own test universe (the collector it ships, its tsx manifest, scripts/lib/*.test.mjs). */
function universeFor(root) {
  let nodeList = [];
  try {
    const C = require(path.join(root, 'scripts/lib/unit-test-collection.js'));
    nodeList = C.collectNodeUnitTests(root);
  } catch { /* an older tree: no node batch to scope */ }
  const tsxPath = path.join(root, 'tests/unit-test-manifest-tsx.txt');
  const tsx = fs.existsSync(tsxPath)
    ? fs.readFileSync(tsxPath, 'utf8').split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter((l) => l && !l.startsWith('#'))
    : [];
  const libDir = path.join(root, 'scripts/lib');
  const libFiles = fs.existsSync(libDir) ? fs.readdirSync(libDir).filter((f) => f.endsWith('.test.mjs')).map((f) => `scripts/lib/${f}`) : [];
  return { nodeSet: new Set(nodeList), tsxSet: new Set(tsx), libFiles };
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status === null ? 1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function changedFiles(cwd, base, tip) {
  const r = git(cwd, ['diff', '--name-only', '--no-renames', `${base}...${tip}`]);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

/** Select for <root> at base...tip. -> selection (see selectFastTests) or null when the diff fails. */
function selectForTree(root, base, tip, { profile = 'ci' } = {}) {
  const changed = changedFiles(root, base, tip);
  if (!changed) return null;
  const universe = universeFor(root);
  const skip = profile === 'local' ? LOCAL_SKIP : new Set();
  return { changed, ...selectFastTests({ changed, universe, skip, readText: (f) => fs.readFileSync(path.join(root, f), 'utf8') }) };
}

/** Write <dir>/<gate>.files (land-gauntlet.sh GAUNTLET_SCOPE_DIR) -> the gates with any file. */
function writeScopeDir(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const gates = [];
  for (const g of FAST_GATES) {
    const list = files.filter((f) => f.gate === g).map((f) => f.file);
    if (!list.length) continue;
    fs.writeFileSync(path.join(dir, `${g}.files`), list.join('\n') + '\n');
    gates.push(g);
  }
  return gates;
}

/** Run one gate's files with land-gauntlet.sh's runner for that gate -> Promise<{ exit, text, ms }> (exit 124 = timed out). */
// BRO-7150 review: the pre-push hook kills this CLI on its own timeout (SIGTERM). Without a handler the
// detached test groups and the throwaway worktree outlive it, so each is registered here and torn down.
const liveGroups = new Set();
const liveCleanups = new Set();
function onTerm(sig) {
  for (const pid of liveGroups) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const fn of liveCleanups) { try { fn(); } catch { /* best effort */ } }
  process.exit(sig === 'SIGINT' ? 130 : 143);
}
let termHooked = false;
function hookTerm() {
  if (termHooked) return;
  termHooked = true;
  process.once('SIGTERM', () => onTerm('SIGTERM'));
  process.once('SIGINT', () => onTerm('SIGINT'));
}

function runGateFiles(root, gate, files, { timeoutMs = 240000, env = process.env } = {}) {
  const common = ['--test', '--test-reporter=tap', '--test-timeout', '300000', ...files];
  const [cmd, args] = gate === GATE_TSX ? ['npx', ['tsx', ...common]] : ['node', common];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env: { ...env, BSC_STAGE_LATENCY_MUTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid) liveGroups.add(child.pid);
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    let timedOut = false;
    // Kill the whole group: node --test's per-file children would otherwise keep the pipes (and 'close') open.
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    child.on('close', (code) => {
      liveGroups.delete(child.pid);
      clearTimeout(timer);
      resolve({ exit: timedOut || code === null ? 124 : code, text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit: 127, text: String(e.message), ms: Date.now() - t0 }); });
  });
}

/** gate -> Map(key -> {file,name}) of failures, via land-gate-delta.js's own parser. */
function failuresOf(gate, text, root) {
  const { parseGateFailures } = require('./land-gate-delta.js');
  return parseGateFailures(gate, text, root);
}

/**
 * Run the selection on <root> (the tip, as checked out) and, for red files, on <base> in a
 * throwaway worktree. -> { status: 'clean'|'fail'|'skip', newFailures: [{gate,file,name}], ran, ms, reason? }
 */
/**
 * Async twin of land-local-check.js withBaseWorktree: run await fn(dir) on <sha> in a throwaway
 * detached worktree (ignored paths such as node_modules and core data symlinked in), then remove it.
 */
async function withWorktree(root, sha, fn) {
  const { linkIgnored } = require('./land-local-check.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'land-fast-')), 'wt');
  git(root, ['worktree', 'prune']);
  const add = git(root, ['worktree', 'add', '--detach', '-f', dir, sha]);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
  const links = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Unlink exactly what was linked first: remove --force must not follow the links into real data.
    for (const p of links) {
      try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* absent */ }
    }
    git(root, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    git(root, ['worktree', 'prune']);
  };
  liveCleanups.add(cleanup);
  try {
    linkIgnored(root, dir, links);
    return await fn(dir);
  } finally {
    liveCleanups.delete(cleanup);
    cleanup();
  }
}

async function runFast({ root, base, selection, withBase = null, timeoutMs = 240000 }) {
  const t0 = Date.now();
  const byGate = new Map();
  for (const f of selection.files) {
    if (!byGate.has(f.gate)) byGate.set(f.gate, []);
    byGate.get(f.gate).push(f.file);
  }
  const done = (status, extra) => ({ status, newFailures: [], ran: selection.files.length, ms: Date.now() - t0, ...extra });
  let tipMs = null;
  // The gates run side by side; each node --test already runs its files in parallel.
  const results = await Promise.all([...byGate].map(async ([gate, files]) => ({ gate, ...(await runGateFiles(root, gate, files, { timeoutMs })) })));
  tipMs = Date.now() - t0;
  const red = [];
  for (const r of results) {
    if (r.exit === 124) return done('skip', { reason: `${r.gate} timed out` });
    const fails = failuresOf(r.gate, r.text, root);
    if (r.exit !== 0 && fails.size === 0) return done('skip', { reason: `${r.gate} exited ${r.exit} with no parsable failure` });
    for (const f of fails.values()) red.push({ gate: r.gate, file: f.file, name: f.name });
  }
  if (!red.length) return done('clean', { tipMs });
  // A failure already red on base is not this branch's (land.yml judges new failures only).
  const baseRun = withBase || ((sha, fn) => withWorktree(ROOT, sha, fn));
  const onBase = new Set();
  try {
    await baseRun(base, async (wt) => {
      const gates = new Map();
      for (const r of red) {
        if (!fs.existsSync(path.join(wt, r.file))) continue; // a file new on the branch: its failures are new
        if (!gates.has(r.gate)) gates.set(r.gate, new Set());
        gates.get(r.gate).add(r.file);
      }
      await Promise.all([...gates].map(async ([gate, files]) => {
        const r = await runGateFiles(wt, gate, [...files], { timeoutMs });
        // A base run that timed out proves nothing; counting its files as new would refuse a clean branch.
        if (r.exit === 124) throw new Error(`${gate} timed out on base`);
        const fails = failuresOf(gate, r.text, wt);
        // A base crash with nothing parsed proves nothing either: skip rather than refuse (BRO-7150 review).
        if (r.exit !== 0 && fails.size === 0) throw new Error(`${gate} exited ${r.exit} on base with no parsable failure`);
        for (const f of fails.values()) onBase.add(`${gate}|${f.file}::${f.name}`);
      }));
    });
  } catch (e) {
    return done('skip', { reason: `base re-run failed: ${e.message}` });
  }
  const newFailures = red.filter((r) => !onBase.has(`${r.gate}|${r.file}::${r.name}`));
  return done(newFailures.length ? 'fail' : 'clean', { newFailures, tipMs, reason: newFailures.length ? undefined : 'failures also red on base' });
}

function parseArgs(argv) {
  const o = { cmd: argv[0], base: null, tip: 'HEAD', scopeDir: null, json: false, profile: argv[0] === 'run' ? 'local' : 'ci', timeoutMs: 240000, worktree: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--tip') o.tip = argv[++i];
    else if (a === '--scope-dir') o.scopeDir = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--worktree') o.worktree = true; // always judge in a throwaway worktree (the pre-push hook)
    else if (a === '--timeout-ms') { o.timeoutMs = Number(argv[++i]); if (!(o.timeoutMs > 0)) return { error: '--timeout-ms must be positive' }; }
    else if (a === '--profile') { o.profile = argv[++i]; if (!['ci', 'local'].includes(o.profile)) return { error: '--profile must be ci or local' }; }
    else return { error: `unknown argument: ${a}` };
  }
  if (!['select', 'run'].includes(o.cmd)) return { error: 'first argument must be select or run' };
  if (!o.base) return { error: '--base is required' };
  return o;
}

/**
 * BRO-7150: land.yml's rebase (base's scripts/lib/land-rebase.sh, refresh_generated_docs) regenerates a stale
 * .github/workflows/DEPENDENCIES.md before the tests run, so a throwaway worktree judged here does the same;
 * otherwise its freshness test would refuse a push the land accepts. Working tree only, never committed.
 */
function mirrorLandRegeneration(root, base) {
  const helper = git(root, ['show', `${base}:scripts/lib/land-rebase.sh`]);
  if (helper.code !== 0 || !helper.stdout.includes('refresh_generated_docs')) return false;
  const gen = path.join(root, 'scripts', 'generate-workflow-dependencies.js');
  if (!fs.existsSync(gen)) return false;
  if (spawnSync(process.execPath, [gen, '--check'], { cwd: root, stdio: 'ignore', timeout: 60000 }).status === 0) return false;
  return spawnSync(process.execPath, [gen], { cwd: root, stdio: 'ignore', timeout: 60000 }).status === 0;
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`land-fast-tests: ${o.error}`); return 2; }
  if (o.cmd === 'select') {
    const sel = selectForTree(ROOT, o.base, o.tip, { profile: o.profile });
    if (!sel) { console.error(`land-fast-tests: git diff ${o.base}...${o.tip} failed`); return 3; }
    const gates = o.scopeDir ? writeScopeDir(o.scopeDir, sel.files) : [...new Set(sel.files.map((f) => f.gate))];
    if (o.json) console.log(JSON.stringify({ gates, ...sel }, null, 2));
    else {
      console.log(gates.join(','));
      console.error(`land-fast-tests: ${sel.files.length} test file(s) for ${sel.changed.length} changed file(s) (skipped: ${sel.skipped.slow} slow, ${sel.skipped.overCap} over the cap)`);
    }
    return 0;
  }
  const head = git(ROOT, ['rev-parse', 'HEAD']).stdout;
  const tip = git(ROOT, ['rev-parse', '--verify', '-q', `${o.tip}^{commit}`]).stdout;
  if (!tip) { console.error(`land-fast-tests: unknown --tip ${o.tip}`); return 3; }
  const clean = !git(ROOT, ['status', '--porcelain', '--untracked-files=no']).stdout;
  const judge = async (root) => {
    if (root !== ROOT) mirrorLandRegeneration(root, o.base);
    const sel = selectForTree(root, o.base, tip, { profile: o.profile });
    if (!sel) return { status: 'skip', reason: `git diff ${o.base}...${tip} failed`, newFailures: [], ran: 0, ms: 0 };
    return runFast({ root, base: o.base, selection: sel, timeoutMs: o.timeoutMs });
  };
  let res;
  try {
    // This checkout when it is the tip as committed; else (a replay, uncommitted edits) a throwaway worktree.
    res = head === tip && clean && !o.worktree ? await judge(ROOT) : await withWorktree(ROOT, tip, judge);
  } catch (e) {
    res = { status: 'skip', reason: e.message, newFailures: [], ran: 0, ms: 0 };
  }
  if (o.json) console.log(JSON.stringify(res, null, 2));
  else {
    const phases = res.tipMs != null && res.tipMs !== res.ms ? ` (tip ${Math.round(res.tipMs / 1000)}s, base re-check ${Math.round((res.ms - res.tipMs) / 1000)}s)` : '';
    console.log(`land-fast-tests: ${res.status} — ${res.ran} file(s) in ${Math.round(res.ms / 1000)}s${phases}${res.reason ? ` (${res.reason})` : ''}`);
    for (const f of res.newFailures) console.log(`  NEW ${f.gate}: ${f.file}::${f.name}`);
  }
  return res.status === 'fail' ? 1 : res.status === 'skip' ? 3 : 0;
}

module.exports = { MAX_CHANGED_FOR_TARGETING, LOCAL_SKIP, withWorktree, mirrorLandRegeneration, INVARIANT_TESTS, BROAD_DIRS, SLOW_TESTS, MAX_TARGETED, FAST_GATES, gateFor, matchTier, selectFastTests, universeFor, selectForTree, writeScopeDir, runFast, changedFiles, parseArgs };

if (require.main === module) { hookTerm(); main().then((code) => { process.exitCode = code; }); }
