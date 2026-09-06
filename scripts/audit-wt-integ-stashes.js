#!/usr/bin/env node
'use strict';

/**
 * Triage the shared git stash stack.
 *
 * READ ONLY. This script never drops, applies or pops anything — the stash
 * stack is shared across ~20 sessions and the wt-integ-* entries are the
 * deliberate recovery trace for another session's WIP (asserted by
 * tests/unit/merge-worktree-push-verification.test.mjs).
 *
 * It answers the one question the session-start hook's "inspect before
 * dropping" advice leaves to a human: which entries are safe churn, and which
 * would destroy a real file if applied.
 *
 * Usage:
 *   node scripts/audit-wt-integ-stashes.js            # report
 *   node scripts/audit-wt-integ-stashes.js --json     # machine-readable
 *   node scripts/audit-wt-integ-stashes.js --gate     # exit 1 if any entry is dangerous to apply
 *   node scripts/audit-wt-integ-stashes.js --sha <s>  # triage one stash commit by sha
 *
 * --sha exists because a clean stack proves nothing about detection. It lets
 * you re-run the detector against an entry that has already been dropped (the
 * commit stays reachable in the object store), which is how this script's
 * acceptance test is stated:
 *
 *   node scripts/audit-wt-integ-stashes.js --gate \
 *     --sha 93658d4585564daee0ac1e34be1142e5109cf7dc
 *
 * That is the real wt-integ-94224 entry from 2026-09-06, which held
 * scripts/lib/backlog-drain.js at one line against 231. It must exit 1.
 *
 * Exit codes: 0 clean, 1 something dangerous to apply (--gate only),
 * 2 bad usage, 3 the audit itself could not run.
 */

const { execFileSync } = require('child_process');
const { classifyStashedFile, classifyStashEntry } = require('./lib/stash-truncation');

let classifyPath = () => ({ tier: null });
try {
  ({ classifyPath } = require('./lib/infra-review-scope'));
} catch {
  /* scope module is optional; tier just stays null */
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const gate = args.includes('--gate');

const shaFlagIndex = args.indexOf('--sha');
let onlySha = null;
if (shaFlagIndex !== -1) {
  const value = args[shaFlagIndex + 1];
  // Without this, `--sha --json` silently consumes the next FLAG as a sha.
  if (!value || value.startsWith('--')) {
    console.error('--sha requires a commit sha');
    process.exit(2);
  }
  onlySha = value;
}

function fail(message) {
  console.error('audit-wt-integ-stashes: ' + message);
  process.exit(3);
}

/**
 * Run git. `soft` marks calls whose failure is a legitimate answer (a path
 * that does not exist at a rev); everything else is a real error and must be
 * surfaced rather than silently becoming an all-clear.
 */
function run(gitArgs, { soft = false } = {}) {
  try {
    return execFileSync('git', gitArgs, {
      encoding: 'utf-8',
      maxBuffer: 512 * 1024 * 1024,
      // Never let git's own stderr interleave with the report: an absent path
      // prints "fatal: path ... does not exist", which makes a healthy run
      // look broken.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (soft) return { __error: String((err && err.stderr) || err.message || err) };
    return null;
  }
}

/** True when git's complaint is specifically "that path isn't at that rev". */
function isAbsentPathError(stderr) {
  return (
    /does not exist in/.test(stderr) ||
    /exists on disk, but not in/.test(stderr) ||
    /^fatal: path /m.test(stderr)
  );
}

/**
 * Line count of a blob at <rev>:<path>.
 * Returns {lines} | {absent:true} | {error:'...'}. A git failure that is NOT
 * "path absent" must not be reported as a deletion.
 */
function linesAt(rev, filePath) {
  const out = run(['show', rev + ':' + filePath], { soft: true });
  if (out && typeof out === 'object' && out.__error) {
    if (isAbsentPathError(out.__error)) return { absent: true };
    return { error: out.__error.trim().split('\n')[0] };
  }
  if (typeof out !== 'string') return { error: 'unreadable blob' };
  if (out === '') return { lines: 0 };
  return { lines: out.split('\n').length - (out.endsWith('\n') ? 1 : 0) };
}

function listStashes() {
  const out = run(['stash', 'list', '--format=%H%x00%gd%x00%gs']);
  // A failed `git stash list` must not look like an empty stack.
  if (out === null) fail('could not read the stash list (not a git repository?)');
  if (!out.trim()) return [];
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [sha, ref, subject] = line.split('\0');
      return { sha, ref, subject };
    });
}

function parentCount(sha) {
  const out = run(['rev-list', '--parents', '-n', '1', sha]);
  if (out === null) return 0;
  return out.trim().split(/\s+/).length - 1;
}

/**
 * Every path the stash would write, with the rev to read each from.
 *
 * Two things the obvious `git diff sha^ sha` misses:
 *  - rename detection prints only the destination, hiding the file the apply
 *    would delete, so renames are switched off;
 *  - a `-u` stash keeps its untracked payload in a THIRD parent that the
 *    tracked diff never sees (stash@{10} on this machine has 3 parents).
 */
function stashFiles(sha) {
  const tracked = run([
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-renames',
    '-z',
    '--name-only',
    sha + '^',
    sha,
  ]);
  if (tracked === null) return { failed: true, files: [] };

  const files = tracked
    .split('\0')
    .filter(Boolean)
    .map((p) => ({ path: p, stashRev: sha, baseRev: sha + '^' }));

  if (parentCount(sha) >= 3) {
    const untracked = run([
      '-c',
      'core.quotePath=false',
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      sha + '^3',
    ]);
    if (untracked === null) return { failed: true, files };
    const tracked_paths = new Set(files.map((f) => f.path));
    for (const p of untracked.split('\0').filter(Boolean)) {
      // A path can appear BOTH in the tracked diff and in ^3 (git rm --cached
      // with a stub left on disk). Reporting it twice gave the same file two
      // contradictory verdicts in one entry — "do NOT apply" beside "nothing is
      // overwritten". The tracked entry is the meaningful one, so it wins.
      if (tracked_paths.has(p)) continue;
      // Untracked payload: present only in ^3, and overwrites nothing.
      files.push({ path: p, stashRev: sha + '^3', baseRev: null });
    }
  }

  return { failed: false, files };
}

/**
 * Paths git reports as undiffable (numstat prints "-" for both counts).
 *
 * -z matters: without it git C-quotes any path containing a quote, tab or
 * control character even under core.quotePath=false, while the --name-only -z
 * listing returns those paths raw. The two spellings then never match, and a
 * genuinely undiffable file is silently judged as ordinary text.
 */
function binaryPaths(sha) {
  const out = run([
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-renames',
    '--numstat',
    '-z',
    sha + '^',
    sha,
  ]);
  if (out === null) return new Set();
  const set = new Set();
  // With -z an ordinary record is "<added>\t<deleted>\t<path>\0" — the path is
  // TAB-separated inside the record, not its own NUL-delimited token. (Only
  // rename records split the paths out with NULs, and --no-renames means we
  // never see those.) Parsing it pairwise silently matched nothing, which made
  // binary detection dead code.
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const [added, deleted] = parts;
    const filePath = parts.slice(2).join('\t');
    if (added === '-' && deleted === '-') set.add(filePath);
  }
  return set;
}

