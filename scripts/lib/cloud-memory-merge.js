#!/usr/bin/env node
// scripts/lib/cloud-memory-merge.js — merge-aware reconciliation between the
// local-authoritative memory dir and the repo's cloud-memory/ mirror.
//
// WHY THIS EXISTS (BRO-103)
// ------------------------
// sync-memory-to-repo.sh used to mirror with `rsync -a --delete`, which treats
// the local ~/.claude/projects/<enc>/memory dir as absolute truth. That is
// wrong: cloud-memory/ has a SECOND set of writers. Cloud Claude Code sessions
// (iOS, Mac app, claude.ai/code) have no ~/.claude at all — when they learn
// something they commit the memo straight into cloud-memory/. So does any
// parallel local session that edits the mirror directly.
//
// To `--delete`, a file that exists in the mirror but not in the local source
// is indistinguishable from a file the owner deleted locally, so it deletes it.
// 2026-05-24: cloud-memory/feedback_nonprofit_venue_vs_production.md, committed
// by a cloud session, was wiped 12 minutes later by the next local
// session-stop. Nothing errored; the memo was simply gone.
//
// THE FIX: a three-way merge. `rsync --delete` fails because it only sees two
// states (src, dest) and a deletion is only detectable against a THIRD — what
// the mirror looked like the last time we synced it. We persist that common
// ancestor as a manifest (name -> sha256 of the content we last wrote to the
// mirror) and use it to tell the two cases apart:
//
//   dest-only, IS in manifest, unchanged since  -> we put it there, the owner
//                                                  deleted it locally -> delete
//   dest-only, NOT in manifest                  -> it arrived from a cloud or
//                                                  parallel session -> ADOPT it
//                                                  into the local source; never
//                                                  delete
//
// Content divergence is resolved the same way (see planSync below). Whenever
// both sides changed, the local source wins in the mirror but the mirror's
// version is preserved under <src>/_conflicts/ — the invariant this module
// exists to hold is that NOTHING IS EVER DROPPED WITHOUT A COPY SURVIVING.
//
// The manifest lives in the repo's .git dir: per-checkout, never committed,
// and never carried between machines by the ~/.claude private-repo sync (a
// manifest from another machine would describe a mirror this machine never
// wrote, which is exactly the bad input that produces a wrong deletion).
// When the manifest is missing (first run after this change, fresh clone,
// pruned .git) the merge runs in BOOTSTRAP mode: no deletions at all.
//
// Pure decision function (planSync) + I/O wrapper (applySync), per CLAUDE.md
// rule 15. Tested by scripts/cloud-memory-sync.test.mjs, which require()s
// these functions rather than restating them.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_VERSION = 1;
const MANIFEST_BASENAME = 'cloud-memory-sync-manifest.json';

// Where a mirror-side version that lost a conflict is parked. A subdirectory of
// the local source, so it is NOT itself mirrored (only root-level *.md is) and
// cannot start a ping-pong of conflict files between the two sides.
const CONFLICT_DIR = '_conflicts';

