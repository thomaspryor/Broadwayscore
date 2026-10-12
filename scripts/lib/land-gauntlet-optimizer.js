#!/usr/bin/env node
'use strict';
// scripts/lib/land-gauntlet-optimizer.js — decide whether land.yml's `checks`
// job can skip BOTH gauntlet runs (base and branch) for a branch (BRO-4299).
//
// Each gauntlet is ~16 min of runner time (land.yml's budget comment), and
// a land/** branch that only edits prose still paid for one or two of them.
// The skip is allowed ONLY when every changed path vs the base is provably
// unable to change a gate verdict:
//
//   1. the path is a Markdown file (.md) under memory/, cloud-memory/, docs/
//      or at the repo root, and not an agent-instruction file (CLAUDE.md,
//      AGENTS.md, GEMINI.md: claude-md-integrity and other checks read
//      those). Everything else (src/, scripts/, tests/, .github/, .claude/,
//      data/, public/, content/, package*.json, configs, any other path or
//      extension) never skips.
//   2. its change is a plain add, modify or delete of a regular file (no
//      symlink or gitlink: lint-workflows' tracked-symlinks check reads modes;
//      no type change; renames are split by `--no-renames`, so both sides are
//      judged).
//   3. no file that could read it names it: its basename and its stem do not
//      appear in any tracked file outside memory/, cloud-memory/, docs/ and
//      Markdown (git grep, fixed strings). Tests DO read some of these files
//      (memory/hooks-audit.md, docs/dispatcher-safety-port-table.md,
//      docs/workflow-dependency-graph.md), so prefix rules alone are not
//      enough.
//
// Why skipping both runs is sound, not just cheaper: every path rule 1 allows
// is outside the verification-relevant code tree (land-gate-delta.js
// isCacheKeyRelevant is false for all of them; the test suite pins this), so
// the rebased tip runs the same code against the same private data as the
// base and, by rule 3, no check reads what changed. The new-failures-vs-base
// delta is therefore empty by construction. A pre-existing red on main is
// not blocking under the delta rule either; under LAND_STRICT_GATES=1 (any
// red refuses) a skip could bypass that, so strict mode never skips.
// test.yml still runs every check on main for the landed sha.
//
// Fail closed everywhere: any parse error, git error, unknown status or path,
// an empty diff, or more than MAX_FILES paths means "run the gauntlet". The
// CLI writes skip=true to $GITHUB_OUTPUT only as its very last action on a
// positive decision, so a crash anywhere leaves land.yml on the full path.
//
// Self-contained (node built-ins only): land.yml runs the BASE tree's copy
// from $RUNNER_TEMP, so a branch cannot edit this file to skip its own
// gauntlet, and a base without the file means no skip.
//
// CLI:
//   node land-gauntlet-optimizer.js --base <sha> --head <sha>
//        [--cwd DIR] [--github-output FILE] [--summary-file FILE] [--strict]
// Exit 0 with a decision printed (skip or run); exit 1 on any error.

const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

// Bounds the one-pass reference grep (~1s for a handful of needles; it grows
// with the needle count) and keeps the skip to small prose-only branches.
const MAX_FILES = 50;

// Directories whose Markdown is prose nobody executes.
const PROSE_DIR_RE = /^(memory|cloud-memory|docs)\/[^\0]+$/;
// Agent-instruction files are read by checks (claude-md-integrity, codex
// parity tests) wherever they live.
const INSTRUCTION_BASENAMES = new Set(['claude.md', 'agents.md', 'gemini.md']);
// Never skippable, whatever the extension. Belt and braces: rule 1 already
// excludes them, but a future edit to PROSE_DIR_RE must not open these.
const HARD_DENY_RE = /^(src|scripts|tests|\.github|\.claude|tools|supabase|data|public|content|node_modules)\//;
const HARD_DENY_ROOT_FILES_RE = /^(package(-lock)?\.json|tsconfig[^/]*\.json|[^/]*\.config\.[a-z]+|vercel\.json|\.[^/]*)$/i;
// Regular-file modes only (no 120000 symlink, no 160000 gitlink).
const REGULAR_MODES = new Set(['100644', '100755', '000000']);
const ALLOWED_STATUSES = new Set(['A', 'M', 'D']);
// Never searched for references: prose, which reads nothing.
const READER_EXCLUDES = [':(exclude)memory/', ':(exclude)cloud-memory/', ':(exclude)docs/', ':(exclude,glob)**/*.md'];

function basenameOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** { skippable, reason } for one repo-relative path, ignoring references. */
function classifyPath(p) {
  const file = String(p == null ? '' : p);
  if (!file) return { skippable: false, reason: 'empty path' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(file) || file.startsWith('/') || file.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    return { skippable: false, reason: 'unsafe path' };
  }
  if (HARD_DENY_RE.test(file)) return { skippable: false, reason: 'code/config/data tree' };
  if (!file.includes('/') && HARD_DENY_ROOT_FILES_RE.test(file)) return { skippable: false, reason: 'root config file' };
  if (!file.endsWith('.md')) return { skippable: false, reason: 'not Markdown' };
  if (INSTRUCTION_BASENAMES.has(basenameOf(file).toLowerCase())) return { skippable: false, reason: 'agent-instruction file' };
  if (file.includes('/') && !PROSE_DIR_RE.test(file)) return { skippable: false, reason: 'Markdown outside memory/, cloud-memory/, docs/ and the root' };
  return { skippable: true, reason: 'prose' };
}

/**
 * Parse `git diff --raw --no-renames -z` output into
 * [{ path, status, oldMode, newMode }]. Throws on anything it does not
 * understand (the caller fails closed).
 */
function parseRawDiff(text) {
  const parts = String(text).split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i];
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(meta);
    if (!m) throw new Error(`parseRawDiff: unexpected record ${JSON.stringify(meta)}`);
    const status = m[3];
    if (status === 'R' || status === 'C') throw new Error(`parseRawDiff: rename/copy record (${status}) — run git with --no-renames`);
    const p = parts[++i];
    if (p === undefined) throw new Error('parseRawDiff: record without a path');
    out.push({ path: p, status, oldMode: m[1], newMode: m[2] });
  }
  return out;
}

/** Strings whose presence in a reader file means it may read `p`. */
function referenceNeedles(p) {
  const base = basenameOf(String(p));
  const stem = base.replace(/\.md$/, '');
  return stem && stem !== base ? [base, stem] : [base];
}

/**
 * Pure decision.
 *   changes:      [{ path, status, oldMode, newMode }]
 *   isReferenced: (path) => boolean — true when a reader names the path
 *   strict:       LAND_STRICT_GATES is on
 * Returns { skip, reason, blockers: [{ path, reason }], paths }.
 */
function decideGauntletSkip({ changes, isReferenced, strict = false } = {}) {
  const list = Array.isArray(changes) ? changes : null;
  if (!list) return { skip: false, reason: 'no change list', blockers: [], paths: [] };
  const paths = list.map((c) => (c && c.path) || '');
  if (strict) return { skip: false, reason: 'LAND_STRICT_GATES=1: strict parity refuses a red main, so the gauntlet always runs', blockers: [], paths };
  if (list.length === 0) return { skip: false, reason: 'no changed paths vs base', blockers: [], paths };
  if (list.length > MAX_FILES) return { skip: false, reason: `${list.length} changed paths (cap ${MAX_FILES})`, blockers: [], paths };
  if (typeof isReferenced !== 'function') return { skip: false, reason: 'no reference checker', blockers: [], paths };

  const blockers = [];
  for (const c of list) {
    const p = c && c.path;
    const cls = classifyPath(p);
    if (!cls.skippable) { blockers.push({ path: String(p), reason: cls.reason }); continue; }
    if (!ALLOWED_STATUSES.has(c.status)) { blockers.push({ path: p, reason: `status ${c.status}` }); continue; }
    if (!REGULAR_MODES.has(c.oldMode) || !REGULAR_MODES.has(c.newMode)) { blockers.push({ path: p, reason: `mode ${c.oldMode}->${c.newMode}` }); continue; }
    if (isReferenced(p)) { blockers.push({ path: p, reason: 'named by a tracked code/test/workflow file' }); continue; }
  }
  if (blockers.length) {
    return { skip: false, reason: `${blockers.length} of ${list.length} changed path(s) need the gauntlet`, blockers, paths };
  }
  return { skip: true, reason: `all ${list.length} changed path(s) are unreferenced prose`, blockers, paths };
}

