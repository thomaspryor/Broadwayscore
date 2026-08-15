#!/usr/bin/env node
/**
 * validate-added-review-ownership.js — post-rebase cross-show ownership gate
 * for the push-review-texts action (Notion 39b637c5-416f-8134).
 *
 * Closes the stale-checkout race that Guard I (review-file-writer.js) and the
 * gather-reviews cross-production check cannot see: a CI writer checks out
 * review-texts BEFORE a manual cross-show move lands, its in-process guards
 * validate against that stale snapshot, and it re-creates a URL that the
 * post-move corpus assigns to a sibling show. Observed 2026-07-10 13:36 UTC —
 * the opening-night poller re-created tender-off-west-end-2026/
 * thestage--dave-fargnoli.json 6 minutes after the tender disambiguation push
 * (creation commit 65159277b5b in broadway-review-texts).
 *
 * PLACEMENT (load-bearing): runs inside the push action's retry loop, AFTER a
 * successful `git pull --rebase origin main` and BEFORE `git push` — the only
 * point where the tree reflects current remote ownership. The action's
 * initial pre-stage pull is `|| true` and silently no-ops whenever tracked
 * files are dirty (the common case), so a gate there would validate a stale
 * tree. The rebase conflict resolver is a second re-creation path this
 * placement covers: on a delete/modify conflict (remote moved the file away,
 * our run wrote to it) it keeps "ours" whenever our fullText is longer than
 * the deleted side's 0 — resurrecting the moved file.
 *
 * Mode --base=<ref>: files ADDED between <ref> and HEAD (git diff
 * --diff-filter=A) are checked against the working-tree ownership index; each
 * violator is `git rm`'d and the drops are committed. Modified-in-place files
 * are the URL-change invariant's territory, not creation ownership.
 *
 * Without --base: validates UNTRACKED/staged-new files and deletes violators
 * from the working tree (pre-commit usage, e.g. local runs).
 *
 * Fail-open by design: a validator crash must never block a data push (the
 * action invokes it with a non-blocking `|| echo ::warning::`). Per-file
 * parse errors skip the file.
 *
 * Residual window: a cross-show move landing between this check and the
 * `git push` (seconds) can still race; guards + wrongShow tombstones make
 * that damage self-healing, and the next push's gate removes re-creations.
 *
 * Usage (cwd = review-texts repo):
 *   node ../../scripts/validate-added-review-ownership.js --base=origin/main [--dry-run]
 *   node ../../scripts/validate-added-review-ownership.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `validate-added-review-ownership.js — post-rebase cross-show ownership gate.

Usage:
  node scripts/validate-added-review-ownership.js [options]
  node scripts/validate-added-review-ownership.js --help, -h    print this usage and exit
`;
const {
  findCrossShowOwners,
  shouldBlockCrossShowCreate,
  _resetUrlOwnershipIndex,
} = require('./lib/url-ownership');

function isReviewFilePath(rel) {
  if (!rel || !rel.endsWith('.json') || rel.endsWith('failed-fetches.json')) return false;
  const parts = rel.split('/');
  if (parts.length !== 2) return false; // review files are exactly <show>/<file>.json
  if (parts[0].startsWith('_') || parts[0].startsWith('.')) return false;
  return true;
}

/**
 * Files ADDED between base and HEAD (committed — the retry-loop mode).
 * --no-renames is load-bearing: with rename detection (default-on), a commit
 * that deletes any structurally similar JSON (dedup cleanup, byline-rename
 * source) alongside the violator gets the pair reported as R, not A — the
 * gate would never see the violator in exactly the incident class it exists
 * for. A same-show rename destination surfacing as A is harmless (same-show
 * owners are excluded from cross-show lookup). maxBuffer raised: bulk imports
 * add thousands of files and the 1MB default would throw → fail-open → the
 * largest pushes get the least protection.
 */
function listAddedReviewFiles(cwd, base) {
  const out = execSync(`git diff --no-renames --diff-filter=A --name-only ${base} HEAD`, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((l) => l.trim()).filter(isReviewFilePath);
}

/**
 * NEW review files (untracked or staged-added) relative to HEAD — pre-commit
 * mode. `-uall` is required: a brand-new show directory otherwise reports as
 * one `?? show-dir/` entry and every file inside it would be missed.
 */
function listNewReviewFiles(cwd) {
  const out = execSync('git status --porcelain -uall', {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const status = line.slice(0, 2);
    if (status !== '??' && status[0] !== 'A') continue;
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    if (isReviewFilePath(rel)) files.push(rel);
  }
  return files;
}

/**
 * Pure decision: which of the given new files violate cross-show URL
 * ownership and must be dropped. Mirrors Guard I:
 *   - drop when another show holds the URL live (unflagged, non-roundup)
 *   - keep when every cross-show copy is flagged (legitimate re-home)
 *   - keep on the file's own allowCrossShowUrl:true escape hatch
 *   - never drop human-vouched work (humanReviewScore / _locked)
 *
 * @param {string[]} newFiles  repo-relative paths like 'show-id/outlet--critic.json'
 * @param {string} reviewTextsDir  absolute path to the review-texts checkout
 * @returns {Array<{file:string, showId:string, url:string, owner:{showId:string,file:string}}>}
 */
function decideOwnershipDrops(newFiles, reviewTextsDir) {
  const drops = [];
  for (const rel of newFiles) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, rel), 'utf8'));
    } catch {
      continue; // deleted or unparseable — not this gate's problem
    }
    if (!data || typeof data !== 'object') continue;
    if (data.allowCrossShowUrl === true) continue;
    if (data.humanReviewScore != null || data._locked === true) continue;
    const showId = rel.split('/')[0];
    const owners = findCrossShowOwners(data.url, showId, reviewTextsDir);
    const verdict = shouldBlockCrossShowCreate(owners);
    if (verdict.block) {
      drops.push({ file: rel, showId, url: data.url, owner: verdict.owner });
    }
  }
  return drops;
}

