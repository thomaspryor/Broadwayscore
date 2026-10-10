#!/usr/bin/env node
/**
 * land.js — hand-land a branch on origin/main through the ONE landing lib
 * (scripts/lib/land-branch.js; BRO-3873 step 2).
 *
 *   node scripts/land.js --branch <name> [--dry-run] [--repo <dir>] [--max-attempts N]
 *                        [--source auto|local|origin] [--expect-tip <sha>]
 *                        [--verified-base <sha>] [--result-file <path>]
 *
 * Prints exactly one verdict line and exits 0/1:
 *   LANDED: <branch> → <sha> in <s>s (attempts N)
 *   REFUSED: <reason>
 *   DRY-RUN OK: <branch> → <sha> checks green …   (--dry-run only; exit 0)
 *
 * Safe to run from the shared main checkout: the lib does all of its work in
 * a throwaway detached worktree it creates and removes itself, so the
 * checkout you run this from is never checked out, reset, or otherwise
 * touched — only its object store and remote are used. The branch ref is
 * never modified either; on a refusal it is exactly where you left it.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const fs = require('fs');
const { landBranch, formatLandLine, makeVerifiedBaseChecks, MAX_ATTEMPTS } = require('./lib/land-branch.js');

const USAGE = `land.js — land a branch on origin/main: rebase → checks → fast-forward push.

Usage:
  node scripts/land.js --branch <name> [--dry-run] [--repo <dir>] [--max-attempts N]

  --branch <name>     local branch (or origin/<name>) to land
  --dry-run           rebase + run the checks in an isolated worktree, never push
  --repo <dir>        checkout whose object store/remote to use (default: the
                      checkout you run this from; falls back to this script's repo)
  --max-attempts N    rebase+check+push rounds before refusing (default ${MAX_ATTEMPTS})
  --source S          auto (local ref, else origin) | local | origin (default auto)
  --expect-tip SHA    refuse unless the branch tip resolves to exactly this sha
                      (land.yml: the tip its checks job verified)
  --verified-base SHA the origin/main sha an upstream gauntlet already verified
                      this branch against (land.yml's checks job); the gauntlet
                      is skipped only while main is that sha or has moved past
                      it across inert paths, otherwise it runs in full
  --result-file PATH  also write the full result object as JSON to PATH
  --help, -h          print this and exit — no git calls

Output: one line, "LANDED: …" (exit 0) or "REFUSED: …" (exit 1).`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    if (eq !== -1) { a[t.slice(2, eq)] = t.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { a[t.slice(2)] = next; i++; }
    else a[t.slice(2)] = true;
  }
  return a;
}

// The checkout the CLI was invoked FROM, not the one this file lives in: a
// worktree session's copy of land.js is expected to land branches through the
// shared main checkout's object store/remote when run from there.
function cwdRepo() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function main(argv = process.argv.slice(2), land = landBranch) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const args = parseArgs(argv);
  if (!args.branch || args.branch === true) {
    console.error('usage: node scripts/land.js --branch <name> [--dry-run]');
    return 2;
  }
  const maxAttempts = args['max-attempts'] ? Number(args['max-attempts']) : MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    console.error(`--max-attempts must be a positive integer (got ${args['max-attempts']})`);
    return 2;
  }
  const isSha = (v) => /^[0-9a-f]{40}$/.test(String(v || ''));
  for (const flag of ['expect-tip', 'verified-base']) {
    if (args[flag] !== undefined && !isSha(args[flag])) {
      console.error(`--${flag} must be a full 40-hex sha (got ${JSON.stringify(args[flag])})`);
      return 2;
    }
  }
  const source = args.source === undefined ? 'auto' : String(args.source);
  if (!['auto', 'local', 'origin'].includes(source)) {
    console.error(`--source must be auto|local|origin (got ${JSON.stringify(args.source)})`);
    return 2;
  }
  const result = land({
    branch: args.branch,
    repoDir: args.repo ? path.resolve(String(args.repo)) : cwdRepo(),
    dryRun: args['dry-run'] === true,
    maxAttempts,
    source,
    expectSha: args['expect-tip'] || null,
    ...(args['verified-base'] ? { checks: makeVerifiedBaseChecks({ verifiedBase: args['verified-base'] }) } : {}),
    log: (m) => console.error(m),
  });
  if (args['result-file'] && args['result-file'] !== true) {
    fs.writeFileSync(String(args['result-file']), `${JSON.stringify({ branch: args.branch, ...result }, null, 2)}\n`);
  }
  console.log(formatLandLine(args.branch, result));
  // A dry-run whose checks are green is a success for the caller asking
  // "would this land?" — only a real refusal (red check, conflict, lost race) is exit 1.
  return result.landed || result.dryRun ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.log(`REFUSED: fatal: ${String(err.message).split('\n')[0]}`);
    process.exit(1);
  }
}

module.exports = { main, parseArgs, USAGE };
