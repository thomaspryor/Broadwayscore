#!/usr/bin/env node
'use strict';
/**
 * cloud-doctor.js (BRO-5892): the first command of a cloud session. Checks that the session can do a data
 * fix end to end, and with --fix repairs what it can by calling the scripts that own each piece
 * (cloud-bootstrap-data.sh's clean-only clone refresh, setup-local-data.sh, npm ci, install-home-claude-config.js).
 *
 * Usage: node scripts/cloud-doctor.js [--check | --fix] [--quick] [--json]
 *   --check  (default) report only. --fix  repair, then report again.
 *   --quick  skip the slow check that a read-only audit (validate-data.js, about 2 min) leaves the tree clean.
 * Exit 0 nothing failed (warnings allowed), 1 a check failed, 2 bad usage.
 *
 * Severity: missing data, data older than STALE_FAIL_HOURS, unresolvable deps, no push access => fail.
 * A clone a few commits behind origin, or data/ copies behind their clone => warn (bots push every few minutes).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { stalePlans, readPlans, describeStale } = require('./lib/pending-fixes-stale-check');

const ROOT = path.join(__dirname, '..');
const REPO = 'thomaspryor/Broadwayscore';
const STALE_FAIL_HOURS = 6;
const USAGE = 'Usage: node scripts/cloud-doctor.js [--check | --fix] [--quick] [--json]';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 60000, cwd: opts.cwd || ROOT, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const git = (dir, ...args) => sh('git', ['-C', dir, ...args]);
const readTrim = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };

/** The main checkout behind a linked worktree (or ROOT itself). */
function mainCheckout(root = ROOT) {
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').out;
  return common ? path.dirname(common) : root;
}

function cloneFacts(dir) {
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return null;
  const head = git(dir, 'rev-parse', 'HEAD').out || null;
  const date = git(dir, 'log', '-1', '--format=%cI').out || null;
  const remote = git(dir, 'ls-remote', 'origin', 'refs/heads/main');
  return { dir, head, date, remoteHead: remote.code === 0 ? (remote.out.split(/\s/)[0] || null) : null };
}

function attachedClone(name) {
  for (const d of [path.dirname(mainCheckout()), process.env.BSC_ATTACHED_REPOS_DIR || '/home/user']) {
    if (fs.existsSync(path.join(d, name, '.git'))) return path.join(d, name);
  }
  return null;
}