/** Blob size in bytes at <rev>:<path>, or null when it cannot be read. */
function bytesAt(rev, filePath) {
  const out = run(['cat-file', '-s', rev + ':' + filePath]);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

function triage(stash) {
  const { failed, files: paths } = stashFiles(stash.sha);
  const binaries = binaryPaths(stash.sha);
  const files = [];

  for (const { path: filePath, stashRev, baseRev } of paths) {
    const stashed = linesAt(stashRev, filePath);
    const base = baseRev === null ? { absent: true } : linesAt(baseRev, filePath);
    const { tier } = classifyPath(filePath) || { tier: null };

    if (stashed.error || base.error) {
      files.push({
        path: filePath,
        stashedLines: null,
        baseLines: null,
        infraTier: tier,
        verdict: 'error',
        severity: 'danger',
        reason: 'could not read this path from git: ' + (stashed.error || base.error),
      });
      continue;
    }

    const isBinary = binaries.has(filePath);
    const verdict = classifyStashedFile({
      path: filePath,
      stashedLines: stashed.absent ? null : stashed.lines,
      baseLines: base.absent ? null : base.lines,
      infraTier: tier,
      binary: isBinary,
      // Only pay for the size lookups when they will actually be used.
      stashedBytes: isBinary && !stashed.absent ? bytesAt(stashRev, filePath) : null,
      baseBytes: isBinary && !base.absent && baseRev ? bytesAt(baseRev, filePath) : null,
    });
    files.push({
      path: filePath,
      stashedLines: stashed.absent ? null : stashed.lines,
      baseLines: base.absent ? null : base.lines,
      infraTier: tier,
      ...verdict,
    });
  }

  return { ...stash, ...classifyStashEntry(files, { enumerationFailed: failed }), files };
}

/** Resolve one stash commit by sha, for re-checking an entry already dropped. */
function stashBySha(sha) {
  const full = run(['rev-parse', '--verify', sha + '^{commit}']);
  if (!full) {
    console.error('sha not found in this repository: ' + sha);
    process.exit(2);
  }
  const resolved = full.trim();
  const subject = (run(['log', '-1', '--format=%s', resolved]) || '').trim();
  return [{ sha: resolved, ref: resolved.slice(0, 9), subject: subject || '(dropped stash entry)' }];
}

function main() {
  const stashes = onlySha ? stashBySha(onlySha) : listStashes();
  const report = stashes.map(triage);
  const dangerous = report.filter((r) => r.danger);

  if (asJson) {
    console.log(
      JSON.stringify({ total: report.length, dangerous: dangerous.length, entries: report }, null, 2)
    );
  } else {
    console.log(
      'Stash triage — ' + report.length + ' entr' + (report.length === 1 ? 'y' : 'ies') +
        ' on the shared stack\n'
    );
    for (const r of report) {
      const mark = r.danger ? 'DANGER' : r.severity === 'warn' ? 'INSPECT' : 'ok';
      console.log('  [' + mark + '] ' + r.ref + '  ' + r.subject);
      console.log('      verdict: ' + r.verdict);
      for (const f of r.files) {
        if (f.verdict === 'telemetry') continue;
        console.log('      - ' + f.path + ' [' + f.verdict + '] ' + f.reason);
      }
      const telemetryCount = r.files.filter((f) => f.verdict === 'telemetry').length;
      if (telemetryCount) console.log('      (+' + telemetryCount + ' telemetry path(s))');
    }
    console.log('');
    if (dangerous.length) {
      console.log(
        dangerous.length + ' entr' + (dangerous.length === 1 ? 'y is' : 'ies are') +
          ' DANGEROUS TO APPLY:'
      );
      for (const r of dangerous) {
        console.log('  ' + r.ref + ' (' + r.subject + ') — sha ' + r.sha);
      }
      console.log('\nDo not apply these to "recover" anything. Inspect a file with:');
      console.log('  git show "${SHA}:<path>"');
      console.log('  (note the braces: in zsh, "$SHA:path" parses :s as a substitute');
      console.log('   modifier, silently drops the path, and shows the WHOLE commit)');
    } else {
      console.log('No entry on the stack would destroy a file if applied.');
    }
  }

  if (gate && dangerous.length) process.exitCode = 1;
}

main();
