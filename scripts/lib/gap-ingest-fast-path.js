'use strict';
/**
 * gap-ingest-fast-path.js — publish gap-audit ingests on an opening night
 * without waiting for the slow chain (BRO-6695).
 *
 * The Moth, 2026-10-30: audit-aggregator-gap ingested FringeReview and London
 * Pub Theatres at 23:25Z but we were live at 00:18Z (53 min, bar 30). The job
 * held the files until its last step (23:33), then dispatched the FULL
 * "Rebuild Reviews Data" (17 min), whose orphan-unscored guard finally
 * dispatched scoring, then a second rebuild and a deploy.
 *
 * Fast path: right after the ingest step, push review-texts and dispatch the
 * per-show scoring lane (dispatchRescore: scoring + fast rebuild) for every
 * show that gained a NEW review file and is urgent (in or near its opening
 * night window). Non-urgent shows (back-catalogue) keep the old slow path.
 */
const { execFileSync } = require('child_process');

/**
 * Show ids that gained a file, from `git diff --name-only --diff-filter=A`
 * lines of the review-texts repo ("<show-id>/<outlet>--<critic>.json").
 * Skips `_pending/`-style underscore dirs and non-review files.
 */
function newShowIdsFromPaths(paths) {
  const ids = new Set();
  for (const line of paths || []) {
    const p = String(line || '').trim();
    const m = /^([^/]+)\/[^/]+\.json$/.exec(p);
    if (!m) continue;
    if (m[1].startsWith('_') || m[1].startsWith('.')) continue;
    ids.add(m[1]);
  }
  return [...ids].sort();
}

/**
 * @param {object} p
 * @param {string[]} p.showIds        shows that gained a review file
 * @param {Set<string>} p.urgentIds   urgentScoringShowIds() result
 * @param {(showId:string, opts:object)=>Promise<{ok:boolean,error?:string}>} p.dispatch
 * @returns {Promise<{dispatched:string[], notUrgent:string[], failed:string[], allHandled:boolean}>}
 *   allHandled: every new show was dispatched OK, so the slow full-rebuild
 *   trigger is redundant. False when any show was skipped or failed.
 */
async function fastPublish({ showIds, urgentIds, dispatch, reason = 'gap-ingest' }) {
  const dispatched = [];
  const notUrgent = [];
  const failed = [];
  for (const id of showIds) {
    if (!urgentIds.has(id)) { notUrgent.push(id); continue; }
    let res;
    try { res = await dispatch(id, { reason }); } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
    (res && res.ok ? dispatched : failed).push(id);
  }
  return { dispatched, notUrgent, failed, allHandled: showIds.length > 0 && notUrgent.length === 0 && failed.length === 0 };
}

function listAddedPaths(repoDir, beforeSha) {
  const out = execFileSync('git', ['-C', repoDir, 'diff', '--name-only', '--diff-filter=A', `${beforeSha}..HEAD`], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

module.exports = { newShowIdsFromPaths, fastPublish, listAddedPaths };

// CLI (audit-aggregator-gap.yml "Fast-publish ingested reviews"):
//   BEFORE_SHA=<review-texts sha before ingest> node scripts/lib/gap-ingest-fast-path.js
// Prints `all_handled=true|false` for $GITHUB_OUTPUT. Never throws: a failure
// here must leave the old slow rebuild trigger in charge.
if (require.main === module) {
  require('./cli-help').exitOnHelp(module);
  (async () => {
    let allHandled = false;
    try {
      const fs = require('fs');
      const path = require('path');
      const { urgentScoringShowIds } = require('./scoring-lane');
      const { loadReviewEvidence } = require('./review-evidence');
      const { dispatchRescore } = require('./dispatch-rescore');
      const before = process.env.BEFORE_SHA;
      if (!before) throw new Error('BEFORE_SHA not set');
      const showIds = newShowIdsFromPaths(listAddedPaths(path.join(__dirname, '..', '..', 'data', 'review-texts'), before));
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'shows.json'), 'utf8'));
      const shows = Array.isArray(raw) ? raw : (raw.shows || []);
      const urgentIds = urgentScoringShowIds(shows, { evidence: loadReviewEvidence() });
      const r = await fastPublish({ showIds, urgentIds, dispatch: dispatchRescore });
      allHandled = r.allHandled;
      console.log(`gap-ingest-fast-path: new shows=[${showIds}] dispatched=[${r.dispatched}] notUrgent=[${r.notUrgent}] failed=[${r.failed}]`);
    } catch (e) {
      console.log(`::warning::gap-ingest-fast-path failed (${String(e.message).split('\n')[0]}); slow rebuild trigger stays in charge`);
    }
    if (process.env.GITHUB_OUTPUT) fs_append(process.env.GITHUB_OUTPUT, `all_handled=${allHandled}\n`);
  })();
}

function fs_append(file, text) { require('fs').appendFileSync(file, text); }