/** Everything the checks look at. Impure; evaluate() is the pure half. */
function gather({ quick }) {
  const home = process.env.HOME || '/root';
  const main = mainCheckout();
  const facts = {
    cloud: process.env.CLAUDE_CODE_REMOTE === 'true',
    root: ROOT,
    main,
    // $HOME is not always /home/user (this session: HOME=/root, repos attached under /home/user, BRO-5386):
    // prefer the session-start clone under $HOME, else the attached one.
    coreClone: cloneFacts(fs.existsSync(path.join(home, 'broadway-scorecard-data', '.git'))
      ? path.join(home, 'broadway-scorecard-data') : attachedClone('broadway-scorecard-data')),
    reviewClone: cloneFacts(attachedClone('broadway-review-texts')),
  };
  const dataDir = fs.realpathSync.native(path.join(ROOT, 'data'));
  facts.showsJson = fs.existsSync(path.join(ROOT, 'data', 'shows.json'));
  facts.coreSymlink = (() => { try { return fs.lstatSync(path.join(ROOT, 'data', 'shows.json')).isSymbolicLink(); } catch { return false; } })();
  facts.coreCopySha = readTrim(path.join(dataDir, '.core-data-sha'));
  // A worktree's data/review-texts links to the main checkout's copy; read the marker through the link.
  const rtDir = path.join(ROOT, 'data', 'review-texts');
  facts.reviewCopySha = readTrim(path.join(rtDir, '.review-texts-sha'));
  facts.reviewCopyIsCheckout = fs.existsSync(path.join(rtDir, '.git'));
  try {
    delete require.cache[require.resolve('./lib/review-texts-dir')];
    const dir = require('./lib/review-texts-dir').resolveReviewTextsDir();
    facts.resolvedReviewTexts = dir && fs.existsSync(dir) && fs.readdirSync(dir).some((e) => !e.startsWith('.')) ? dir : null;
  } catch { facts.resolvedReviewTexts = null; }
  facts.deps = {};
  for (const m of ['next/package.json', 'cheerio', 'typescript/package.json']) {
    try { require.resolve(m, { paths: [ROOT] }); facts.deps[m] = true; } catch { facts.deps[m] = false; }
  }
  const repo = sh('gh', ['api', `repos/${REPO}`, '--jq', '.permissions.push']);
  facts.ghPush = repo.code === 0 ? repo.out === 'true' : null;
  facts.ghError = repo.code === 0 ? null : (repo.err || repo.out).split('\n').pop();
  const wf = sh('gh', ['api', `repos/${REPO}/actions/workflows/execute-approved-fix.yml`, '--jq', '.state']);
  facts.fixWorkflowState = wf.code === 0 ? wf.out : null;
  facts.stalePendingPlans = stalePlans(readPlans(path.join(ROOT, 'data', 'pending-fixes')));
  facts.secretsOk = sh('node', [path.join(ROOT, 'scripts', 'check-cloud-secrets.js')]).code === 0;
  // Run from the main checkout: from a worktree it compares against the worktree and misreports DRIFT.
  const hooks = sh('node', [path.join(main, 'scripts', 'install-home-claude-config.js'), '--check'], { cwd: main });
  facts.hooks = { ok: hooks.code === 0, detail: (hooks.out || hooks.err).split('\n').slice(-1)[0] };
  // Only in cloud: on a Mac validate-data.js still writes by design, so running it here would edit data.
  if (!quick && facts.cloud) facts.auditTreeClean = auditLeavesTreeClean();
  return facts;
}

/**
 * size+mtime of every file under data/ except the review texts. data/*.json core copies are gitignored, so
 * `git status` alone cannot see an audit rewriting them, which is the write this check exists to catch.
 */
function dataSnapshot(dir = path.join(ROOT, 'data'), rel = 'data', out = new Map()) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = `${rel}/${e.name}`;
    if (r === 'data/review-texts') continue;
    if (e.isDirectory()) dataSnapshot(path.join(dir, e.name), r, out);
    else if (e.isFile() || e.isSymbolicLink()) {
      try { const st = fs.statSync(path.join(dir, e.name)); out.set(r, `${st.size}:${st.mtimeMs}`); } catch { /* raced away */ }
    }
  }
  return out;
}

/** Pure: two snapshots -> paths added, removed or rewritten. */
function snapshotChanges(before, after) {
  const changed = [];
  for (const [k, v] of after) if (before.get(k) !== v) changed.push(k);
  for (const k of before.keys()) if (!after.has(k)) changed.push(k);
  return changed.sort();
}

function auditLeavesTreeClean() {
  const status = () => git(ROOT, 'status', '--porcelain', '--untracked-files=no').out;
  const before = status();
  const dataBefore = dataSnapshot();
  const run = sh('node', [path.join(ROOT, 'scripts', 'validate-data.js')], { timeout: 6 * 60 * 1000 });
  const after = status();
  const tracked = after.split('\n').filter((l) => l && !before.split('\n').includes(l));
  const changed = [...new Set([...tracked, ...snapshotChanges(dataBefore, dataSnapshot())])];
  return { clean: changed.length === 0, changed, exit: run.code };
}

function ageHours(iso, now) { return iso ? (now - new Date(iso).getTime()) / 3.6e6 : Infinity; }

