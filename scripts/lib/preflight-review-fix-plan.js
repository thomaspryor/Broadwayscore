#!/usr/bin/env node
'use strict';
/**
 * preflight-review-fix-plan.js (BRO-4849): replay a data/pending-fixes plan's review-field-edit actions, in order, on a
 * throwaway copy of each touched show directory, through the same executor and write guard execute-approved-fix.yml
 * uses. Proves the plan applies cleanly BEFORE it lands: a compare-and-set mismatch, a value check, or a write-guard
 * side effect (a url-collision duplicate stamp, a restored protected field) shows here instead of failing the apply run.
 *
 * Usage: node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/<plan>.json [...more plans]
 *   Plans are replayed in the order given, on one shared copy, so later plans see earlier plans' writes.
 *   Exit 0 when every action applies cleanly, 1 otherwise. data/review-texts is never written.
 *   A review-file-op delete/move whose source is not in the tree FAILs here (BRO-5386: eight of seventeen actions
 *   were refused at apply time as "Source not found" because they were planned against a two-day-old local copy
 *   of review-texts). The tree checked is the live review-texts clone when the session has one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeReviewFieldEditIn } = require('./review-field-edit');
const { MAX_PLAN_ACTIONS } = require('./pending-fix-limits');
const { planStatusAction } = require('./plan-status');
const { resolveReviewTextsDir } = require('./review-texts-dir');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Does a review-file-op delete/move have a source to act on, given what earlier actions in the plan removed or created?
 * Pure: `exists` is injected. Mutates `removed`/`created`. Returns null when fine, else the failure reason.
 */
function fileOpSourceProblem(a, exists, removed, created) {
  if (!a || a.type !== 'review-file-op') return null;
  // A restore brings the file back (at destPath when given), so a later delete/move of it has a source.
  if (a.operation === 'restore') {
    const back = a.destPath || a.sourcePath;
    if (back) { created.add(back); removed.delete(back); }
    return null;
  }
  // execute-approved-fix.js treats 'rename' exactly like 'move'.
  if (a.operation !== 'delete' && a.operation !== 'move' && a.operation !== 'rename') return null;
  const src = a.sourcePath;
  const present = created.has(src) || (exists(src) && !removed.has(src));
  if (!present) return `Source not found: ${src} (already moved or deleted? check the live review-texts clone)`;
  removed.add(src); created.delete(src);
  if ((a.operation === 'move' || a.operation === 'rename') && a.destPath) { created.add(a.destPath); removed.delete(a.destPath); }
  return null;
}

function preflight(planPaths, { reviewTextsDir = resolveReviewTextsDir(), log = console.log } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-fix-'));
  const copied = new Set();
  const removed = new Set();
  const created = new Set();
  let failed = 0;
  try {
    for (const planPath of planPaths) {
      const planData = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      const id = planData.issueNumber || path.basename(planPath, '.json');
      const actions = (planData.plan && planData.plan.actions) || [];
      // The executor only runs a "pending" plan; any other new status is refused
      // at apply time after a ~45 min land (BRO-5015, again in BRO-5254 plan G
      // typed "approved"). Same predicate the executor uses.
      if (planStatusAction(planData.status) !== 'run') {
        failed++;
        log(`  FAIL ${id}: status "${planData.status}" will not run; a new plan must be "pending"`);
      }
      // execute-approved-fix refuses a plan over the cap; say so here, not at land (BRO-3414).
      if (actions.length > MAX_PLAN_ACTIONS) {
        failed++;
        log(`  FAIL ${id}: ${actions.length} actions (max ${MAX_PLAN_ACTIONS}); split it into more plans`);
      }
      let ok = 0;
      for (const a of actions) {
        const problem = fileOpSourceProblem(a, (rel) => fs.existsSync(path.join(reviewTextsDir, rel)), removed, created);
        if (problem) { failed++; log(`  FAIL ${id} ${a.operation} ${a.sourcePath}: ${problem}`); continue; }
        if (a.type !== 'review-field-edit') { log(`  skip ${a.type} (not replayed)`); continue; }
        const showId = String(a.file || '').split('/')[0];
        if (showId && !copied.has(showId) && fs.existsSync(path.join(reviewTextsDir, showId))) {
          fs.cpSync(path.join(reviewTextsDir, showId), path.join(tmp, showId), { recursive: true });
          copied.add(showId);
        }
        // A url repair may rest on another show's folder holding the current url
        // (urlOwnedByOtherShow, BRO-3065); copy that folder too, or the replay
        // cannot see the proof the real executor sees.
        if (a.field === 'url') copyUrlOwnerFolder(reviewTextsDir, tmp, a.file, copied);
        const res = executeReviewFieldEditIn(tmp, a, { fixId: id, at: new Date().toISOString() });
        if (res.ok) ok++;
        else { failed++; log(`  FAIL ${id} ${a.file} ${a.field}: ${res.reason}`); }
      }
      log(`${id}: ${ok}/${actions.length} applied cleanly`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { failed };
}

function copyUrlOwnerFolder(reviewTextsDir, tmp, file, copied, { detect } = {}) {
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, file), 'utf8')); } catch { return; }
  const { urlOwnedByOtherShow } = require('./review-slot-guards');
  const owner = urlOwnedByOtherShow({
    reviewTextsDir, folder: String(file).split('/')[0], url: record && record.url, publishDate: record && record.publishDate, detect,
  });
  if (owner && !copied.has(owner.showId)) {
    fs.cpSync(path.join(reviewTextsDir, owner.showId), path.join(tmp, owner.showId), { recursive: true });
    copied.add(owner.showId);
  }
}

module.exports = { preflight, copyUrlOwnerFolder, fileOpSourceProblem };

const USAGE = 'Usage: node scripts/lib/preflight-review-fix-plan.js <plan.json> [...]';

if (require.main === module) {
  if (require('./cli-help').hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  const plans = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!plans.length) { console.error(USAGE); process.exit(2); }
  const { failed } = preflight(plans);
  process.exit(failed ? 1 : 0);
}
