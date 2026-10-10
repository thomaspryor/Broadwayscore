#!/usr/bin/env node
// land-preflight.mjs — predict, in seconds and before the push, the two
// land.yml refusals that cost BRO-4558 two ~30-minute cycles (BRO-4593):
//
//   A. the land rebase conflicts. land-rebase.sh runs a plain `git rebase
//      BASE`, which drops merge commits and replays the branch's own commits,
//      so a conflict that was resolved inside a merge of main comes back
//      (land run 37182544195).
//   B. a tests/unit (or scripts/) test file the branch added is in no
//      manifest, or a file the branch deleted is still listed
//      (land run 37184867156).
//
// Both checks only ever block on what THIS branch changed (land.yml judges new
// failures vs base, so a red that is already on main must not block here), and
// anything the check cannot judge (shallow history, old git, partial-clone
// fetch failure, huge range) is a SKIP, never a block.
//
// Entry points:
//   node scripts/lib/land-preflight.mjs --tip <rev> [--base origin/main] [--no-fetch] [--cwd dir]
//       manual / scripts/merge-worktree-to-main.sh. Exit 0 clean or skip, 1 would be refused.
//   node scripts/lib/land-preflight.mjs --hook   (PreToolUse JSON on stdin)
//       used by .claude/hooks/pre-push-land-preflight.sh. Exit 2 + stderr = block.
//
// The rebase simulation must agree with scripts/lib/land-rebase.sh; the
// parity test in tests/unit/land-preflight.test.mjs runs both on the same
// fixtures. Change one, change the other.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { landPushTargets } from './push-command.mjs';

const require = createRequire(import.meta.url);
const { isPromisorFetchFailure } = require('./promisor-fetch-failure.js');

export const MAX_COMMITS = 200;
const BYPASS_RE = /#\s*NO-LAND-PREFLIGHT:\s*(\S.{14,})/;
// A fixed identity so the simulated commits never depend on (or fail for lack
// of) the session's git config. They are unreferenced objects, gc'd normally.
const SIM_ENV = {
  GIT_AUTHOR_NAME: 'land-preflight',
  GIT_AUTHOR_EMAIL: 'land-preflight@invalid',
  GIT_COMMITTER_NAME: 'land-preflight',
  GIT_COMMITTER_EMAIL: 'land-preflight@invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout || 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: r.error?.code === 'ETIMEDOUT' };
}

const ok = (r) => r.status === 0;
const out = (r) => r.stdout.trim();

/**
 * Would `git rebase base` with tip checked out conflict?
 * -> { status: 'clean' | 'conflict' | 'skip', commit?, files?, reason?, replayed? }
 */