/** Pure: facts -> [{ id, level: 'ok'|'warn'|'fail', detail, fix }] where fix names a repair in FIXES. */
function evaluate(f, { now = Date.now() } = {}) {
  const out = [];
  const add = (id, level, detail, fix = null) => out.push({ id, level, detail, fix });

  for (const [id, c, label] of [['core-clone', f.coreClone, '~/broadway-scorecard-data'], ['review-clone', f.reviewClone, 'attached broadway-review-texts']]) {
    if (!c) { add(id, f.cloud ? 'fail' : 'warn', `${label} clone not found${id === 'review-clone' ? ' (attach the repo to the session)' : ''}`); continue; }
    const age = ageHours(c.date, now);
    if (c.remoteHead && c.head === c.remoteHead) add(id, 'ok', `${label} at origin/main ${c.head.slice(0, 9)}`);
    else if (age > STALE_FAIL_HOURS) add(id, 'fail', `${label} is ${age.toFixed(1)}h old${c.remoteHead ? '' : ' (origin unreachable)'}`, 'refresh-clones');
    else add(id, 'warn', `${label} ${c.remoteHead ? 'behind origin/main' : 'not compared (origin unreachable)'}, last commit ${age.toFixed(1)}h ago`, c.remoteHead ? 'refresh-clones' : null);
  }

  if (!f.showsJson) add('core-copy', 'fail', 'data/shows.json missing', 'copy-data');
  else if (f.coreSymlink) add('core-copy', 'ok', 'data/ core files are symlinks into the clone');
  else if (f.coreClone && f.coreCopySha && f.coreCopySha !== f.coreClone.head) add('core-copy', 'warn', `data/ core copies at ${f.coreCopySha.slice(0, 9)}, clone at ${f.coreClone.head.slice(0, 9)}`, 'copy-data');
  else add('core-copy', 'ok', `data/ core copies ${f.coreCopySha ? `at ${f.coreCopySha.slice(0, 9)}` : 'present'}`);

  if (f.reviewCopyIsCheckout) add('review-copy', 'ok', 'data/review-texts is a git checkout');
  else if (!f.reviewCopySha) add('review-copy', f.reviewClone ? 'fail' : 'warn', 'data/review-texts missing or unstamped (no .review-texts-sha)', f.reviewClone ? 'copy-review-texts' : null);
  else if (f.reviewClone && f.reviewCopySha !== f.reviewClone.head) add('review-copy', 'warn', `data/review-texts at ${f.reviewCopySha.slice(0, 9)}, clone at ${f.reviewClone.head.slice(0, 9)}`, 'copy-review-texts');
  else add('review-copy', 'ok', `data/review-texts at ${f.reviewCopySha.slice(0, 9)}`);

  add('review-resolver', f.resolvedReviewTexts ? 'ok' : 'fail', f.resolvedReviewTexts ? `resolveReviewTextsDir() -> ${f.resolvedReviewTexts}` : 'resolveReviewTextsDir() finds no review texts', f.resolvedReviewTexts ? null : 'copy-review-texts');

  const missing = Object.entries(f.deps || {}).filter(([, ok]) => !ok).map(([m]) => m.replace('/package.json', ''));
  add('node-modules', missing.length ? 'fail' : 'ok', missing.length ? `cannot resolve ${missing.join(', ')} (partial install)` : 'next, cheerio, typescript resolve', missing.length ? 'npm-ci' : null);

  if (f.ghPush === true) add('github', f.fixWorkflowState === 'active' ? 'ok' : 'fail', f.fixWorkflowState === 'active' ? 'REST push access; execute-approved-fix.yml active' : `execute-approved-fix.yml state: ${f.fixWorkflowState || 'unreadable'}`);
  else add('github', 'fail', f.ghPush === false ? 'no push permission on the repo' : `gh api failed: ${f.ghError}`);

  add('secrets', f.secretsOk ? 'ok' : 'warn', f.secretsOk ? 'Tier 1 secrets present' : 'Tier 1 secrets missing (node scripts/check-cloud-secrets.js)');
  add('hooks', f.hooks && f.hooks.ok ? 'ok' : 'warn', (f.hooks && f.hooks.detail) || 'install-home-claude-config --check did not run', f.hooks && f.hooks.ok ? null : 'install-hooks');

  if (f.stalePendingPlans) {
    const d = describeStale(f.stalePendingPlans);
    add('pending-fixes', d ? 'warn' : 'ok', d || 'no unresolved fix plan older than 7 days');
  }

  if (f.auditTreeClean) {
    const a = f.auditTreeClean;
    add('audit-tree-clean', a.clean ? 'ok' : 'fail', a.clean ? `validate-data.js left the tree clean (exit ${a.exit})` : `validate-data.js modified: ${a.changed.join('; ')}`);
  }
  return out;
}

