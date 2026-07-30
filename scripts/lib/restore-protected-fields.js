#!/usr/bin/env node
/**
 * Restore manually-set protected fields after a git rebase/merge.
 *
 * When push-with-retry.sh rebases with -X theirs, conflicts are resolved
 * by keeping the CI's version. This silently drops manual corrections
 * (humanReviewScore, manualContentTier, etc.) that were pushed to origin.
 *
 * This script compares each JSON file between the remote ref and HEAD.
 * If the remote version had manual correction fields that are now missing,
 * it restores them into the local file.
 *
 * Usage: node scripts/lib/restore-protected-fields.js <remote-ref>
 *
 * Exit codes:
 *   0 = no changes needed (or changes applied successfully)
 *   Prints count of restored files to stdout (for caller to check).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// Generalized intentional-clear breadcrumbs — single source of truth. When the
// LOCAL record deliberately cleared a field (durable breadcrumb present), we
// must NOT restore the remote value, or a CI rebase silently re-flags a
// human-verified review. See review-write-guard.js. (2026-06-05)
const { isIntentionalClear } = require(path.join(__dirname, 'review-write-guard.js'));

// Fields that must be preserved across rebases. Two categories:
//   (a) MANUAL human corrections CI should never touch — see DoaS Apr 9-10
//       postmortem (humanReviewedWrongProduction: false was dropped and
//       CV-promotion re-flagged human-verified files as wrongProduction).
//   (b) DURABLE CI state that must survive rebase even when the content-aware
//       merge in push-review-texts/action.yml picks "theirs" on the file. The
//       SERP retry tracking fields are in this category — the backfill marked
//       ~10,466 wrong_content files as abandoned, and dropping those flags via
//       rebase resurrects them into the retry pool and burns BD credits we
//       just committed to not spending. See sprint-plan-serp-cost-reduction.md.
// If the remote has these and local doesn't, always restore from remote.
const MANUAL_FIELDS = [
  // (a) Human-only corrections
  // Identity fields — added to protect opera outlet review files (bachtrack,
  // parterre-box, operawire, new-york-classical-review, classical-voice-america)
  // from having their outletId/outlet silently cleared on rebase. Without this,
  // a CI rebase that wins on an opera review file could wipe outlet attribution,
  // causing the rebuild to lose the review's outlet association.
  'outletId',
  'outlet',
  'humanReviewScore',
  'humanReviewNote',
  'manualContentTier',
  'wrongProductionManualClear',
  'wrongArticleManualClear',
  'wrongShowManualClear',
  'wrongProductionOverride',
  'wrongProductionOverrideReason',
  'wrongProductionOverrideSetAt',
  'wrongProductionOverrideSetBy',
  'wrongShowOverride',
  'wrongShowOverrideReason',
  'wrongShowOverrideAt',
  'humanReviewedWrongProduction',
  'humanReviewedWrongArticle',
  // The wrongProduction / wrongShow flags themselves. Added 2026-05-17 alongside
  // the review-file-writer.js human-override guard. A human's manual
  // `wrongProduction: false` (i.e. "this IS the right production, don't exclude")
  // must survive rebase — otherwise CI's `true` from a remote classifier run
  // silently re-excludes the review. The ORIG_HEAD recovery below handles the
  // -X theirs case (post-rebase local matches remote); the MANUAL_FIELDS
  // restoration only handles the simpler local-lost-field case.
  'wrongProduction',
  'wrongShow',
  // Opening-night manual-ingest overrides (Beaches 2026-04-22 postmortem #6)
  'allowEarlyDate',
  'allowLateDate',
  'allowCrossMarket',
  'allowTourSignal',
  'allowTourSignalReason',
  'allowFilmSignal',
  'routedFromShowId',
  // Added in Rocky Horror 2026-04-23 postmortem (Session 2 #7)
  'humanReviewedTour',
  'humanReviewScoreProvisional',
  'humanReviewScoreClearedForLlm',
  'isTourReview',
  'isLikelyTourReview',
  // Aggregator thumb signals used by thumb-validated-LLM scoring path
  'dtliThumb',
  'bwwThumb',
  // Per-file protection array lock
  'protectedFields',
  // (b) Durable url-change-invariant breadcrumb (Notion 399637c5) — records
  // fields deliberately cleared when a file's url moved to a different
  // canonical article. isIntentionalClear() keys on it; losing it on rebase
  // would let this very script resurrect the cleared old-URL flags/scores.
  '_urlChangedClear',
  // (b) Durable SERP retry state — must survive rebase
  'serpDiscoveryAbandoned',
  'serpAbandonmentReason',
  'serpAbandonmentDate',
  'serpRetryCount',
  'serpRetryAfter',
  'wrongShowRetryAt',
];

// Nested fields under contentVerification that are manually set, mapped to the
// TOP-LEVEL field whose intentional-clear breadcrumb governs them. The rebuild
// pre-pass promotes contentVerification flags to top-level every run
// (scripts/rebuild-all-reviews.js ~1320), so resurrecting a stale CV flag here
// silently re-excludes a review whose top-level flag was deliberately cleared
// (e.g. a human wrongProductionManualClear, or a URL-replace reset in
// review-normalization.js that deletes contentVerification). Honor the clear.
const MANUAL_CV_FIELDS = [
  'wrongProduction',
  'wrongArticle',
  'isFilmTv',
];
// CV flags are promoted to a top-level flag by the rebuild pre-pass; the mapping
// is to whatever flag that promotion SETS, because that is the flag a human clear
// would target. cv.wrongProduction → wrongProduction; cv.wrongArticle → wrongShow
// (rebuild-all-reviews.js ~1393 sets d.wrongShow = true on cv.wrongArticle, NOT
// wrongFullText); cv.isFilmTv → wrongShow (rebuild-all-reviews.js ~1407). Mapping
// to the wrong top-level field would make the skip a no-op.
// NOTE: this nested per-subfield restore is the -X theirs path only. The action.yml
// push restore protects the WHOLE contentVerification object (it is in
// PROTECTED_FIELDS) and has no CV-clear breadcrumb, so a breadcrumb-less reset that
// deletes the whole object (review-normalization URL-replace ~line 619) can still
// rehydrate it wholesale — tracked as a separate card (breadcrumb-less reset class).
const CV_FIELD_TO_TOPLEVEL = {
  wrongProduction: 'wrongProduction',
  wrongArticle: 'wrongShow',
  isFilmTv: 'wrongShow',
};

// Content fields that travel WITH fullText — when a richer body is restored
// from another version, these describe that body and must move together or
// the file ends up franken-stated (new text, old tier/verification).
const CONTENT_FIELDS = [
  'fullText',
  'isFullReview',
  'textWordCount',
  'textStatus',
  'textQuality',
  'truncationSignals',
  'textFetchedAt',
  'archivePath',
  'sourceMethod',
  'fetchMethod',
  'fetchTier',
  'contentTier',
  'tierReason',
  'contentTierReason',
];

// Scoring fields that describe a specific fullText. Only restored when the
// local body is (or becomes) the same body those scores were computed on.
// contentVerification / flaggedForReview / flagReason are deliberately NOT
// here: restoring the whole CV object wholesale would bypass the
// intentional-clear guard in the nested CV block below — a remote
// cv.wrongProduction:true copied onto a human-cleared local gets re-promoted
// to top-level by the rebuild pre-pass and silently re-excludes the review
// (ship-check 2026-07-23, Claude reviewer). The nested block restores CV
// per-key with the proper isIntentionalClear check.
const SCORE_FIELDS = [
  'llmScore',
  'llmMetadata',
  'ensembleData',
  'assignedScore',
  'scoreSource',
  'originalScore',
  'originalScoreNormalized',
  'originalScoreSource',
  'originalScoreType',
];

/**
 * Pure reconciliation for one review file after a `-X theirs` rebase.
 * Mutates and returns `local`.
 *
 * @param {object} local  post-rebase working-tree version (mutated in place)
 * @param {object} remote the remote ref's version (what origin had)
 * @param {object|null} ours pre-rebase HEAD version (ORIG_HEAD), if available
 * @param {object} [opts]
 * @param {boolean} [opts.staleCheckoutGuard=false] enable the remote-richer
 *   content/score restore. Only valid when `remote` is a genuine REMOTE ref
 *   (origin/*) — a caller passing a local ref (batch-correct-reviews.js passes
 *   ORIG_HEAD) would make "remote" the pre-correction state and this guard
 *   would resurrect exactly what the correction removed (ship-check 2026-07-23,
 *   Codex finding). The CLI sets this automatically from the ref name.
 * @returns {{ modified: boolean, notes: string[] }}
 */