export function previewRebase({ base, tip, cwd, maxCommits = MAX_COMMITS }) {
  const b = git(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  const t = git(cwd, ['rev-parse', '--verify', '--quiet', `${tip}^{commit}`]);
  if (!ok(b) || !ok(t)) return { status: 'skip', reason: `cannot resolve ${!ok(b) ? base : tip}` };
  const baseSha = out(b);
  const tipSha = out(t);
  if (!ok(git(cwd, ['merge-base', baseSha, tipSha]))) {
    return { status: 'skip', reason: 'no merge-base with the base (shallow clone boundary?)' };
  }
  if (ok(git(cwd, ['merge-base', '--is-ancestor', tipSha, baseSha]))) return { status: 'clean', replayed: 0 };
  // The commit list `git rebase` replays: non-merge, patch-equivalent
  // upstream commits dropped, oldest first.
  const list = git(cwd, ['rev-list', '--reverse', '--topo-order', '--no-merges', '--right-only', '--cherry-pick', `${baseSha}...${tipSha}`]);
  if (!ok(list)) return { status: 'skip', reason: `rev-list failed: ${list.stderr.trim().slice(0, 200)}` };
  const commits = out(list).split('\n').filter(Boolean);
  if (commits.length > maxCommits) return { status: 'skip', reason: `${commits.length} commits to replay (cap ${maxCommits})` };
  let cur = baseSha;
  let curTree = out(git(cwd, ['rev-parse', `${baseSha}^{tree}`]));
  for (const c of commits) {
    const parent = git(cwd, ['rev-parse', '--verify', '--quiet', `${c}^`]);
    if (!ok(parent)) return { status: 'skip', reason: `parent of ${c.slice(0, 10)} missing (shallow clone boundary?)` };
    const m = git(cwd, ['merge-tree', '--write-tree', '--name-only', `--merge-base=${out(parent)}`, cur, c], { timeout: 60000 });
    if (m.status === 1) {
      const lines = m.stdout.split('\n');
      // --name-only: line 1 is the tree, then conflicted paths, a blank line, then messages.
      const files = [];
      for (const l of lines.slice(1)) {
        if (!l.trim()) break;
        files.push(l.trim());
      }
      const subject = out(git(cwd, ['log', '-1', '--format=%h %s', c]));
      return { status: 'conflict', commit: subject, files: [...new Set(files)] };
    }
    if (m.status !== 0) {
      if (m.timedOut) return { status: 'skip', reason: 'merge-tree timed out' };
      if (isPromisorFetchFailure(m.stderr)) return { status: 'skip', reason: 'partial-clone lazy fetch failed during the preview' };
      return { status: 'skip', reason: `merge-tree exit ${m.status} (git >= 2.40 needed): ${m.stderr.trim().slice(0, 160)}` };
    }
    const tree = m.stdout.split('\n')[0].trim();
    if (tree === curTree) continue; // became empty: rebase drops it
    const msg = git(cwd, ['log', '-1', '--format=%B', c]).stdout || 'x';
    const ct = spawnSync('git', ['-C', cwd, 'commit-tree', tree, '-p', cur], {
      input: msg,
      encoding: 'utf8',
      env: { ...process.env, ...SIM_ENV },
    });
    if (ct.status !== 0) return { status: 'skip', reason: `commit-tree failed: ${(ct.stderr || '').trim().slice(0, 160)}` };
    cur = ct.stdout.trim();
    curTree = tree;
  }
  return { status: 'clean', replayed: commits.length };
}

const TEST_FILE_RE = /^(tests\/unit|scripts|scripts\/tests)\/[^/]+\.test\.(mjs|ts|tsx|js|cjs|sh)$/;
const MANIFEST_RE = /^tests\/(unit-test-manifest(-tsx)?|e2e-unit-test-manifest)\.txt$/;

/**
 * Branch-scoped test registration check, run against the working tree at
 * `cwd` (the caller guarantees it equals the pushed commit for these paths).
 * -> { status: 'clean' | 'fail' | 'skip', problems?: string[], reason? }
 */
export function checkTestRegistration({ base, tip, cwd }) {
  const diff = git(cwd, ['diff', '--name-status', '--no-renames', `${base}...${tip}`]);
  if (!ok(diff)) return { status: 'skip', reason: 'diff vs base failed' };
  const changed = [];
  const deleted = new Set();
  for (const line of out(diff).split('\n').filter(Boolean)) {
    const [st, p] = line.split('\t');
    changed.push(p);
    if (st === 'D') deleted.add(p);
  }
  const relevant = changed.filter((p) => TEST_FILE_RE.test(p) || MANIFEST_RE.test(p));
  if (relevant.length === 0) return { status: 'clean', reason: 'no test files or manifests changed' };
  const root = out(git(cwd, ['rev-parse', '--show-toplevel']));
  const problems = [];

  // 1. Added/changed test files that no manifest or workflow registers —
  //    the pushed tree's own copy of the CI audit, scoped to this branch.
  const audit = path.join(root, 'scripts', 'audit-orphan-tests.js');
  if (fs.existsSync(audit)) {
    const r = spawnSync('node', [audit, '--scope-stdin', '--json'], {
      cwd: root,
      input: changed.filter((p) => !deleted.has(p)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 45000,
    });
    if (r.status === 1) {
      // exit 1 is also what a crash looks like: only parseable JSON blocks.
      let report;
      try {
        report = JSON.parse(r.stdout);
      } catch {
        return { status: 'skip', reason: 'audit-orphan-tests.js exited 1 without JSON (crashed)' };
      }
      for (const x of report.blocking || []) {
        const f = typeof x === 'string' ? x : x.file;
        problems.push(`${f} is not listed in any test manifest or workflow (add it to tests/unit-test-manifest.txt, sorted)`);
      }
      // The audit also exits 1 on manifest problems (unsorted, duplicates) in manifests this branch touched.
      for (const m of report.manifestProblems || []) {
        problems.push(`${m.manifest}: ${m.error} (fix: node scripts/lib/test-manifest.js --fix)`);
      }
    } else if (r.status !== 0) {
      return { status: 'skip', reason: `audit-orphan-tests.js exit ${r.status}` };
    }
  }

  // 2. Manifest entries pointing at files this branch deleted.
  for (const m of ['tests/unit-test-manifest.txt', 'tests/unit-test-manifest-tsx.txt', 'tests/e2e-unit-test-manifest.txt']) {
    const mp = path.join(root, m);
    if (!fs.existsSync(mp)) continue;
    for (const entry of fs.readFileSync(mp, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (deleted.has(entry)) problems.push(`${m} still lists ${entry}, which this branch deletes (remove the line)`);
    }
  }
  return problems.length ? { status: 'fail', problems } : { status: 'clean' };
}

// Paths only the pipeline bots write. A land commit that rewrites many of them is
// almost always a squash taken over a failed or stale merge: `git reset --soft
// origin/main` after a merge that never happened makes ONE commit that reverts
// everything main gained since the branch point (BRO-4956, 2026-10-10: a 2-file
// fix went up as 179 files, 47k/107k lines, cancelled by hand before it landed).
export const BOT_OWNED_RE = /^(data\/audit\/|data\/collection-state\/|public\/data\/|data\/llm-scoring-runs\.json$)/;
export const BOT_OWNED_MAX = 10;

/** Does tip rewrite more bot-owned files than a deliberate change would? */
export function checkBotOwnedRewrite({ base, tip, cwd, max = BOT_OWNED_MAX }) {
  const r = git(cwd, ['diff', '--name-only', `${base}...${tip}`]);
  if (!ok(r)) return { status: 'skip', reason: (r.stderr || 'git diff failed').trim().slice(0, 200) };
  const files = out(r).split('\n').filter((f) => BOT_OWNED_RE.test(f));
  return files.length > max ? { status: 'fail', count: files.length, sample: files.slice(0, 5) } : { status: 'pass', count: files.length };
}

function fetchBase(cwd) {
  const r = git(cwd, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '-q', 'origin', 'main'], { timeout: 20000 });
  return ok(r) ? null : r.timedOut ? 'fetch timed out' : `fetch failed: ${r.stderr.trim().slice(0, 120)}`;
}

/** Paths under tests/ (or the manifests) that differ from HEAD in the working tree, untracked included. */
function testTreeDirty(cwd) {
  // The audit reads the working tree (tests, manifests and workflows), so any of
  // those differing from HEAD means its verdict would not describe the pushed commit.
  const r = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all', '--', 'tests', 'scripts', '.github/workflows']);
  const entries = (r.stdout || '').split('\0').filter(Boolean); // no trim: the status column can start with a space
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') paths.push(entries[++i]); // -z: rename source follows as its own entry
  }
  return paths.filter((p) => TEST_FILE_RE.test(p) || MANIFEST_RE.test(p) || p.startsWith('.github/workflows/'));
}

export function blockMessage({ target, rebase, tests, base, botOwned }) {
  const lines = [`LAND PREFLIGHT: land.yml would refuse this push to ${target}. Fix it on the branch and push again (about 30 minutes saved).`];
  if (rebase?.status === 'conflict') {
    lines.push(
      '',
      `1) The land rebase onto ${base} conflicts at commit "${rebase.commit}"` + (rebase.files.length ? ` in ${rebase.files.join(', ')}.` : '.'),
      '   land.yml runs a plain `git rebase origin/main`, which drops merge commits, so a conflict you resolved inside a merge of main comes back.',
      '   Fix (squash onto current main, in this order):',
      '     git fetch origin main && git merge origin/main      # resolve anything, commit',
      '     git diff origin/main --stat                         # must list ONLY your branch\'s files',
      '     git reset --soft origin/main && git commit -m "<one message for the whole change>"',
    );
  }
  if (tests?.status === 'fail') {
    lines.push('', `${rebase?.status === 'conflict' ? '2' : '1'}) Test registration (audit-orphan-tests / test-yml-manifest-paths would go red):`);
    for (const p of tests.problems) lines.push(`   - ${p}`);
  }
  if (botOwned?.status === 'fail') {
    lines.push(
      '',
      `* This push rewrites ${botOwned.count} bot-owned data files (${botOwned.sample.join(', ')}, ...).`,
      '   That is the signature of `git reset --soft origin/main` after a merge that failed or never ran: the',
      '   commit would REVERT everything main gained since your branch point. Rebuild it from current main:',
      '     git fetch origin main && git checkout -B <branch> origin/main',
      '     git checkout <old-tip> -- <only your files> && git commit',
    );
  }
  lines.push(
    '',
    'This is not a land refusal: do not route around it with mcp__github__create_branch or a land.yml dispatch.',
    'If you are certain it is wrong, add `# NO-LAND-PREFLIGHT: <reason, 15+ chars>` to the push command (logged).',
  );
  return lines.join('\n');
}

function logEvent(cwd, entry) {
  try {
    const common = out(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (!common) return;
    const file = path.join(path.dirname(common), '.claude', 'land-preflight.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* logging never affects the verdict */
  }
}

/**
 * Judge one land push. -> { decision: 'allow' | 'block' | 'skip', message?, detail }
 * seams: { fetch: (cwd) => errString|null, preview, checkTests } for tests.
 */
export function judgeLand({ cwd, src, target, base = 'origin/main', fetch = true, checkTests = true, seams = {} }) {
  const detail = { target, src, base };
  if (fetch) {
    const fe = (seams.fetch || fetchBase)(cwd);
    if (fe) detail.fetch = `${fe}; using cached ${base}`;
  }
  const rebase = (seams.preview || previewRebase)({ base, tip: src, cwd });
  detail.rebase = rebase;
  let tests = { status: 'skip', reason: 'not requested' };
  if (checkTests) tests = (seams.checkTests || checkTestRegistration)({ base, tip: src, cwd });
  detail.tests = tests;
  const botOwned = (seams.checkBotOwned || checkBotOwnedRewrite)({ base, tip: src, cwd });
  detail.botOwned = botOwned;
  if (rebase.status === 'conflict' || tests.status === 'fail' || botOwned.status === 'fail') {
    return { decision: 'block', message: blockMessage({ target, rebase, tests, base, botOwned }), detail };
  }
  return { decision: rebase.status === 'skip' && tests.status === 'skip' ? 'skip' : 'allow', detail };
}

/** PreToolUse hook entry: command string + session cwd -> verdict. */
export function runHook({ command, cwd, env = process.env, seams = {} }) {
  if (env.LAND_PREFLIGHT_DISABLE === '1') return { decision: 'skip', reason: 'LAND_PREFLIGHT_DISABLE=1' };
  const targets = landPushTargets(command);
  if (targets.length === 0) return { decision: 'skip', reason: 'not a land push' };
  const results = [];
  for (const t of targets) {
    const p = t.push;
    if (p.dirUnknown) {
      results.push({ decision: 'skip', reason: 'push directory not determinable (pushd, cd ~/-/$VAR, --git-dir, GIT_DIR=)' });
      continue;
    }
    if (p.remote && p.remote !== 'origin') {
      results.push({ decision: 'skip', reason: `remote ${p.remote} is not origin` });
      continue;
    }
    let dir = cwd;
    if (p.cdDir) dir = path.resolve(dir, p.cdDir);
    for (const c of p.gitC) dir = path.resolve(dir, c);
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (!ok(top)) {
      results.push({ decision: 'skip', reason: `not a git repo: ${dir}` });
      continue;
    }
    const root = out(top);
    if (p.headMovedBefore) {
      const r = { decision: 'skip', reason: 'HEAD moves earlier in the same command; cannot judge the pushed commit' };
      logEvent(root, { event: 'skip', target: t.dst, reason: r.reason });
      results.push(r);
      continue;
    }
    const bypass = String(command).match(BYPASS_RE);
    if (bypass) {
      logEvent(root, { event: 'bypass', target: t.dst, reason: bypass[1].trim() });
      results.push({ decision: 'allow', reason: 'bypass' });
      continue;
    }
    // Check B reads the working tree, so it only runs when the tree is the
    // pushed commit for the paths it reads.
    const srcIsHead = out(git(root, ['rev-parse', '--verify', '--quiet', `${t.src || 'HEAD'}^{commit}`])) === out(git(root, ['rev-parse', 'HEAD']));
    const dirty = testTreeDirty(root);
    const checkTests = srcIsHead && dirty.length === 0;
    const v = judgeLand({ cwd: root, src: t.src || 'HEAD', target: t.dst, checkTests, seams });
    if (!checkTests) v.detail.tests = { status: 'skip', reason: srcIsHead ? `uncommitted test files: ${dirty.slice(0, 3).join(', ')}` : 'pushed ref is not HEAD' };
    logEvent(root, { event: v.decision, target: t.dst, rebase: v.detail.rebase?.status, tests: v.detail.tests?.status, fetch: v.detail.fetch || null, skipReason: v.detail.rebase?.reason || null });
    results.push(v);
  }
  const blocked = results.filter((r) => r.decision === 'block');
  if (blocked.length) return { decision: 'block', message: blocked.map((b) => b.message).join('\n\n'), results };
  return { decision: results.some((r) => r.decision === 'allow') ? 'allow' : 'skip', results };
}

function main(argv) {
  if (argv.includes('--hook')) {
    let input = {};
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
      return 0;
    }
    const command = input?.tool_input?.command;
    if (!command) return 0;
    const v = runHook({ command, cwd: input.cwd || process.cwd() });
    if (v.decision === 'block') {
      process.stderr.write(v.message + '\n');
      return 2;
    }
    return 0;
  }
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const cwd = path.resolve(arg('--cwd', process.cwd()));
  const tip = arg('--tip', 'HEAD');
  const base = arg('--base', 'origin/main');
  const v = judgeLand({ cwd, src: tip, target: arg('--target', `land/(${tip})`), base, fetch: !argv.includes('--no-fetch'), checkTests: !argv.includes('--no-tests') });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  else if (v.decision === 'block') process.stderr.write(v.message + '\n');
  else process.stdout.write(`land preflight: ${v.decision} (rebase ${v.detail.rebase.status}${v.detail.rebase.reason ? `: ${v.detail.rebase.reason}` : ''}; tests ${v.detail.tests.status}${v.detail.tests.reason ? `: ${v.detail.tests.reason}` : ''})\n`);
  return v.decision === 'block' ? 3 : 0; // 3, not 1: a crash on load also exits 1
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    // Fail open: an infrastructure error must never wedge a push.
    process.stderr.write(`land-preflight: internal error, not blocking: ${e && e.message}\n`);
    process.exit(0);
  }
}
