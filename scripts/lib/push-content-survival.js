#!/usr/bin/env node
'use strict';
// Post-push CONTENT-survival check (task #619 P0).
//
// The bug: push-with-retry.sh can print "Push succeeded" with a genuine
// ref-update ("old..new main -> main") while the run's own commit's actual
// file content is NOT what's on origin/$PULL_BRANCH afterward — reproduced
// live twice in one session on the same one-line CLAUDE.md edit. Independent
// diagnosis both times: `git show origin/main:CLAUDE.md | wc -c` matched the
// PRE-EDIT byte count, i.e. the file was silently reverted to its OLD content
// somewhere inside this run's fetch->rebase/merge->push cycle.
//
// Neither existing guard catches this:
//   - check-post-rebase-survival.js only tracks ADDED files (--diff-filter=A)
//     and explicitly no-ops when the run's commit only MODIFIES existing
//     files (exactly the CLAUDE.md case — a byte-cap trim is a pure
//     modification, nothing added).
//   - push-rebase-progress.js's no-op-rebase guard only proves the FETCHED
//     remote tip became an ancestor of HEAD — a completely different (and
//     insufficient) direction. It says nothing about whether a MODIFIED
//     file's content is what our commit intended, since a rebase/merge/
//     cherry-pick can auto-resolve a conflict by discarding our side of a
//     single file while still correctly integrating everything else.
//   - A naive "is our original commit SHA an ancestor of origin" check (the
//     card's own manual diagnostic) is unusable as an automated guard: any
//     successful rebase replays commits into BRAND NEW objects with
//     different SHAs, so that check would false-positive on every clean
//     rebase, not just a lossy one.
//
// This guard instead compares file CONTENT (blob hashes) at three points for
// every file the run's commit(s) actually MODIFIED (added files are already
// covered by check-post-rebase-survival.js):
//   base  = the file's content just before the run's own commit(s)
//   local = the file's content IN the run's own commit (what we intended)
//   final = the file's content at the ref we just believe we pushed
//
// - final === local            -> survived: exactly what we intended.
// - final === base (!== local) -> REVERTED: our edit is provably gone — this
//   is the exact signature from the incident's own manual diagnosis.
// - local === base              -> unchanged: our commit didn't actually
//   change this file's content (e.g. a mode-only change); nothing at risk.
// - anything else                -> ambiguous: content diverged from both —
//   most likely a legitimate 3-way merge that combined our edit with an
//   unrelated concurrent change to the same file. NOT flagged as a failure
//   (this file class is common on a busy shared main and flagging it would
//   make the guard unusable), but callers should still surface it for
//   visibility.

/**
 * @param {{baseBlob: string|null, localBlob: string|null, finalBlob: string|null}} blobs
 * @returns {'survived'|'unchanged'|'reverted'|'ambiguous'}
 */
function classifyFileSurvival({ baseBlob, localBlob, finalBlob }) {
  if (localBlob === baseBlob) return 'unchanged';
  if (finalBlob === localBlob) return 'survived';
  if (finalBlob === baseBlob) return 'reverted';
  return 'ambiguous';
}

/**
 * @param {Array<{file: string, baseBlob: string|null, localBlob: string|null, finalBlob: string|null}>} entries
 * @returns {Array<{file: string, status: string}>}
 */
function classifyAll(entries) {
  return entries.map((e) => ({ file: e.file, status: classifyFileSurvival(e) }));
}

function anyReverted(classified) {
  return classified.some((c) => c.status === 'reverted');
}

module.exports = { classifyFileSurvival, classifyAll, anyReverted };

// ── CLI ───────────────────────────────────────────────────────────────────
// Usage: node push-content-survival.js --before-sha=<sha> --base-sha=<sha>
//          --check-ref=<ref> [--path-prefix=<prefix>]
//
// Exit codes: 0 = OK (nothing reverted), 1 = at least one file REVERTED,
// 2 = invalid args / git failure (fail-open — caller should treat as "skip",
// same convention as check-post-rebase-survival.js).
if (require.main === module) {
  const { execFileSync } = require('child_process');

  const arg = (name) => {
    const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : null;
  };
  const gitTry = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', timeout: 30_000 }).trim();
    } catch {
      return null;
    }
  };

  const beforeSha = arg('before-sha');
  const baseSha = arg('base-sha');
  const checkRef = arg('check-ref');
  const pathPrefix = arg('path-prefix') || '';

  if (!beforeSha || !baseSha || !checkRef) {
    console.log('SKIP (missing --before-sha/--base-sha/--check-ref)');
    process.exit(0);
  }

  let modifiedFiles;
  try {
    const diffArgs = ['diff', '--name-only', '--diff-filter=M', `${baseSha}..${beforeSha}`];
    if (pathPrefix) diffArgs.push('--', pathPrefix);
    modifiedFiles = execFileSync('git', diffArgs, { encoding: 'utf8', timeout: 30_000 })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    console.log(`SKIP (git diff failed: ${e.message})`);
    process.exit(0);
  }

  if (modifiedFiles.length === 0) {
    console.log('OK — no modified files to check');
    process.exit(0);
  }

  const entries = modifiedFiles.map((file) => ({
    file,
    baseBlob: gitTry(['rev-parse', `${baseSha}:${file}`]),
    localBlob: gitTry(['rev-parse', `${beforeSha}:${file}`]),
    finalBlob: gitTry(['rev-parse', `${checkRef}:${file}`]),
  }));

  const classified = classifyAll(entries);
  const reverted = classified.filter((c) => c.status === 'reverted');
  const ambiguous = classified.filter((c) => c.status === 'ambiguous');

  for (const c of ambiguous) {
    console.log(`[content-survival] AMBIGUOUS (likely legitimate concurrent merge): ${c.file}`);
  }

  if (reverted.length > 0) {
    console.error(`[content-survival] FAILED — ${reverted.length} file(s) silently REVERTED to pre-edit content on ${checkRef}:`);
    for (const c of reverted) console.error(`  - ${c.file}`);
    console.error('  This is the task #619 signature: a push reported success, but the run\'s own');
    console.error('  content change is not on the ref we just pushed. Some conflict-resolution step');
    console.error('  in this run discarded it in favour of the pre-existing/remote version.');
    process.exit(1);
  }

  console.log(`OK — ${classified.length - ambiguous.length}/${classified.length} modified file(s) confirmed surviving on ${checkRef}`);
  process.exit(0);
}