function reconcileProtectedFields(local, remote, ours, opts = {}) {
  const staleCheckoutGuard = opts.staleCheckoutGuard === true;
  let modified = false;
  const notes = [];

  // Restore top-level manual fields
  for (const field of MANUAL_FIELDS) {
    if (
      remote[field] !== undefined &&
      remote[field] !== null &&
      (local[field] === undefined || local[field] === null)
    ) {
      // Intentional-clear exception: if the LOCAL record deliberately
      // cleared this field and carries the canonical breadcrumb (e.g. a
      // human wrongProductionManualClear / humanReviewedWrongProduction:false,
      // wrongShowCleared signals, originalScoreCleared, or duplicateClearReason),
      // the empty value is not data-loss — honor it instead of resurrecting
      // the remote flag. Without this guard the remote's stale `true` comes
      // right back on every rebase. Mirrors the action.yml restore skip and
      // review-guards.js is-cleared semantics. (2026-06-05)
      if (isIntentionalClear(field, local, remote)) continue;
      local[field] = remote[field];
      modified = true;
      notes.push(`Restored ${field}`);
    }
  }

  // Restore richer content from OURS (pre-rebase HEAD). Titanique postmortem:
  // a push rebase re-applied old empty fullText over newly collected 5000+ char
  // text. After `-X theirs` the working tree matches the replayed local commit,
  // so freshly-collected text lives only in ORIG_HEAD.
  if (ours) {
    const oursText = ours.fullText || '';
    // isIntentionalClear: an empty local fullText behind a _urlChangedClear
    // breadcrumb is a deliberate clear (the text belongs to the file's OLD
    // url) — restoring it would re-contaminate the new URL era.
    if (oursText.length > 100 && oursText.length > (local.fullText || '').length
        && !isIntentionalClear('fullText', local, ours)) {
      local.fullText = oursText;
      modified = true;
      notes.push(`Restored fullText (${oursText.length} chars) from pre-rebase HEAD`);
    }
    // Restore manual `wrongProduction: false` / `wrongShow: false` from
    // pre-rebase HEAD. After `-X theirs`, local matches remote so the
    // simple MANUAL_FIELDS restoration (which only fills missing locals)
    // doesn't help. If OURS explicitly had `false` (the human-cleared
    // sentinel) and remote has `true`, prefer OURS — otherwise CI's
    // classifier output silently re-excludes a human-verified review.
    for (const flagField of ['wrongProduction', 'wrongShow']) {
      if (ours[flagField] === false && local[flagField] === true) {
        local[flagField] = false;
        modified = true;
        notes.push(`Restored ${flagField}=false from pre-rebase HEAD`);
      }
    }
  }

  // Stale-checkout guard — the REMOTE-richer direction (Trainspotting The Stage,
  // 2026-07-23, review-texts commit 7f3cac6c75b): a checkpoint job running on a
  // pre-collection checkout rebased with `-X theirs` and its stale stub beat
  // origin's fully-collected, LLM-scored file (751-word review + score 38 wiped
  // 14 minutes after they landed). The ORIG_HEAD restore above cannot help —
  // the stale version IS ours. When origin's version is strictly richer, pull
  // its content back, unless the local emptiness is an intentional clear.
  let contentRestoredFromRemote = false;
  if (staleCheckoutGuard) {
    const remoteText = remote.fullText || '';
    const localTextNow = local.fullText || '';
    if (remoteText.length > 100 && remoteText.length > localTextNow.length
        && !isIntentionalClear('fullText', local, remote)) {
      for (const field of CONTENT_FIELDS) {
        if (remote[field] !== undefined) local[field] = remote[field];
      }
      contentRestoredFromRemote = true;
      modified = true;
      notes.push(`Restored fullText (${remoteText.length} chars) + content fields from remote (stale-checkout guard)`);
    }
  }

  // Scores travel with the body they were computed on. Restore remote scoring
  // only when the local body IS the remote body (either because we just
  // restored it, or the texts already match) and the local has no score of its
  // own. A local humanReviewScore always wins (it is in MANUAL_FIELDS and never
  // removed here).
  if (staleCheckoutGuard) {
    const bodiesMatch = contentRestoredFromRemote
      || (local.fullText || '') === (remote.fullText || '');
    const localHasScore = local.assignedScore != null || local.llmScore != null;
    const remoteHasScore = remote.assignedScore != null || remote.llmScore != null;
    if (bodiesMatch && !localHasScore && remoteHasScore
        && !isIntentionalClear('assignedScore', local, remote)
        && !isIntentionalClear('originalScore', local, remote)) {
      for (const field of SCORE_FIELDS) {
        if (remote[field] !== undefined && (local[field] === undefined || local[field] === null)) {
          local[field] = remote[field];
        }
      }
      modified = true;
      notes.push('Restored scoring fields from remote (stale-checkout guard)');
    }
  }

  // Restore nested contentVerification manual fields
  if (remote.contentVerification) {
    for (const key of MANUAL_CV_FIELDS) {
      const remoteVal = remote.contentVerification[key];
      if (remoteVal === undefined || remoteVal === null) continue;

      // Intentional-clear exception (mirrors the top-level loop): if the
      // governing top-level field was deliberately cleared, do NOT resurrect
      // the nested CV flag — the rebuild pre-pass would re-promote it and
      // silently re-exclude the review.
      if (isIntentionalClear(CV_FIELD_TO_TOPLEVEL[key], local, remote)) continue;

      if (!local.contentVerification) local.contentVerification = {};
      const localVal = local.contentVerification[key];

      if (localVal === undefined || localVal === null) {
        local.contentVerification[key] = remoteVal;
        modified = true;
        notes.push(`Restored contentVerification.${key}`);
      }
    }
  }

  return { modified, notes };
}

