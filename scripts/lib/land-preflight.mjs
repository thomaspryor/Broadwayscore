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
//      (land run 37184867156). Since BRO-2483 the node batch is COLLECTED
//      (scripts/lib/unit-test-collection.js), so a new test is registered
//      unless that module excludes it; an edit to the retired
//      tests/unit-test-manifest.txt only WARNS ("ignored, drop it").
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
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { landPushTargets } from './push-command.mjs';
// BRO-5359: the review-coverage gate is optional machinery. If any of these fail to load, the
// rebase/test-registry preflight below must keep working, so load them tolerantly (checkReviewCoverage
// fails open when `rc` is null).
const rc = await Promise.all([import('./transcript-scan.mjs'), import('./review-gate.mjs'), import('./review-coverage.mjs')])
  .then(([t, g, c]) => ({ walkTranscript: t.walkTranscript, gatedDiffStats: g.gatedDiffStats, GATE_LINE_BUDGET: g.GATE_LINE_BUDGET, GATED_PATH_RE: g.GATED_PATH_RE, landGateDecision: c.landGateDecision }))
  .catch(() => null);

const require = createRequire(import.meta.url);
const { isPromisorFetchFailure } = require('./promisor-fetch-failure.js');
const { manifestOrderProblem } = require('./test-manifest.js');
const {
  NODE_MANIFEST_REL: NODE_MANIFEST,
  TSX_MANIFEST_REL: TSX_MANIFEST,
  E2E_MANIFEST_REL: E2E_MANIFEST,
  COLLECTION_MODULE_REL: COLLECTOR,
} = require('./unit-test-collection.js');

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
  if (ok(git(cwd, ['merge-base', '--is-ancestor', tipSha, baseSha]))) return { status: 'clean', replayed: 0, tip: baseSha };
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
  // tip: the simulated rebased commit, i.e. the tree land.yml would put on main.
  return { status: 'clean', replayed: commits.length, tip: cur };
}

const TEST_FILE_RE = /^(tests\/unit|scripts|scripts\/tests)\/[^/]+\.test\.(mjs|ts|tsx|js|cjs|sh)$/;
const MANIFEST_PATHS = [NODE_MANIFEST, TSX_MANIFEST, E2E_MANIFEST];
const isManifest = (p) => MANIFEST_PATHS.includes(p);
// BRO-2483: the node batch is collected; NODE_MANIFEST is a tombstone in any
// tree that carries COLLECTOR (both paths come from unit-test-collection.js).

/** Does `rev`'s tree carry the collector (i.e. ignore the node manifest)? */
function revHasCollector(cwd, rev) {
  return ok(git(cwd, ['cat-file', '-e', `${rev}:${COLLECTOR}`]));
}

/**
 * Non-blocking advice: the branch edits the retired node manifest while the
 * tree it pushes collects the node batch, so the edit does nothing.
 * -> string[] (empty when nothing to say or the check cannot judge)
 */
export function retiredManifestWarnings({ base, src, cwd }) {
  const d = git(cwd, ['diff', '--name-only', '--no-renames', `${base}...${src}`]);
  if (!ok(d) || !out(d).split('\n').includes(NODE_MANIFEST) || !revHasCollector(cwd, src)) return [];
  return [
    `${NODE_MANIFEST} is retired (BRO-2483): this edit is ignored: nothing reads this file; new tests need no registration (${COLLECTOR} collects them; opt a file out via its EXCLUDED map). You can drop the edit.`,
  ];
}

/**
 * Extract the paths the registration audit reads (tests/, scripts/, .github/)
 * of `rev` into a temp dir, so a tree that is not checked out (the base, or
 * the simulated rebased tip) can be judged. -> dir, or null when it fails.
 */
function materializeTree(cwd, rev) {
  const top = git(cwd, ['ls-tree', '--name-only', rev]);
  if (!ok(top)) return null;
  const want = ['tests', 'scripts', '.github'].filter((p) => out(top).split('\n').includes(p));
  if (want.length === 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-preflight-tree-'));
  const r = spawnSync('bash', ['-c', 'git archive --format=tar "$1" -- "${@:3}" | tar -x -C "$2"', '_', rev, dir, ...want], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    return null;
  }
  return dir;
}

/** require() a module from a tree under judgement, never a cached copy. */
function requireFrom(root, rel) {
  const file = path.join(root, rel);
  delete require.cache[require.resolve(file)];
  return require(file);
}

/**
 * Step 1: the judged tree's own copy of the CI audit, scoped to `scope`.
 * -> { problems } or { skip: reason }
 */
function auditProblems(judgeRoot, scope) {
  const audit = path.join(judgeRoot, 'scripts', 'audit-orphan-tests.js');
  if (!fs.existsSync(audit)) return { problems: [] };
  const collects = fs.existsSync(path.join(judgeRoot, COLLECTOR));
  const r = spawnSync('node', [audit, '--scope-stdin', '--json'], {
    cwd: judgeRoot,
    input: scope.join('\n') + '\n',
    encoding: 'utf8',
    timeout: 45000,
  });
  if (r.status === 0) return { problems: [] };
  if (r.status !== 1) return { skip: `audit-orphan-tests.js exit ${r.status}` };
  // exit 1 is also what a crash looks like: only parseable JSON blocks.
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    return { skip: 'audit-orphan-tests.js exited 1 without JSON (crashed)' };
  }
  const problems = [];
  for (const x of report.blocking || []) {
    const f = typeof x === 'string' ? x : x.file;
    problems.push(
      collects
        ? `${f} runs in no CI job: ${COLLECTOR} does not collect it (excluded, a verify-* probe, or outside the collected dirs) and no manifest or workflow run: step names it (a .ts test goes in ${TSX_MANIFEST}; a never-CI probe goes in EXEMPT_NEVER_CI in scripts/audit-orphan-tests.js)`
        : `${f} runs in no CI job: no test manifest lists it and no workflow run: step names it`,
    );
  }
  // The audit also exits 1 on manifest problems (unsorted, duplicates, the
  // a collector failure) in manifests this branch touched.
  for (const m of report.manifestProblems || []) {
    // Collected-batch problems (collector failure, .ts import) carry their own fix; only order/duplicate problems get the sorter.
    const ownFix = m.manifest === NODE_MANIFEST && collects;
    problems.push(ownFix ? `${m.manifest}: ${m.error}` : `${m.manifest}: ${m.error} (fix: node scripts/lib/test-manifest.js --fix)`);
  }
  return { problems };
}

