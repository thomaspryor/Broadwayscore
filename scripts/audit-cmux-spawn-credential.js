#!/usr/bin/env node
/**
 * audit-cmux-spawn-credential.js — blocking lint: nothing outside
 * scripts/lib/cmux-workspaces.js may spawn the cmux binary directly.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-07 a cmux upgrade set automation.socketControlMode="cmuxOnly",
 * which admits only processes whose ancestry is inside cmux. Every launchd-run
 * automation was denied at the socket, three independent recovery layers died
 * at the same instant, and nothing paged for ~2h (BRO-2959).
 *
 * The fix put the credential at the spawn boundary. But it was enforced by a
 * comment, and two spawn sites were still missed across nine review rounds
 * (BRO-3001) — one using the re-exported `cmuxws.CMUX` constant, one a bare
 * `cmux` off PATH, neither visible to a grep for the absolute app path.
 * This is that comment, executable.
 *
 * THE FIX AT A CALL SITE (in preference order)
 *   1. Call the wrapper: cmuxws.run(args) / listWorkspaces() /
 *      sendToWorkspace() / closeWorkspace(). You get the credential, the
 *      3-rung auth-denied retry ladder (which survives a ROTATED password),
 *      a 30s timeout, and stderr capture — none of which a hand-rolled
 *      `env: cmuxSpawnEnv(process.env)` gives you.
 *   2. If the call genuinely cannot route through the wrapper, at minimum pass
 *      `env: cmuxSpawnEnv(process.env)` from scripts/lib/cmux-socket-auth.js.
 *      This is still reported, at severity 'ladder', because attempt 1 is all
 *      you get.
 *   3. Reviewed false positive: waive with an inline `cmux-spawn-ok: <reason>`
 *      comment on the offending line or the line above it.
 *
 * Detection logic is pure and unit-tested in scripts/lib/cmux-spawn-guard.js
 * (+ .test.mjs) per project rule §15; this file only walks the filesystem and
 * formats the report.
 *
 * Usage:
 *   node scripts/audit-cmux-spawn-credential.js            blocking lint (exit 1 on violation)
 *   node scripts/audit-cmux-spawn-credential.js --verbose  also list the files scanned
 *   <changed-files> | ... --scope-stdin                    only changed files block
 *   --help, -h
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { findUnguardedCmuxSpawns, SPAWN_OWNER } = require('./lib/cmux-spawn-guard.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'llm-scoring-cache', '__pycache__']);
// .ts included: scripts/ holds 56 TypeScript files and they compile to the
// same child_process calls (ship-check finding — the first version scanned
// .js/.mjs/.cjs only, leaving a whole language out of a guard whose entire
// point is that no spawn site is invisible). .sh is NOT scanned: a shell
// script invoking cmux is a different shape this JS-call parser cannot read,
// and pretending otherwise would be a vacuous pass.
const CODE_RE = /\.(js|mjs|cjs|ts)$/;
// Test files are excluded on purpose. A guard's own test suite quotes the
// violating shapes verbatim as fixtures — cmux-spawn-guard.test.mjs contains a
// dozen credential-less spawns inside string literals — so scanning tests makes
// the guard report itself and nothing else. The invariant is about production
// call sites; a test never spawns cmux for real.
const SKIP_FILE_RE = /\.test\.(mjs|js|cjs|ts)$/;

const USAGE = `audit-cmux-spawn-credential.js — no direct cmux spawns outside ${SPAWN_OWNER}

  node scripts/audit-cmux-spawn-credential.js            blocking lint (whole tree)
  node scripts/audit-cmux-spawn-credential.js --verbose  also list files scanned
  <changed-files> | node scripts/audit-cmux-spawn-credential.js --scope-stdin
                                                        only changed files block
  --help, -h`;

// Unreadable paths are COLLECTED, not swallowed (ship-check finding, Codex).
// A silently skipped directory or file made the audit print
// "✅ every cmux spawn carries the socket credential" with a quietly reduced
// file count — a green that means "I did not look", which is the same shape of
// vacuous pass this very commit fixes in liveWorkspaceRefs. Anything we could
// not read is reported and fails the run.
function walk(dir, out = [], errors = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    errors.push(`${path.relative(REPO, dir)}: ${e.code || e.message}`);
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out, errors);
    } else if (e.isFile() && CODE_RE.test(e.name) && !SKIP_FILE_RE.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const verbose = argv.includes('--verbose');

  // --scope-stdin: only files in THIS push's changed set are BLOCKING. The
  // main checkout is shared by 20+ concurrent worktree/cmux sessions, so an
  // unscoped full-tree scan at push time blocks whoever pushes next on a
  // violation someone else introduced — the shared-fate failure
  // run-push-audits.sh:165 already documents for lint-write-routing, and that
  // audit-orphan-tests.js:293 solved the same way. CI's direct call passes no
  // flag and keeps scanning the whole tree, which is correct there: CI's
  // checkout IS the branch under test. Out-of-scope violations are still
  // PRINTED, so nothing goes unseen — they just do not fail someone else's push.
  const scopeStdin = argv.includes('--scope-stdin');
  const scope = scopeStdin
    ? new Set(fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean))
    : null;

  const errors = [];
  const files = SCAN_ROOTS.flatMap(r => walk(path.join(REPO, r), [], errors));
  const violations = [];
  for (const file of files) {
    const rel = path.relative(REPO, file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      errors.push(`${rel}: ${e.code || e.message}`);
      continue;
    }
    for (const f of findUnguardedCmuxSpawns(text, rel)) {
      violations.push({ file: rel, inScope: !scope || scope.has(rel), ...f });
    }
  }

  if (verbose) console.log(`scanned ${files.length} files under ${SCAN_ROOTS.join(', ')}`);

  if (errors.length) {
    console.error(`\n❌ cmux-spawn-credential: ${errors.length} path(s) could not be read — this run did NOT scan the tree:\n`);
    for (const e of errors) console.error(`  ${e}`);
    console.error('\nA guard that cannot read the files it lints must fail, not pass quietly.\n');
    return 1;
  }

  // Two severities, and only ONE of them blocks.
  //
  // 'credential' — the call carries no credential at all. This is the BRO-2959
  // outage shape and the two BRO-3001 misses; it is denied outright the moment
  // the socket mode is not ancestry-based, so it blocks.
  //
  // 'ladder' — the call carries cmuxSpawnEnv but bypasses the retry ladder.
  // Seven such sites shipped deliberately in BRO-2959 (overnight-digest.js:145
  // even reasons about which env to pass), and several genuinely cannot use
  // the wrapper: probe-cmux-launch.js needs spawnSync's status code, and
  // cmux-launch.js:1210 is an injectable probe seam. Blocking on those would
  // fail CI on day one and force seven refactors nobody asked for. They are
  // reported every run so the weaker guarantee stays visible — a rotated
  // password still fails them — but they do not gate a push.
  const credentialLess = violations.filter(v => v.severity === 'credential');
  const blocking = credentialLess.filter(v => v.inScope);
  const outOfScope = credentialLess.filter(v => !v.inScope);
  const advisory = violations.filter(v => v.severity !== 'credential');

  const show = (v) => {
    const stream = v.severity === 'credential' ? console.error : console.log;
    stream(`  ${v.file}:${v.line}  [${v.severity}] ${v.fn}(...)`);
    stream(`      ${v.snippet}`);
    stream(`      ${v.reason}\n`);
  };

  if (advisory.length) {
    console.log(`\nℹ️  cmux-spawn-credential: ${advisory.length} call(s) carry the credential but bypass ${SPAWN_OWNER}'s retry ladder (not blocking)\n`);
    advisory.forEach(show);
  }

  if (outOfScope.length) {
    console.log(`\n⚠️  cmux-spawn-credential: ${outOfScope.length} credential-less spawn(s) exist OUTSIDE this push's changed files — reported, not blocking (another session's to fix)\n`);
    outOfScope.forEach(v => console.log(`  ${v.file}:${v.line}  ${v.fn}(...)`));
    console.log('');
  }

  if (!blocking.length) {
    console.log(`✅ cmux-spawn-credential: every cmux spawn carries the socket credential (${files.length} files scanned${scope ? `, ${scope.size} in scope` : ''})`);
    return 0;
  }

  console.error(`\n❌ cmux-spawn-credential: ${blocking.length} cmux spawn(s) with NO socket credential\n`);
  blocking.forEach(show);
  console.error('Fix, in preference order:');
  console.error(`  1. route the call through ${SPAWN_OWNER} (run / listWorkspaces / sendToWorkspace / closeWorkspace)`);
  console.error("  2. if it truly cannot, pass env: cmuxSpawnEnv(process.env) — downgrades this to a non-blocking 'ladder' note");
  console.error('  3. reviewed false positive: inline comment  cmux-spawn-ok: <reason>\n');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, USAGE };