// ── git-backed helpers (CLI) ────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * One `git grep` pass over every tracked non-prose file in the worktree for
 * all needles at once (fixed strings, case-sensitive: -i made it minutes, not
 * seconds, over this repo), then every needle is tested against every
 * printed line. Not `-o`: with overlapping needles ("foo", "foobar") -o
 * reports one match per position, which could hide "foobar" and fail open.
 * Returns a checker (path) => boolean. Throws on git errors or a timeout
 * (the caller fails closed).
 */
function makeGitReferenceChecker(cwd, paths) {
  const needles = [...new Set((paths || []).flatMap(referenceNeedles))];
  const found = new Set();
  if (needles.length) {
    const args = ['grep', '-h', '-I', '-F'];
    for (const n of needles) args.push('-e', n);
    args.push('--', '.', ...READER_EXCLUDES);
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 180000 });
    if (r.error) throw new Error(`git grep could not run: ${r.error.message}`);
    if (r.status !== 0 && r.status !== 1) throw new Error(`git grep failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
    const lines = String(r.stdout || '').split('\n');
    for (const n of needles) if (lines.some((line) => line.includes(n))) found.add(n);
  }
  return (p) => referenceNeedles(p).some((n) => found.has(n));
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    if (eq !== -1) { a[t.slice(2, eq)] = t.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { a[t.slice(2)] = next; i++; } else a[t.slice(2)] = true;
  }
  return a;
}

function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const args = parseArgs(argv);
  const cwd = args.cwd ? String(args.cwd) : process.cwd();
  const base = String(args.base || '');
  const head = String(args.head || '');
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) throw new Error('need --base and --head as full 40-hex shas');
  // The reference scan reads the worktree, so it must BE the tree under test.
  const actual = git(cwd, ['rev-parse', 'HEAD']).trim();
  if (actual !== head) throw new Error(`HEAD is ${actual}, not --head ${head}`);
  const strict = args.strict === true || String(args.strict || '') === '1';

  const changes = parseRawDiff(git(cwd, ['diff', '--raw', '--no-renames', '-z', '--no-abbrev', base, head]));
  const candidates = changes.filter((c) => classifyPath(c.path).skippable).map((c) => c.path);
  const isReferenced = changes.length > 0 && changes.length <= MAX_FILES && !strict
    ? makeGitReferenceChecker(cwd, candidates)
    : () => true;
  const decision = decideGauntletSkip({ changes, isReferenced, strict });

  const lines = [
    '### land.yml gauntlet optimizer (BRO-4299)',
    '',
    `- decision: ${decision.skip ? 'SKIP both gauntlets (verdict GREEN by construction)' : 'RUN the full gauntlet'}`,
    `- reason: ${decision.reason}`,
    ...decision.blockers.slice(0, 20).map((b) => `- needs gauntlet: \`${b.path}\` (${b.reason})`),
    decision.blockers.length > 20 ? `- … and ${decision.blockers.length - 20} more` : '',
    ...(decision.skip ? decision.paths.map((p) => `- prose: \`${p}\``) : []),
  ].filter(Boolean);
  log(lines.join('\n'));
  if (args['summary-file']) fs.appendFileSync(String(args['summary-file']), `${lines.join('\n')}\n`);
  // Last action, and only on a positive decision: anything that throws
  // before here leaves the output unset and land.yml runs the gauntlet.
  if (args['github-output']) fs.appendFileSync(String(args['github-output']), `skip=${decision.skip ? 'true' : 'false'}\n`);
  return decision;
}

module.exports = {
  MAX_FILES,
  READER_EXCLUDES,
  classifyPath,
  parseRawDiff,
  referenceNeedles,
  decideGauntletSkip,
  makeGitReferenceChecker,
  main,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`::warning::land-gauntlet-optimizer: ${e.message} — running the full gauntlet`);
    process.exit(1);
  }
}
