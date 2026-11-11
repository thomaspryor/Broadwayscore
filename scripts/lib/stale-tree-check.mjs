// stale-tree-check.mjs — does a branch put files back to an OLDER main state?
//
// BRO-5086 wrote these checks for the pre-push land preflight
// (land-preflight.mjs re-exports them). BRO-7078: land.yml also runs them,
// advisory, on every land/** push, because a session without the hook pushed
// land/bro-7078-fixups (810c4c3a8: 112 files back to a 2026-11-07 main state).
//
// INVARIANT: imports only node builtins. land.yml copies main's copy of THIS
// FILE ALONE into a temp dir and runs it against the branch tree; a sibling
// import would resolve to the branch's (possibly stale) files and fail to load
// in exactly the case it exists for. Guarded by stale-tree-check.test.mjs.
//
// CLI: node stale-tree-check.mjs --ci-stale [--base origin/main] [--tip HEAD] [--cwd DIR]
//   prints ::warning:: lines and `stale_tree=<pass|fail|skip>`, always exits 0.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const ok = (r) => r.status === 0;
const out = (r) => r.stdout.trim();

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
 * BRO-7078: the server-side copy of the two stale-tree checks above, for
 * land.yml. The pre-push hook runs them only where hooks are installed; a
 * cloud session without them pushed land/bro-7078-fixups (810c4c3a8, 112 files
 * put back to a 2026-11-07 main state) and only an unrelated rebase conflict
 * stopped it. Judges the branch as pushed (merge-base..tip), so it also runs
 * when the land rebase conflicts. Advisory: never throws, never blocks.
 * -> { status: 'pass' | 'fail' | 'skip', lines: string[] }
 */
export function ciStaleTreeVerdict({ base = 'origin/main', tip = 'HEAD', cwd }) {
  const mb = git(cwd, ['merge-base', base, tip]);
  if (!ok(mb)) return { status: 'skip', lines: [`merge-base of ${base} and ${tip} failed`] };
  const from = out(mb);
  const stale = checkStaleRevert({ base: from, tip, cwd });
  const bot = checkBotOwnedRewrite({ base: from, tip, cwd });
  const lines = [];
  if (stale.status === 'fail') {
    lines.push(`stale-tree revert: ${stale.count} of the ${stale.of} files this branch changes are put back to how they were at an older main commit (${stale.matches}), e.g. ${stale.sample.join(', ')}. It was likely built from a stale checkout and would undo work already on main. Rebuild it on a fresh origin/main.`);
  }
  if (bot.status === 'fail') {
    lines.push(`bot-owned rewrite: the branch rewrites ${bot.count} pipeline-owned files (e.g. ${bot.sample.join(', ')}); a deliberate change touches at most ${BOT_OWNED_MAX}. Usually a squash over a stale or failed merge.`);
  }
  const status = lines.length ? 'fail' : (stale.status === 'skip' && bot.status === 'skip' ? 'skip' : 'pass');
  if (status === 'skip') lines.push(`could not judge: ${stale.reason || bot.reason || 'unknown'}`);
  return { status, lines };
}


function main(argv) {
  if (!argv.includes('--ci-stale')) {
    process.stderr.write('usage: stale-tree-check.mjs --ci-stale [--base origin/main] [--tip HEAD] [--cwd DIR]\n');
    return 0;
  }
  const at = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const v = ciStaleTreeVerdict({ base: at('--base', 'origin/main'), tip: at('--tip', 'HEAD'), cwd: path.resolve(at('--cwd', process.cwd())) });
  for (const l of v.lines) process.stdout.write(`${v.status === 'fail' ? '::warning::' : ''}${l}\n`);
  process.stdout.write(`stale_tree=${v.status}\n`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    // Advisory: an internal error is a warning, never a failed step.
    process.stdout.write(`::warning::stale-tree check internal error: ${e && e.message}\nstale_tree=skip\n`);
    process.exitCode = 0;
  }
}