const FIXES = {
  // cloud-bootstrap-data.sh refreshes ~/broadway-scorecard-data only when core_clone_local_work says a reset is safe.
  'refresh-clones': (f) => {
    sh('bash', [path.join(ROOT, 'scripts', 'cloud-bootstrap-data.sh')], { timeout: 6 * 60 * 1000, env: { BSC_SESSION_EVENT: 'startup' } });
    if (f.reviewClone) {
      const guard = path.join(ROOT, 'scripts', 'lib', 'core-data-clone-guard.sh');
      sh('bash', ['-c', `. "${guard}"; if why="$(core_clone_local_work "$1")"; then echo "not refreshing $1: $why" >&2; exit 1; fi; git -C "$1" fetch -q --depth 1 origin main && git -C "$1" reset -q --hard FETCH_HEAD`, '_', f.reviewClone.dir], { timeout: 5 * 60 * 1000 });
    }
  },
  'copy-data': () => sh('bash', [path.join(ROOT, 'scripts', 'setup-local-data.sh'), '--link-only'], { timeout: 5 * 60 * 1000 }),
  // In a worktree, --link-only first points data/review-texts at the main checkout's copy, so --all fills that one.
  'copy-review-texts': (f) => {
    if (!f.reviewClone) return;
    if (f.main !== ROOT) sh('bash', [path.join(ROOT, 'scripts', 'setup-local-data.sh'), '--link-only'], { timeout: 5 * 60 * 1000 });
    sh('bash', [path.join(ROOT, 'scripts', 'setup-local-data.sh'), '--all'], { timeout: 10 * 60 * 1000, env: { REVIEW_TEXTS_SOURCE: f.reviewClone.dir } });
  },
  // node_modules in a worktree is a link to the main checkout's; repair the install there.
  'npm-ci': (f) => sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: f.main, timeout: 15 * 60 * 1000 }),
  'install-hooks': (f) => sh('node', [path.join(f.main, 'scripts', 'install-home-claude-config.js')], { cwd: f.main }),
};
// Order matters: clones before copies of them.
const FIX_ORDER = ['refresh-clones', 'copy-data', 'copy-review-texts', 'npm-ci', 'install-hooks'];

/** Pure: which repairs to run, in order. A clone refresh moves the clones, so the copies are redone after it. */
function plannedFixes(results) {
  const wanted = new Set(results.filter((r) => r.level !== 'ok' && r.fix).map((r) => r.fix));
  if (wanted.has('refresh-clones')) { wanted.add('copy-data'); wanted.add('copy-review-texts'); }
  return FIX_ORDER.filter((k) => wanted.has(k));
}

function report(results, json) {
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }
  const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  for (const r of results) console.log(`${mark[r.level]} ${r.id.padEnd(17)} ${r.detail}${r.level !== 'ok' && r.fix ? `  [--fix: ${r.fix}]` : ''}`);
}

function main(argv) {
  if (argv.some((a) => !['--check', '--fix', '--quick', '--json'].includes(a))) { console.error(USAGE); return 2; }
  const quick = argv.includes('--quick');
  const json = argv.includes('--json');
  let facts = gather({ quick });
  let results = evaluate(facts);
  if (argv.includes('--fix')) {
    const fixes = plannedFixes(results);
    for (const k of fixes) { if (!json) console.log(`fixing: ${k}`); FIXES[k](facts); }
    if (fixes.length) { facts = gather({ quick }); results = evaluate(facts); }
  }
  report(results, json);
  const failed = results.filter((r) => r.level === 'fail');
  if (!json) console.log(failed.length ? `\n${failed.length} check(s) failed.` : '\nCloud session ready for data fixes.');
  return failed.length ? 1 : 0;
}

module.exports = { evaluate, plannedFixes, snapshotChanges, STALE_FAIL_HOURS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (require('./lib/cli-help').hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
  process.exit(main(argv));
}