// Mirrors scripts/lib/detect-stale-merge-head.sh's STALE_MERGE_HEAD_WARN_SEC
// default (BRO-142). Not sourced from there — this is JS, that's bash — but
// the intent must stay in sync: past this age, a MERGE_HEAD is no longer
// "a normal in-progress op", it's the #916/#1279/#1445 leftover-marker class.
const STALE_MERGE_HEAD_WARN_SEC = 1800;

/**
 * True when a rebase/merge/cherry-pick is in progress. The action's
 * post-conflict call site can reach the gate after `git rebase --continue ||
 * true` left the rebase UNFINISHED (second conflict); committing drops onto
 * that detached HEAD is pointless (the loop aborts the rebase on push
 * failure) and mid-rebase diffs are unreliable — skip and let the next
 * attempt's fully-rebased tree re-run the gate.
 *
 * Also flags whether the marker found is a STALE MERGE_HEAD (BRO-142): before
 * this, a leftover MERGE_HEAD from a dead session made this gate skip and
 * exit 0 forever, identically to a genuine few-seconds-old in-progress merge
 * — CI stayed green while ownership validation silently never ran, with no
 * signal distinguishing "normal, retry next attempt" from "stuck for days".
 * Still never fails the build or touches git state — detection only, same as
 * every other BRO-142 call site.
 */
function gitOpInProgress(cwd) {
  for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    try {
      const p = execSync(`git rev-parse --git-path ${marker}`, { cwd, encoding: 'utf8' }).trim();
      const resolved = path.resolve(cwd, p);
      if (!fs.existsSync(resolved)) continue;
      let stale = false;
      if (marker === 'MERGE_HEAD') {
        try {
          const ageSec = (Date.now() - fs.statSync(resolved).mtimeMs) / 1000;
          stale = ageSec >= STALE_MERGE_HEAD_WARN_SEC;
        } catch { /* stat failure → treat as not stale, still in-progress */ }
      }
      return { inProgress: true, marker, stale };
    } catch { /* rev-parse failure → treat as not in progress */ }
  }
  return { inProgress: false, marker: null, stale: false };
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const dryRun = process.argv.includes('--dry-run');
  const baseArg = process.argv.find((a) => a.startsWith('--base='));
  const base = baseArg ? baseArg.split('=')[1] : null;
  const cwd = process.cwd();

  const gitOp = base ? gitOpInProgress(cwd) : { inProgress: false };
  if (gitOp.inProgress) {
    if (gitOp.stale) {
      console.log(`::warning::[ownership-gate] STALE ${gitOp.marker} (>=${STALE_MERGE_HEAD_WARN_SEC}s old, BRO-142 class) — skipping, but this looks like a leftover from a dead session, not a normal in-progress merge. Ownership validation will not run until it's resolved: git -C ${cwd} status`);
    } else {
      console.log(`::warning::[ownership-gate] ${gitOp.marker} in progress — skipping (next attempt re-runs the gate on the completed tree)`);
    }
    return;
  }

  const candidates = base ? listAddedReviewFiles(cwd, base) : listNewReviewFiles(cwd);
  if (candidates.length === 0) {
    console.log('[ownership-gate] no new review files — nothing to validate');
    return;
  }
  // Force a fresh index: the whole point is validating against the
  // just-rebased tree, never a cached snapshot.
  _resetUrlOwnershipIndex();
  const drops = decideOwnershipDrops(candidates, cwd);
  if (drops.length === 0) {
    console.log(`[ownership-gate] ${candidates.length} new file(s) — all pass cross-show ownership`);
    return;
  }
  for (const d of drops) {
    console.log(`::warning::[ownership-gate] dropping ${d.file} — URL is live at ${d.owner.showId}/${d.owner.file} (stale-checkout race): ${d.url}`);
    if (dryRun) continue;
    if (base) {
      execSync(`git rm -f -q -- "${d.file}"`, { cwd });
    } else {
      try { fs.unlinkSync(path.join(cwd, d.file)); } catch (e) {
        console.log(`::warning::[ownership-gate] could not delete ${d.file}: ${e.message}`);
      }
    }
  }
  if (base && !dryRun) {
    execSync(`git commit -q -m "ownership-gate: drop ${drops.length} cross-show re-creation(s) (stale-checkout race)"`, { cwd });
  }
  console.log(`[ownership-gate] dropped ${drops.length}/${candidates.length} new file(s)${dryRun ? ' (dry-run — not deleted)' : ''}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // Fail open: log loudly, exit 0 — a validator bug must not block data pushes.
    console.log(`::warning::[ownership-gate] validator error (non-blocking): ${e.message}`);
  }
}

module.exports = { decideOwnershipDrops, listNewReviewFiles, listAddedReviewFiles };