// Files that are never adopted from the mirror into the local memory dir even
// when the mirror's copy is the changed one. MEMORY.md is the auto-loaded
// index, hard-capped at 180 lines by ~/.claude/hooks/memory-index-cap-guard.sh
// — and that hook is a PreToolUse guard on Edit/Write, so a plain
// fs.copyFileSync sails straight past it. Adopting a cloud-written index would
// silently install an over-cap index that later sessions truncate from the
// bottom. Local wins instead, and the mirror's version is preserved like any
// other conflict, so nothing is lost and a human decides.
const NEVER_ADOPT = new Set(['MEMORY.md']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Hash one file, or undefined if it isn't there. Used to re-check a target
 *  immediately before mutating it (see applySync's verify-before-mutate). */
function hashFile(filePath) {
  try {
    return sha256(fs.readFileSync(filePath));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Two { name: hash } maps describe the same set of files with the same content. */
function sameHashes(a, b) {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

/**
 * Hash every root-level *.md in `dir`. Returns { name: sha256 }.
 * Subdirectories, dotfiles and non-.md files are ignored — this matches the
 * `--include='*.md' --exclude='*'` filter the rsync mirror always used, so
 * non-.md content on either side is neither copied nor deleted.
 */
function hashDir(dir) {
  const out = {};
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name.startsWith('.')) continue;
    out[entry.name] = sha256(fs.readFileSync(path.join(dir, entry.name)));
  }
  return out;
}

/**
 * Decide what the sync should do. PURE — takes and returns plain data only.
 *
 * @param {object}  args
 * @param {object}  args.src      { name: hash } of the local source
 * @param {object}  args.dest     { name: hash } of the repo mirror
 * @param {object?} args.manifest { name: hash } written by the previous sync,
 *                                or null/undefined when unknown (BOOTSTRAP).
 * @returns {{
 *   bootstrap: boolean,
 *   copyToDest: string[],      // src -> dest
 *   adoptToSrc: string[],      // dest -> src (foreign writes; the BRO-103 fix)
 *   deleteFromDest: string[],  // genuinely deleted locally
 *   conflicts: string[],       // both sides changed; src wins, dest preserved
 *   unchanged: string[],
 *   nextManifest: object       // dest state after the plan is applied
 * }}
 */
function planSync({ src, dest, manifest }) {
  const bootstrap = manifest === null || manifest === undefined;
  const base = bootstrap ? {} : manifest;

  const copyToDest = [];
  const adoptToSrc = [];
  const deleteFromDest = [];
  const conflicts = [];
  const unchanged = [];

  const names = new Set([...Object.keys(src), ...Object.keys(dest)]);
  for (const name of [...names].sort()) {
    const s = src[name];
    const d = dest[name];
    const m = Object.prototype.hasOwnProperty.call(base, name) ? base[name] : undefined;

    if (s !== undefined && d === undefined) {
      // New (or never-mirrored) local memo.
      copyToDest.push(name);
      continue;
    }

    const adopt = (n) => {
      // NEVER_ADOPT files still have their mirror version preserved — the
      // local copy just wins in the mirror rather than being overwritten.
      if (NEVER_ADOPT.has(n) && s !== undefined) {
        conflicts.push(n);
        copyToDest.push(n);
      } else {
        adoptToSrc.push(n);
      }
    };

    if (s === undefined && d !== undefined) {
      // Present in the mirror, absent locally — the case that caused the
      // 2026-05-24 data loss. Only a file we ourselves mirrored, and which
      // nobody has touched since, is safe to delete.
      if (bootstrap) {
        adoptToSrc.push(name);
      } else if (m !== undefined && m === d) {
        deleteFromDest.push(name);
      } else {
        // m === undefined: written by a cloud/parallel session, we never
        // mirrored it. m !== d: we mirrored it, then someone edited it in the
        // mirror; deleting would discard that edit. Both -> adopt, never lose.
        adoptToSrc.push(name);
      }
      continue;
    }

    if (s === d) {
      unchanged.push(name);
      continue;
    }

    // Present on both sides with different content.
    if (!bootstrap && m !== undefined && m === s) {
      // Local unchanged since the last sync, mirror changed -> a cloud-side
      // edit. Take it (unless it's a NEVER_ADOPT file — see the helper).
      adopt(name);
    } else if (!bootstrap && m !== undefined && m === d) {
      // Mirror untouched since the last sync, local changed -> normal case.
      copyToDest.push(name);
    } else {
      // Both sides changed, or no common ancestor. The local source wins in
      // the mirror (it is the side the owner and the memory tooling read),
      // but the mirror's version is preserved before being overwritten.
      conflicts.push(name);
      copyToDest.push(name);
    }
  }

  const nextManifest = {};
  for (const name of Object.keys(src)) nextManifest[name] = src[name];
  for (const name of adoptToSrc) nextManifest[name] = dest[name];
  for (const name of deleteFromDest) delete nextManifest[name];

  return {
    bootstrap,
    copyToDest: copyToDest.sort(),
    adoptToSrc: adoptToSrc.sort(),
    deleteFromDest: deleteFromDest.sort(),
    conflicts: conflicts.sort(),
    unchanged,
    nextManifest,
  };
}

/**
 * Resolve the manifest path for a checkout: <git-common-dir>/<basename>.
 * Handles a worktree's `.git` FILE (gitdir: pointer + commondir) so every
 * worktree of a repo shares the one manifest the main checkout writes.
 * Returns null when `repoRoot` has no .git at all (caller falls back to
 * bootstrap mode, i.e. no deletions).
 */
function defaultManifestPath(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  let st;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return path.join(dotGit, MANIFEST_BASENAME);

  // Worktree: `.git` is a file containing "gitdir: <abs path to .git/worktrees/x>".
  let gitDir;
  try {
    const raw = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(raw);
    if (!match) return null;
    gitDir = path.resolve(repoRoot, match[1].trim());
  } catch {
    return null;
  }
  try {
    const commondir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return path.join(path.resolve(gitDir, commondir), MANIFEST_BASENAME);
  } catch {
    return path.join(gitDir, MANIFEST_BASENAME);
  }
}

/** Read a manifest. Returns null (BOOTSTRAP) if absent, unreadable, or of an
 *  unrecognised version — an unreadable manifest must never be treated as an
 *  empty one, because empty would mean "we mirrored nothing", which makes
 *  every dest-only file look foreign rather than deletable. Null is the safe
 *  reading either way: bootstrap deletes nothing. */
function readManifest(manifestPath, expectedDest) {
  if (!manifestPath) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== MANIFEST_VERSION || typeof parsed.files !== 'object' || parsed.files === null) {
    return null;
  }
  // The manifest is bound to the mirror it describes. A worktree shares its
  // main checkout's git common dir, so without this check a sync pointed at a
  // worktree's cloud-memory/ would authorise deletions using a manifest
  // written for a DIFFERENT tree. Mismatch reads as unknown -> bootstrap ->
  // no deletions.
  if (expectedDest !== undefined && parsed.dest !== undefined && parsed.dest !== expectedDest) {
    return null;
  }
  return parsed.files;
}

function writeManifest(manifestPath, files, dest) {
  if (!manifestPath) return;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp-${process.pid}`;
  const body = { version: MANIFEST_VERSION, dest, syncedAt: new Date().toISOString(), files };
  // tmp + rename: a torn write leaves the tmp file, never a half-parsed
  // manifest. Not fsync'd, so a power loss can still yield a zero-length file
  // — which readManifest reads as null, i.e. bootstrap, i.e. no deletions.
  // Correct in the safe direction either way.
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 0)}\n`);
  fs.renameSync(tmp, manifestPath);
}

let conflictSeq = 0;

function conflictCopyName(name, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  // The sequence suffix matters: two conflicts on the same file in one run
  // share a single `now`, so a name built from the timestamp alone would have
  // the second copy silently overwrite the first.
  return `${name.replace(/\.md$/, '')}.cloud-conflict-${stamp}-${conflictSeq++}.md`;
}

/**
 * Copy atomically: write a sibling temp file, then rename over the target.
 * Two reasons, both load-bearing:
 *  - fs.copyFileSync truncates the destination before writing, so a SIGKILL
 *    mid-copy leaves a TRUNCATED memo that looks like real content to the next
 *    run. rename() is all-or-nothing.
 *  - rename() replaces the directory entry, so a symlink at the target is
 *    replaced rather than FOLLOWED. copyFileSync would write through the link,
 *    clobbering whatever it points at — possibly outside the mirror entirely.
 *    (hashDir skips symlinks, so they never even appear in a plan.)
 */
function copyAtomic(fromPath, toPath) {
  const data = fs.readFileSync(fromPath);
  const tmp = `${toPath}.tmp-${process.pid}-${conflictSeq++}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, toPath);
}

/**
 * Execute a sync. Reads both sides, plans, applies, rewrites the manifest.
 *
 * @param {object}   args
 * @param {string}   args.src           local-authoritative memory dir
 * @param {string}   args.dest          repo mirror (cloud-memory/)
 * @param {string?}  args.manifestPath  explicit manifest location
 * @param {boolean}  args.dryRun        plan only, touch nothing
 * @param {Date}     args.now           injected for deterministic tests
 * @returns the plan, plus { conflictCopies: string[], manifestPath }
 */
function applySync({ src, dest, manifestPath, dryRun = false, now = new Date(), isTracked = null }) {
  const srcHashes = hashDir(src);
  const destHashes = hashDir(dest);
  const manifest = readManifest(manifestPath, dest);
  const plan = planSync({ src: srcHashes, dest: destHashes, manifest });
  const conflictCopies = [];
  const skipped = [];

  if (dryRun) return { ...plan, conflictCopies, skipped, manifestPath, dryRun: true };

  fs.mkdirSync(dest, { recursive: true });

  // VERIFY BEFORE MUTATE. Everything below re-reads its target immediately
  // before touching it and compares against the hash the plan was built from.
  // Planning walks ~660 files, and during that window a concurrent
  // `git merge` (another session-stop's memory-sync-pull.js, or the pull that
  // cloud-memory-pull-first.sh tells sessions to do) can rewrite any file in
  // the mirror. Acting on the stale plan would delete or overwrite content
  // that arrived after we looked. A changed target is never destroyed: it is
  // preserved or skipped, and the next run re-plans against the new reality.
  const preserve = (name, fromPath) => {
    const conflictDir = path.join(src, CONFLICT_DIR);
    fs.mkdirSync(conflictDir, { recursive: true });
    const target = path.join(conflictDir, conflictCopyName(name, now));
    copyAtomic(fromPath, target);
    conflictCopies.push(target);
    return target;
  };

  for (const name of plan.adoptToSrc) {
    const from = path.join(dest, name);
    const to = path.join(src, name);
    if (hashFile(to) !== srcHashes[name]) {
      // The local memo changed under us — never clobber it; keep the mirror's
      // version where a human can find it and let the next run re-plan.
      preserve(name, from);
      skipped.push({ name, action: 'adopt', reason: 'local copy changed since planning' });
      continue;
    }
    copyAtomic(from, to);
  }

  for (const name of plan.copyToDest) {
    const target = path.join(dest, name);
    const current = hashFile(target);
    // Preserve when the plan already called this a conflict, and ALSO when the
    // mirror changed after planning (a conflict the plan could not have seen).
    if (current !== undefined && (plan.conflicts.includes(name) || current !== destHashes[name])) {
      preserve(name, target);
    }
    copyAtomic(path.join(src, name), target);
  }

  for (const name of plan.deleteFromDest) {
    const target = path.join(dest, name);
    if (hashFile(target) !== destHashes[name]) {
      skipped.push({ name, action: 'delete', reason: 'mirror copy changed since planning' });
      continue;
    }
    // A file git has never committed exists ONLY here — deleting it is
    // unrecoverable, and adoption records a file in the manifest before
    // anything guarantees it was committed (the --commit branch declines in
    // four different ways). Skip once: the same run's commit stages it, and
    // the next run deletes it with the content safe in git history.
    if (isTracked && !isTracked(name)) {
      skipped.push({ name, action: 'delete', reason: 'not committed to git yet — deferred to the next run' });
      continue;
    }
    fs.rmSync(target, { force: true });
  }

  // Recompute rather than trusting the plan's projection: the manifest must
  // describe what is actually on disk now, or the next run's deletion
  // decisions are made against a fiction. Skipped when it would rewrite the
  // identical map — the common case is a session-stop that changed nothing,
  // and rewriting keeps touching .git for no reason.
  const finalHashes = hashDir(dest);
  if (manifest === null || !sameHashes(manifest, finalHashes)) {
    writeManifest(manifestPath, finalHashes, dest);
  }

  return { ...plan, conflictCopies, skipped, manifestPath, dryRun: false };
}

/**
 * Build the `isTracked` guard for a real checkout: one `git ls-files` call,
 * not one per file. Returns null when the mirror is not in a git repo at all
 * (nothing to be recoverable from, so the manifest logic governs alone).
 */
function gitTrackedGuard(repoRoot, destDir) {
  const rel = path.relative(repoRoot, destDir);
  let out;
  try {
    out = require('child_process').execFileSync('git', ['-C', repoRoot, 'ls-files', '--', rel], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const tracked = new Set(
    out.split('\n').filter(Boolean).map((line) => path.basename(line)),
  );
  return (name) => tracked.has(name);
}

module.exports = {
  MANIFEST_VERSION,
  MANIFEST_BASENAME,
  CONFLICT_DIR,
  sha256,
  sameHashes,
  hashDir,
  hashFile,
  copyAtomic,
  gitTrackedGuard,
  NEVER_ADOPT,
  planSync,
  applySync,
  defaultManifestPath,
  readManifest,
  writeManifest,
  conflictCopyName,
};

// CLI: node scripts/lib/cloud-memory-merge.js <src> <dest> [--repo=PATH]
//      [--manifest=PATH] [--dry-run] [--verbose]
// Called by scripts/sync-memory-to-repo.sh in place of `rsync --delete`.
if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const getOpt = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const [srcDir, destDir] = positional;
  if (!srcDir || !destDir) {
    console.error('usage: cloud-memory-merge.js <src-dir> <dest-dir> [--repo=PATH] [--manifest=PATH] [--dry-run] [--verbose]');
    process.exit(2);
  }
  const repo = getOpt('repo') || path.dirname(path.resolve(destDir));
  const manifestPath = getOpt('manifest') || defaultManifestPath(repo);
  const verbose = flags.has('--verbose');
  const resolvedSrc = path.resolve(srcDir);
  const resolvedDest = path.resolve(destDir);
  const result = applySync({
    src: resolvedSrc,
    dest: resolvedDest,
    manifestPath,
    dryRun: flags.has('--dry-run'),
    isTracked: gitTrackedGuard(repo, resolvedDest),
  });

  const say = (msg) => console.error(`cloud-memory-merge: ${msg}`);
  if (result.bootstrap) say('no usable manifest — bootstrap run, no deletions will be made');
  if (result.adoptToSrc.length) {
    say(`adopted ${result.adoptToSrc.length} mirror-side file(s) into the local memory dir (written by cloud/parallel sessions)`);
    for (const n of result.adoptToSrc) say(`  adopt  ${n}`);
  }
  if (result.deleteFromDest.length) {
    say(`deleted ${result.deleteFromDest.length} file(s) from the mirror (deleted locally, unmodified in the mirror)`);
    for (const n of result.deleteFromDest) say(`  delete ${n}`);
  }
  for (const s of result.skipped) {
    say(`SKIPPED ${s.action} ${s.name} — ${s.reason}`);
  }
  if (result.conflicts.length) {
    say(`${result.conflicts.length} file(s) changed on BOTH sides — local version kept, mirror version preserved:`);
    for (const p of result.conflictCopies) say(`  preserved ${p}`);
  }
  if (verbose) {
    for (const n of result.copyToDest) say(`  copy   ${n}`);
    say(`${result.unchanged.length} file(s) already in sync`);
  }
}