/** Step 2: manifest entries in the judged tree pointing at files this branch deleted. */
function deletedEntryProblems(judgeRoot, deleted) {
  const problems = [];
  for (const m of MANIFEST_PATHS) {
    const mp = path.join(judgeRoot, m);
    if (!fs.existsSync(mp)) continue;
    // Not the node manifest in a collector tree: nothing reads its lines (and
    // in-flight branches keep union-merging lines into the frozen list).
    if (m === NODE_MANIFEST && fs.existsSync(path.join(judgeRoot, COLLECTOR))) continue;
    for (const entry of fs.readFileSync(mp, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
      if (deleted.has(entry)) problems.push(`${m} still lists ${entry}, which this branch deletes (remove the line)`);
    }
  }
  return problems;
}

/** Step 3 (BRO-2483): a deleted file the judged tree's collector still names in OPT_IN / EXCLUDED. */
function staleCollectorListProblems(judgeRoot, deleted) {
  if (deleted.size === 0 || !fs.existsSync(path.join(judgeRoot, COLLECTOR))) return [];
  const C = requireFrom(judgeRoot, COLLECTOR);
  const problems = [];
  for (const [list, entries] of [['OPT_IN', [...C.OPT_IN]], ['EXCLUDED', [...C.EXCLUDED.keys()]]]) {
    for (const rel of entries) {
      if (deleted.has(rel)) problems.push(`${COLLECTOR} ${list} still lists ${rel}, which this branch deletes (remove the entry; glob-based-manifest.test.mjs fails on a stale one)`);
    }
  }
  return problems;
}

/**
 * Step 4 (BRO-2483): an edit to the collector that drops tests from the node
 * batch. Every test collected on `base` but not by the judged tree, and still
 * present there, must be EXCLUDED with a reason or named in a workflow run:
 * step (or another manifest). -> { problems, newlyExcluded } or { skip }
 */
function collectorEditProblems(cwd, base, judgeRoot) {
  if (!fs.existsSync(path.join(judgeRoot, COLLECTOR))) return { problems: [], newlyExcluded: [] };
  const baseDir = materializeTree(cwd, base);
  if (!baseDir) return { skip: `could not extract ${base} to compare the collector edit` };
  try {
    const before = fs.existsSync(path.join(baseDir, COLLECTOR))
      ? requireFrom(baseDir, COLLECTOR).collectNodeUnitTests(baseDir)
      : requireFrom(judgeRoot, COLLECTOR).nodeUnitTestsForTree(baseDir); // pre-BRO-2483 base: its manifest
    const C = requireFrom(judgeRoot, COLLECTOR);
    const after = new Set(C.collectNodeUnitTests(judgeRoot));
    const newlyExcluded = before.filter((rel) => !after.has(rel) && fs.existsSync(path.join(judgeRoot, rel)));
    if (newlyExcluded.length === 0) return { problems: [], newlyExcluded };
    const { coverageOf } = requireFrom(judgeRoot, 'scripts/audit-orphan-tests.js').collectCiCoverage(judgeRoot);
    const problems = [];
    for (const rel of newlyExcluded) {
      const reason = C.EXCLUDED.get(rel);
      if (typeof reason === 'string' && reason.trim()) continue;
      if (coverageOf(rel)) continue;
      problems.push(`${rel} no longer runs in the node batch after this edit of ${COLLECTOR}, and it runs nowhere else: add it to EXCLUDED with a reason (and where it runs instead), or undo the change that drops it`);
    }
    return { problems, newlyExcluded };
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Branch-scoped test registration check, run against the working tree at
 * `cwd` (the caller guarantees it equals the pushed commit for these paths).
 * `landedTip` is the simulated rebased commit (what land would put on main),
 * used when the base and the branch disagree about the collector.
 * -> { status: 'clean' | 'fail' | 'skip', problems?: string[], warnings?: string[], reason? }
 */
export function checkTestRegistration({ base, tip, cwd, landedTip = null }) {
  const diff = git(cwd, ['diff', '--name-status', '--no-renames', `${base}...${tip}`]);
  if (!ok(diff)) return { status: 'skip', reason: 'diff vs base failed' };
  const changed = [];
  const deleted = new Set();
  for (const line of out(diff).split('\n').filter(Boolean)) {
    const [st, p] = line.split('\t');
    changed.push(p);
    if (st === 'D') deleted.add(p);
  }
  const editsCollector = changed.includes(COLLECTOR);
  const relevant = changed.filter((p) => TEST_FILE_RE.test(p) || isManifest(p) || p === COLLECTOR);
  if (relevant.length === 0) return { status: 'clean', reason: 'no test files or manifests changed' };
  const root = out(git(cwd, ['rev-parse', '--show-toplevel']));
  const problems = [];
  const warnings = [];
  let scope = changed.filter((p) => !deleted.has(p));

  // BRO-2483 transition: judge against the tree that will actually land. When
  // the base collects node tests but this branch's tree predates the
  // collector, the branch's own audit would hand out pre-BRO-2483 advice
  // ("register it in the manifest"), which is wrong for the landed tree. So
  // the checks below run on the simulated rebased tree instead.
  let judgeRoot = root;
  let tempRoot = null;
  if (revHasCollector(cwd, base) && !revHasCollector(cwd, tip)) {
    const msg =
      `this branch predates BRO-2483 (${base} collects node unit tests with ${COLLECTOR}; this branch's tree does not): ` +
      `merge origin/main first (git fetch origin main && git merge origin/main); ${NODE_MANIFEST} is retired, do not edit it; new tests need no registration`;
    warnings.push(
      changed.includes(NODE_MANIFEST)
        ? `${msg}. This branch's edit to ${NODE_MANIFEST} is ignored: nothing reads that file; you can drop the edit.`
        : msg,
    );
    tempRoot = landedTip ? materializeTree(cwd, landedTip) : null;
    if (!tempRoot) {
      // No rebased tree to judge (conflict / skip upstream): the predates verdict is all we can say.
      return problems.length
        ? { status: 'fail', problems, warnings }
        : { status: 'clean', reason: 'branch predates BRO-2483 and no rebased tree to judge', warnings };
    }
    judgeRoot = tempRoot;
  }

  try {
    // 4. A collector edit: its newly excluded tests join the audit scope and
    //    must have an EXCLUDED reason or another CI home.
    if (editsCollector) {
      const ce = collectorEditProblems(cwd, base, judgeRoot);
      if (ce.skip) return { status: 'skip', reason: ce.skip, warnings };
      problems.push(...ce.problems);
      scope = [...new Set([...scope, ...ce.newlyExcluded])];
    }
    // 1. Added/changed (or newly excluded) test files nothing registers.
    const a = auditProblems(judgeRoot, scope);
    if (a.skip) return { status: 'skip', reason: a.skip, warnings };
    problems.push(...a.problems);
    // 2. Manifest entries pointing at files this branch deleted.
    problems.push(...deletedEntryProblems(judgeRoot, deleted));
    // 3. OPT_IN / EXCLUDED entries pointing at files this branch deleted.
    problems.push(...staleCollectorListProblems(judgeRoot, deleted));
  } finally {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  }
  return problems.length ? { status: 'fail', problems, warnings } : { status: 'clean', warnings };
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

// BRO-5086: a squash made with `git reset --soft origin/main` WITHOUT first
// merging origin/main has the new main as parent but the OLD branch point's
// tree, so it reverts everything main gained in between (BRO-4638: 165 files,
// 6196+/37596-). The rebase is clean and only bot-owned paths were counted, so
// it went through. Signature: the tree land would apply matches some OLDER
// main commit M on most of the paths it changes. Scanning first-parent
// ancestors of base for the best M costs one bounded ls-tree per commit; a
// file the branch deletes is still present in recent M, so ordinary deletions
// do not match.
export const STALE_WINDOW = 200;
export const STALE_MIN_FILES = 3;
// Matches that are only "absent in both" (main added the path after M, the
// tip lacks it) also describe a branch deleting files main added recently, so
// on their own they need many more files before they block.
export const STALE_MIN_ABSENT_ONLY = 10;
const STALE_MAX_PATHS = 2000;

function lsTreeBlobs(cwd, rev, paths) {
  const r = git(cwd, ['ls-tree', '-r', '-z', rev, '--', ...paths]);
  if (!ok(r)) return null;
  const m = new Map();
  for (const e of r.stdout.split('\0').filter(Boolean)) {
    const tab = e.indexOf('\t');
    m.set(e.slice(tab + 1), e.slice(0, tab).split(' ')[2]);
  }
  return m;
}

/**
 * Does the tree land would apply (tip = the simulated rebased commit) revert
 * many paths to an older main state?
 * -> { status: 'pass' | 'fail' | 'skip', count?, of?, sample?, matches?, reason? }
 */
export function checkStaleRevert({ base, tip, cwd, window = STALE_WINDOW, minFiles = STALE_MIN_FILES }) {
  const d = git(cwd, ['diff', '--name-only', '--no-renames', '-z', base, tip]);
  if (!ok(d)) return { status: 'skip', reason: (d.stderr || 'git diff failed').trim().slice(0, 200) };
  const paths = d.stdout.split('\0').filter(Boolean).slice(0, STALE_MAX_PATHS);
  if (paths.length < minFiles) return { status: 'pass', count: 0, of: paths.length };
  const tipBlobs = lsTreeBlobs(cwd, tip, paths);
  if (!tipBlobs) return { status: 'skip', reason: 'ls-tree of tip failed' };
  const rl = git(cwd, ['rev-list', '--first-parent', `--max-count=${window + 1}`, base]);
  if (!ok(rl)) return { status: 'skip', reason: 'rev-list of base failed' };
  const older = out(rl).split('\n').filter(Boolean).slice(1); // [0] is base itself
  if (older.length === 0) return { status: 'skip', reason: 'no older main commits (shallow clone?)' };
  let best = { count: 0, sha: null, hits: [], content: 0 };
  for (const sha of older) {
    const mBlobs = lsTreeBlobs(cwd, sha, paths);
    if (!mBlobs) continue; // commit missing past a shallow boundary
    // Absent in both counts: main added the path after M and tip lacks it.
    const hits = paths.filter((p) => mBlobs.get(p) === tipBlobs.get(p));
    if (hits.length > best.count) best = { count: hits.length, sha, hits, content: hits.filter((p) => tipBlobs.has(p)).length };
    if (best.count === paths.length) break;
  }
  const fail = best.count * 2 >= paths.length
    && (best.content > 0 ? best.count >= minFiles : best.count >= STALE_MIN_ABSENT_ONLY);
  return {
    status: fail ? 'fail' : 'pass',
    count: best.count,
    of: paths.length,
    matches: best.sha ? out(git(cwd, ['log', '-1', '--format=%h %cs %s', best.sha])) : null,
    sample: best.hits.slice(0, 5),
  };
}

/**
 * BRO-5086 (comment): a manifest the branch edited can come out of the land
 * rebase unsorted, when git's 3-way merge puts the branch's new line after a
 * neighbour main just added (run 38177137379). Judge the rebased tree's copy.
 * -> { status: 'pass' | 'fail' | 'skip', problems? }
 */
export function checkRebasedManifests({ base, src, tip, cwd }) {
  const d = git(cwd, ['diff', '--name-only', '--no-renames', `${base}...${src}`]);
  if (!ok(d)) return { status: 'skip', reason: 'diff vs base failed' };
  const problems = [];
  for (const m of out(d).split('\n').filter((p) => isManifest(p))) {
    const r = git(cwd, ['show', `${tip}:${m}`]);
    if (!ok(r)) continue; // deleted on the branch
    // BRO-2483: the node manifest is an ignored tombstone in a collector tree
    // (its frozen list keeps absorbing in-flight appends); order is irrelevant.
    if (m === NODE_MANIFEST && revHasCollector(cwd, tip)) continue;
    const p = manifestOrderProblem(r.stdout);
    if (p) problems.push(`${m} ${p} after the land rebase onto ${base}`);
  }
  return problems.length ? { status: 'fail', problems } : { status: 'pass' };
}

// BRO-4909: a push that touches .github/workflows is judged by CI's workflow
// lints and the DEPENDENCIES.md freshness check; running them here saves the
// ~30 minute land cycle they would otherwise cost (a stale DEPENDENCIES.md
// reddened main's land runs this way). Judged on the tree that will land.
export const WORKFLOW_PATH_RE = /^\.github\/(workflows|actions)\/|^scripts\/lib\/push-with-retry\.sh$|^scripts\/(lint-workflow-guards\.sh|audit-workflow-hygiene\.js|generate-workflow-dependencies\.js|audit-push-retry-budgets\.js)$|^tests\/unit\/audit-push-retry-budgets-residual\.test\.mjs$|^scripts\/lib\/(audit-workflow-hygiene-rules|workflow-dependency-graph|audit-push-retry-budgets)\.js$/;
export const WORKFLOW_CHECKS = [
  { name: 'lint-workflow-guards.sh workflows', cmd: 'bash', args: ['scripts/lint-workflow-guards.sh', 'workflows'], fix: 'fix the lines it prints' },
  { name: 'audit-workflow-hygiene.js', cmd: 'node', args: ['scripts/audit-workflow-hygiene.js'], fix: 'fix the lines it prints (or the exemption comment it names)' },
  { name: 'generate-workflow-dependencies.js --check', cmd: 'node', args: ['scripts/generate-workflow-dependencies.js', '--check'], fix: 'node scripts/generate-workflow-dependencies.js, then commit .github/workflows/DEPENDENCIES.md' },
  // BRO-5833: a one-step workflow edit cleared this gauntlet and was refused ~20 min later by
  // the job-timeout-margin gate (~1s locally). `file` is what must exist in the tree to run it.
  { name: 'audit-push-retry-budgets.js --fail-on-job-timeout', cmd: 'node', args: ['scripts/audit-push-retry-budgets.js', '--fail-on-job-timeout'], fix: 'raise the timeout-minutes of the job it names' },
  { name: 'audit-push-retry-budgets-residual.test.mjs', cmd: 'node', args: ['--test', 'tests/unit/audit-push-retry-budgets-residual.test.mjs'], file: 'tests/unit/audit-push-retry-budgets-residual.test.mjs', fix: 'see the failing assertion; usually raise the job timeout-minutes (node scripts/audit-push-retry-budgets.js lists call sites)' },
];
/** Nearest node_modules at or above dir (a worktree under .claude/worktrees has none of its own). */
function findNodeModules(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const nm = path.join(d, 'node_modules');
    if (fs.existsSync(nm)) return nm;
    if (path.dirname(d) === d) return null;
  }
}
/** -> { status: 'clean' | 'fail' | 'skip', problems?, reason? }. Fails open: a check that cannot run is not a block. */
export function checkWorkflowChecks({ base, tip, cwd, landedTip = null, run = spawnSync }) {
  const diff = git(cwd, ['diff', '--name-only', '--no-renames', `${base}...${tip}`]);
  if (!ok(diff)) return { status: 'skip', reason: 'diff vs base failed' };
  if (!out(diff).split('\n').some((f) => WORKFLOW_PATH_RE.test(f))) return { status: 'clean', reason: 'no workflow files changed' };
  const root = out(git(cwd, ['rev-parse', '--show-toplevel']));
  const nm = findNodeModules(root);
  // js-yaml, acorn and friends live in the checkout's node_modules, not in the exported tree.
  const env = { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_EVENT_NAME: '', NODE_PATH: [nm, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };

  // Runs `specs` concurrently inside `treeRoot` (the guard script alone takes ~45s, so
  // one bash with `wait` keeps the total inside the hook's 90s budget).
  // -> [{ c, rc, text }]; rc is null when the check never finished.
  const runBatch = (treeRoot, specs) => {
    try {
      if (nm) fs.symlinkSync(nm, path.join(treeRoot, 'node_modules'), 'dir');
    } catch { /* NODE_PATH still covers plain require() */ }
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-preflight-wf-'));
    try {
      const runnable = specs.filter((c) => fs.existsSync(path.join(treeRoot, c.file || c.args[0])));
      const script = runnable
        .map((c) => `( timeout 55 ${[c.cmd, ...c.args].join(' ')} >"${outDir}/${c.i}.out" 2>&1; echo $? >"${outDir}/${c.i}.rc" ) &`)
        .join('\n') + '\nwait\n';
      run('bash', ['-c', script], { cwd: treeRoot, env, encoding: 'utf8', timeout: 58000 });
      return runnable.map((c) => {
        let rc = null;
        let text = '';
        try { rc = fs.readFileSync(path.join(outDir, `${c.i}.rc`), 'utf8').trim(); } catch { /* never finished: fail open */ }
        try { text = fs.readFileSync(path.join(outDir, `${c.i}.out`), 'utf8'); } catch { /* no output */ }
        return { c, rc, text };
      });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5 });
    }
  };

  const judgeRoot = materializeTree(cwd, landedTip || tip);
  if (!judgeRoot) return { status: 'skip', reason: 'could not materialize the landing tree' };
  try {
    // rc 0 = pass; anything but 1 (124 timeout, 127, crash, never finished) = could not judge: fail open.
    const failed = runBatch(judgeRoot, WORKFLOW_CHECKS.map((c, i) => ({ ...c, i }))).filter((r) => r.rc === '1');
    if (failed.length === 0) return { status: 'clean' };
    // A check already red on base is not this branch's fault (land.yml judges new failures only).
    let newFailures = failed;
    const baseRoot = materializeTree(cwd, base);
    if (baseRoot) {
      try {
        const redOnBase = new Set(runBatch(baseRoot, failed.map((r) => r.c)).filter((r) => r.rc === '1').map((r) => r.c.i));
        newFailures = failed.filter((r) => !redOnBase.has(r.c.i));
      } finally {
        fs.rmSync(baseRoot, { recursive: true, force: true, maxRetries: 5 });
      }
    }
    const problems = newFailures.map(({ c, text }) => {
      const tail = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-6).join(' | ').slice(0, 600);
      return `${c.name} fails on the landing tree (${c.fix}): ${tail}`;
    });
    return problems.length ? { status: 'fail', problems } : { status: 'clean', reason: 'failures also present on base' };
  } finally {
    fs.rmSync(judgeRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

// BRO-5657: a new top-level script whose test is collected but whose path is
// missing from test.yml on.push.paths was refused by land.yml (floor test in
// audit-toplevel-script-test-yml-coverage.test.mjs) about 45 minutes in. Cloud
// containers have no pre-push hook, so run the same audit here: the judged
// tree's own copy, compared with base so a gap already on main is not blamed.
export const TOPLEVEL_PUSH_PATH_RE = /^scripts\/[^/]+\.(js|mjs|cjs|ts|tsx)$|^scripts\/.+\.test\.(mjs|cjs|js|ts)$|^scripts\/lib\/(unit-test-collection|test-manifest)\.js$|^tests\/|^\.github\/workflows\/test\.yml$/;
const TOPLEVEL_AUDIT = 'scripts/audit-toplevel-script-test-yml-coverage.js';
// The audit reports each uncovered source once, under whichever test reaches it first,
// so key on the source alone (a reordered test or a renamed job must not look new).
const gapKey = (g) => (g.source && g.sourceCovered === false ? `src:${g.source}` : `${g.source || ''}|${g.test || ''}`);
/** -> gaps array, or null when the audit could not run / parse (fail open). */
function toplevelGaps(treeRoot, env) {
  if (!fs.existsSync(path.join(treeRoot, TOPLEVEL_AUDIT))) return null;
  const r = spawnSync('node', [TOPLEVEL_AUDIT, '--json'], { cwd: treeRoot, env, encoding: 'utf8', timeout: 25000 });
  if (r.status !== 0) return null;
  try {
    const gaps = JSON.parse(r.stdout).gaps;
    return Array.isArray(gaps) ? gaps : null;
  } catch {
    return null;
  }
}
/** -> { status: 'clean' | 'fail' | 'skip', problems?, reason? }. Fails open. */
export function checkToplevelPushPaths({ base, tip, cwd, landedTip = null, gapsFor = toplevelGaps }) {
  const diff = git(cwd, ['diff', '--name-only', '--no-renames', `${base}...${tip}`]);
  if (!ok(diff)) return { status: 'skip', reason: 'diff vs base failed' };
  if (!out(diff).split('\n').some((f) => TOPLEVEL_PUSH_PATH_RE.test(f))) return { status: 'clean', reason: 'no top-level scripts, tests or test.yml changed' };
  const root = out(git(cwd, ['rev-parse', '--show-toplevel']));
  const nm = findNodeModules(root);
  const env = { ...process.env, NODE_PATH: [nm, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };
  const judgeRoot = materializeTree(cwd, landedTip || tip);
  if (!judgeRoot) return { status: 'skip', reason: 'could not materialize the landing tree' };
  try {
    if (nm) { try { fs.symlinkSync(nm, path.join(judgeRoot, 'node_modules'), 'dir'); } catch { /* NODE_PATH still covers require() */ } }
    const gaps = gapsFor(judgeRoot, env);
    if (gaps === null) return { status: 'skip', reason: 'toplevel push-path audit could not run' };
    if (gaps.length === 0) return { status: 'clean' };
    // Without a base verdict we cannot tell this branch's gaps from main's: fail open.
    const baseRoot = materializeTree(cwd, base);
    if (!baseRoot) return { status: 'skip', reason: 'could not materialize base' };
    let fresh;
    try {
      if (nm) { try { fs.symlinkSync(nm, path.join(baseRoot, 'node_modules'), 'dir'); } catch { /* as above */ } }
      const onBase = gapsFor(baseRoot, env);
      if (onBase === null) return { status: 'skip', reason: 'base audit could not run' };
      const known = new Set(onBase.map(gapKey));
      fresh = gaps.filter((g) => !known.has(gapKey(g)));
    } finally {
      fs.rmSync(baseRoot, { recursive: true, force: true, maxRetries: 5 });
    }
    const problems = [];
    for (const g of fresh) {
      for (const [file, covered] of [[g.source, g.sourceCovered], [g.test, g.testCovered]]) {
        if (file && covered === false) problems.push(`${file} is not in test.yml on.push.paths (land.yml refuses a push that adds it; the test is ${g.test}). Add this line under on.push.paths in .github/workflows/test.yml: - '${file}'`);
      }
    }
    return problems.length ? { status: 'fail', problems: [...new Set(problems)] } : { status: 'clean', reason: 'gaps also present on base' };
  } finally {
    fs.rmSync(judgeRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

// BRO-5520: two session plans of 41 and 49 actions (the cap is 25) reached
// land.yml, which refused the first on tests/unit/pending-fix-plans.test.mjs
// about 40 minutes later. Same checks (scripts/lib/pending-fix-plan-checks.js)
// on the bro-* plans this branch adds or changes, read from the tree land would
// apply. The module loads only when a plan changed, and a load failure or a
// throw inside it is a SKIP, so the other checks never depend on it.
export const PENDING_PLAN_RE = /^data\/pending-fixes\/bro-[^/]+\.json$/;
const loadPlanChecks = () => require('./pending-fix-plan-checks.js');

/** -> { status: 'clean' | 'pass' | 'fail' | 'skip', problems?, warnings?, reason? } */
export function checkPendingPlans({ base, tip, cwd, landedTip = null, load = loadPlanChecks }) {
  // quotePath off: a non-ASCII name would otherwise print quoted and miss PENDING_PLAN_RE.
  const diff = git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '--diff-filter=AM', `${base}...${tip}`, '--', 'data/pending-fixes']);
  if (!ok(diff)) return { status: 'skip', reason: 'diff vs base failed' };
  const files = out(diff).split('\n').filter((f) => PENDING_PLAN_RE.test(f));
  if (files.length === 0) return { status: 'clean', reason: 'no bro-* plans changed' };
  try {
    const checks = load();
    const problems = [];
    const warnings = [];
    for (const f of files) {
      // The branch adds or changes f, so it is in the tree read (a main-side
      // delete of it would be a rebase conflict, and then tip is read).
      const shown = git(cwd, ['show', `${landedTip || tip}:${f}`]);
      if (!ok(shown)) {
        warnings.push(`${f}: could not be read to check it (${(shown.stderr || 'git show failed').trim().slice(0, 80)})`);
        continue;
      }
      let plan;
      try {
        plan = JSON.parse(shown.stdout);
      } catch (e) {
        problems.push(`${f}: not valid JSON (${String(e.message).slice(0, 80)})`);
        continue;
      }
      problems.push(...checks.pendingPlanProblems(f, plan));
      // BRO-5647: judged against the plan on base (null when the branch adds it).
      const onBase = git(cwd, ['show', `${base}:${f}`]);
      let basePlan = null;
      try { basePlan = ok(onBase) ? JSON.parse(onBase.stdout) : null; } catch { basePlan = null; }
      problems.push(...checks.finishedOnBranchProblems(f, basePlan, plan));
      const statusWarning = checks.planStatusWarning(f, plan);
      if (statusWarning) warnings.push(statusWarning);
    }
    return problems.length ? { status: 'fail', problems, warnings } : { status: 'pass', warnings };
  } catch (e) {
    return { status: 'skip', reason: `pending plan checks failed: ${String(e && e.message).slice(0, 120)}` };
  }
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
  return paths.filter((p) => TEST_FILE_RE.test(p) || isManifest(p) || p.startsWith('.github/workflows/'));
}

export function blockMessage({ target, rebase, tests, base, botOwned, staleRevert, manifests, workflows, pendingPlans, toplevel }) {
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
  if (manifests?.status === 'fail') {
    lines.push('', '* Test manifest order (test-manifest-integrity would go red after the land rebase):');
    for (const p of manifests.problems) lines.push(`   - ${p}`);
    lines.push('   Fix: git fetch origin main && git merge origin/main, then node -e "require(\'./scripts/lib/test-manifest.js\').sortManifestFile(\'<manifest>\')", commit, squash.');
  }
  if (workflows?.status === 'fail') {
    lines.push('', '* Workflow checks (CI would go red on these):');
    for (const p of workflows.problems) lines.push(`   - ${p}`);
  }
  if (toplevel?.status === 'fail') {
    lines.push('', '* Top-level script push paths (audit-toplevel-script-test-yml-coverage would go red):');
    for (const p of toplevel.problems) lines.push(`   - ${p}`);
  }
  if (pendingPlans?.status === 'fail') {
    lines.push('', '* Pending data plans (execute-approved-fix.js refuses these at apply time, and tests/unit/pending-fix-plans.test.mjs fails on them):');
    for (const p of pendingPlans.problems) lines.push(`   - ${p}`);
    lines.push('   Split an oversized plan by show (each show\'s actions together, in order) into <id>.json, <id>-b.json, ..., each with its own planId.');
  }
  if (staleRevert?.status === 'fail') {
    lines.push(
      '',
      `* This push reverts ${staleRevert.count} of the ${staleRevert.of} files it changes to an older main state`,
      `   (they match main as of ${staleRevert.matches}: ${staleRevert.sample.join(', ')}, ...).`,
      '   That is `git reset --soft origin/main` without merging origin/main first: the commit would REVERT',
      '   everything main gained since your branch point. Merge origin/main before git reset --soft, or rebuild it:',
      '     git fetch origin main && git checkout -B <branch> origin/main',
      '     git checkout <old-tip> -- <only your files> && git commit',
    );
  } else if (botOwned?.status === 'fail') {
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
  if (checkTests) tests = (seams.checkTests || checkTestRegistration)({ base, tip: src, cwd, landedTip: rebase.status === 'clean' ? rebase.tip : null });
  detail.tests = tests;
  const botOwned = (seams.checkBotOwned || checkBotOwnedRewrite)({ base, tip: src, cwd });
  detail.botOwned = botOwned;
  // Judged on what land would apply (the rebased tree), so an unmerged branch
  // that is merely behind main is not mistaken for a revert.
  const staleRevert = rebase.status === 'clean' && rebase.tip
    ? (seams.checkStaleRevert || checkStaleRevert)({ base, tip: rebase.tip, cwd })
    : { status: 'skip', reason: `rebase preview ${rebase.status}` };
  detail.staleRevert = staleRevert;
  const manifests = rebase.status === 'clean' && rebase.tip
    ? (seams.checkRebasedManifests || checkRebasedManifests)({ base, src, tip: rebase.tip, cwd })
    : { status: 'skip' };
  detail.manifests = manifests;
  const workflows = (seams.checkWorkflowChecks || checkWorkflowChecks)({ base, tip: src, cwd, landedTip: rebase.status === 'clean' ? rebase.tip : null });
  detail.workflows = workflows;
  const pendingPlans = (seams.checkPendingPlans || checkPendingPlans)({ base, tip: src, cwd, landedTip: rebase.status === 'clean' ? rebase.tip : null });
  detail.pendingPlans = pendingPlans;
  const toplevel = (seams.checkToplevelPushPaths || checkToplevelPushPaths)({ base, tip: src, cwd, landedTip: rebase.status === 'clean' ? rebase.tip : null });
  detail.toplevel = toplevel;
  const warnings = [...(tests.warnings || []), ...(pendingPlans.warnings || []), ...(seams.retiredManifestWarnings || retiredManifestWarnings)({ base, src, cwd })];
  detail.warnings = warnings;
  if ([rebase.status === 'conflict', tests.status, botOwned.status, staleRevert.status, manifests.status, workflows.status, pendingPlans.status, toplevel.status].some((x) => x === true || x === 'fail')) {
    const message = blockMessage({ target, rebase, tests, base, botOwned, staleRevert, manifests, workflows, pendingPlans, toplevel });
    return { decision: 'block', message: warnings.length ? `${message}\n\nAlso: ${warnings.join('\n')}` : message, warnings, detail };
  }
  return { decision: rebase.status === 'skip' && tests.status === 'skip' ? 'skip' : 'allow', warnings, detail };
}

/** Directory a land push runs in, from its `cd` / `git -C` prefixes. */
function pushDir(cwd, p) {
  let dir = cwd;
  if (p.cdDir) dir = path.resolve(dir, p.cdDir);
  for (const c of p.gitC) dir = path.resolve(dir, c);
  return dir;
}

/**
 * Gated lines a push chained after a HEAD-moving command (`git add -A && git commit && git push …`) will
 * carry: the working tree against origin/main, plus untracked new files. The pushed commit does not exist yet,
 * so the normal range cannot be computed, and skipping it would let any chained commit-and-push evade the gate.
 */
function pendingGatedStats(root) {
  // Tracked changes: the shared helper (working tree against the merge base), so a chained push is sized exactly
  // like an unchained one; a branch behind main is not charged for what other sessions landed since.
  const stats = rc.gatedDiffStats(root, 'origin/main', 'WORKTREE');
  if (stats.error) return stats;
  const files = [...stats.files];
  let totalLines = stats.totalLines;
  const untracked = git(root, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '--', 'src', 'scripts', '.github/workflows']);
  for (const f of ok(untracked) ? out(untracked).split('\n').filter(Boolean) : []) {
    if (!rc.GATED_PATH_RE.test(f)) continue;
    let n = 0;
    try {
      const full = path.join(root, f);
      // Bounded: a huge untracked file counts by size (about 40 bytes a line) instead of being read whole.
      const size = fs.statSync(full).size;
      n = size > 2_000_000 ? Math.ceil(size / 40) : fs.readFileSync(full, 'utf8').split('\n').length;
    } catch { /* unreadable: count nothing */ }
    files.push({ path: f, added: n, deleted: 0 });
    totalLines += n;
  }
  return { files, totalLines };
}

/**
 * BRO-5359: a cloud land push of real code needs a COMPLETE review first (Claude
 * review-panelist + an external reviewer after a real /ship-check). Run once per
 * command, independent of NO-LAND-PREFLIGHT (that bypass is for rebase/test-registry
 * refusals, not for skipping review). Fails open on any error or missing transcript.
 */
export function checkReviewCoverage({ command, cwd, targets, env = process.env, transcriptPath = null, seams = {} }) {
  if (!rc || env.CLAUDE_CODE_REMOTE !== 'true' || env.SHIP_CHECK_LAND_GATE_DISABLE === '1') return null;
  try {
    const events = seams.events !== undefined ? seams.events : transcriptPath && fs.existsSync(transcriptPath) ? rc.walkTranscript(transcriptPath) : null;
    let gatedLines = 0;
    let touchesSrc = false;
    let root = null;
    for (const t of targets) {
      const p = t.push;
      if (p.dirUnknown || (p.remote && p.remote !== 'origin')) continue;
      const top = git(pushDir(cwd, p), ['rev-parse', '--show-toplevel']);
      if (!ok(top)) continue;
      root = out(top);
      const stats = seams.stats || (p.headMovedBefore ? pendingGatedStats(root) : rc.gatedDiffStats(root, 'origin/main', t.src || 'HEAD'));
      if (!stats.error) {
        gatedLines = Math.max(gatedLines, stats.totalLines);
        if ((stats.files || []).some((f) => f.path.startsWith('src/'))) touchesSrc = true;
      }
    }
    const v = rc.landGateDecision({ command, events, gatedLines, budget: rc.GATE_LINE_BUDGET, touchesSrc, env });
    if (root && !seams.noLog) logEvent(root, { event: `review-coverage-${v.decision}`, reason: v.reason, gatedLines, target: (targets.find((t) => t.dst) || {}).dst || null });
    return v;
  } catch {
    return null;
  }
}

/**
 * BRO-6083: advisory coordinator check. A land touching an area with a
 * coordinator card (scripts/lib/coordinator-registry.js) and no
 * COORDINATOR-ACK for the card's latest note gets a warning carrying that
 * note. Runs the pushed repo's own scripts/coordinator-check.js (absent on an
 * older tree: skipped). Never blocks; any failure is silent.
 */
export function coordinatorWarnings({ root, src, target, seams = {} }) {
  try {
    if (seams.coordinator) return seams.coordinator({ root, src, target }) || [];
    const script = path.join(root, 'scripts', 'coordinator-check.js');
    if (!fs.existsSync(script)) return [];
    const r = spawnSync(process.execPath, [script, '--land', '--json', '--base', 'origin/main', '--head', src, '--branch', target, '--cwd', root], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    const v = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
    return v.message ? [v.message] : [];
  } catch {
    return [];
  }
}

/** PreToolUse hook entry: command string + session cwd -> verdict. */
export function runHook({ command, cwd, env = process.env, seams = {}, transcriptPath = null }) {
  if (env.LAND_PREFLIGHT_DISABLE === '1') return { decision: 'skip', reason: 'LAND_PREFLIGHT_DISABLE=1' };
  const targets = landPushTargets(command);
  if (targets.length === 0) return { decision: 'skip', reason: 'not a land push' };
  const cov = checkReviewCoverage({ command, cwd, targets, env, transcriptPath, seams });
  if (cov && cov.decision === 'block') return { decision: 'block', message: cov.message, warnings: [], results: [cov] };
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
    const dir = pushDir(cwd, p);
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
    logEvent(root, { event: v.decision, target: t.dst, rebase: v.detail.rebase?.status, tests: v.detail.tests?.status, botOwned: v.detail.botOwned?.status, staleRevert: v.detail.staleRevert?.status, pendingPlans: v.detail.pendingPlans?.status, fetch: v.detail.fetch || null, skipReason: v.detail.rebase?.reason || null });
    if (v.decision !== 'block') {
      const cw = coordinatorWarnings({ root, src: t.src || 'HEAD', target: t.dst, seams });
      if (cw.length) v.warnings = [...(v.warnings || []), ...cw];
    }
    results.push(v);
  }
  const blocked = results.filter((r) => r.decision === 'block');
  const warnings = [...new Set(results.flatMap((r) => r.warnings || []))];
  if (blocked.length) return { decision: 'block', message: blocked.map((b) => b.message).join('\n\n'), warnings, results };
  return { decision: results.some((r) => r.decision === 'allow') ? 'allow' : 'skip', warnings, results };
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
    const v = runHook({ command, cwd: input.cwd || process.cwd(), transcriptPath: input.transcript_path || null });
    if (v.decision === 'block') {
      process.stderr.write(v.message + '\n');
      return 2;
    }
    // Warnings never block (exit 0). Stderr on exit 0 is not shown to the
    // session, so they go to stdout as PreToolUse additionalContext
    // (BRO-6083); the wrapper passes stdout through.
    const warnings = v.warnings || [];
    if (warnings.length) {
      const additionalContext = warnings.map((w) => `land preflight warning: ${w}`).join('\n\n');
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }) + '\n');
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
  else {
    for (const w of v.warnings || []) process.stderr.write(`land preflight warning: ${w}\n`);
    process.stdout.write(`land preflight: ${v.decision} (rebase ${v.detail.rebase.status}${v.detail.rebase.reason ? `: ${v.detail.rebase.reason}` : ''}; tests ${v.detail.tests.status}${v.detail.tests.reason ? `: ${v.detail.tests.reason}` : ''})\n`);
  }
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