module.exports = { reconcileProtectedFields, MANUAL_FIELDS, CONTENT_FIELDS, SCORE_FIELDS };

if (require.main === module) {
  const remoteRef = process.argv[2];
  if (!remoteRef) {
    console.log('0');
    process.exit(0);
  }

  try {
    // Get JSON files that differ between remote and HEAD
    const diffOutput = execSync(
      `git diff --name-only ${remoteRef}..HEAD -- '*.json'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!diffOutput) {
      console.log('0');
      process.exit(0);
    }

    const files = diffOutput.split('\n').filter(f =>
      f.endsWith('.json') &&
      !f.includes('package') &&
      !f.includes('tsconfig') &&
      !f.includes('node_modules') &&
      !f.includes('failed-fetches')
    );

    let restoredCount = 0;

    for (const f of files) {
      try {
        // Read local version
        if (!fs.existsSync(f)) continue;
        const local = JSON.parse(fs.readFileSync(f, 'utf8'));

        // Read remote version
        let remoteContent;
        try {
          remoteContent = execSync(`git show ${remoteRef}:${f}`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          continue; // File doesn't exist in remote — new file, skip
        }
        const remote = JSON.parse(remoteContent);

        // Pre-rebase HEAD version, when available
        let ours = null;
        try {
          ours = JSON.parse(execSync(`git show ORIG_HEAD:${f}`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }));
        } catch {
          // ORIG_HEAD not available or file didn't exist — skip
        }

        // The remote-richer (stale-checkout) direction is only meaningful when
        // the diff ref is a genuine remote-tracking ref. batch-correct-reviews.js
        // passes ORIG_HEAD — there "remote" is the pre-correction local state
        // and the guard would resurrect what the correction removed.
        const staleCheckoutGuard = /^(origin|refs\/remotes)\//.test(remoteRef);
        const { modified, notes } = reconcileProtectedFields(local, remote, ours, { staleCheckoutGuard });
        for (const n of notes) process.stderr.write(`  ${n} in ${f}\n`);

        if (modified) {
          fs.writeFileSync(f, JSON.stringify(local, null, 2) + '\n');
          restoredCount++;
        }
      } catch {
        // Parse error or other issue — skip this file
      }
    }

    console.log(String(restoredCount));
  } catch (e) {
    // If git diff fails (e.g., remote ref doesn't exist), just exit cleanly
    console.log('0');
  }
}
