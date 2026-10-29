'use strict';

/**
 * Push freshly written review-text files to the private broadway-review-texts
 * repo, then dispatch per-show scoring. Shared by ingest-urls.js and
 * ingest-review-from-url.js --land.
 *
 * BRO-4908: rent-west-end-2026 direct-ingested reviews (WEBF, LTD) were
 * committed to review-texts by hand and sat unscored ~45 min, because the
 * single-URL ingest only writes a file: nothing pushed it or dispatched
 * llm-ensemble-score.yml, so scoring waited for the next rebuild's
 * verify-all-scored self-heal. CI scores from a fresh clone, so the push must
 * land BEFORE the dispatch (order is part of the contract, locked by test).
 */

const path = require('path');
const { execSync } = require('child_process');
const { execErrorDetail } = require('./exec-error-detail');
const { downstreamWorkflows } = require('./ingest-downstream');
const { isReviewTextsClone } = require('./review-texts-dir');
const { CAPS, checkCap } = require('./workflow-queue-cap');
const { isUrgentShowId } = require('./scoring-lane');
const { pushWithRetry } = require('./push-with-retry');

// Tests that inject `exec` must never reach the real push script (it could push a
// real clone), so only the real exec gets the real helper.
const refusePush = () => ({ ok: false, code: null, stderr: 'pushRetry not injected alongside a stub exec' });

/**
 * Push the given absolute file paths. Returns {pushed: boolean, error?: string}.
 *
 * BRO-5936: every bug in this class so far has been a write root that is not the
 * review-texts checkout — the gitignored data/review-texts copy on the Mac
 * (BRO-5874), then the same path again under a new variable name (BRO-5895's
 * fan-out). The static guard in review-texts-push-dir.test.mjs reads source, so
 * it only ever catches the shapes it knows; these two checks read the dir and
 * the paths at run time, so they hold whatever the variable is called and
 * whichever root the resolver picks. They matter on the Mac and only there: in
 * CI data/review-texts IS the checkout, so both roots coincide and no static or
 * integration test can tell a wrong root from a right one.
 *
 * Refusing is strictly better than letting git run: `git -C <copy>` walks UP to
 * the enclosing Broadwayscore repo, where these paths are gitignored, so the
 * add fails with a message about .gitignore and the real cause (wrong root)
 * never appears. And the dir must be the review-texts CLONE, not merely some
 * checkout — pointed at the Broadwayscore checkout itself, a `.git`-only test
 * passes and the add then runs in the PUBLIC repo (caught in review).
 */
function pushReviewTexts({
  reviewTextsDir, touchedPaths, message, exec = execSync, log = console.log,
  isCheckout = isReviewTextsClone,
  pushRetry = exec === execSync ? pushWithRetry : refusePush,
}) {
  if (!isCheckout(reviewTextsDir)) {
    const error = `not the review-texts clone: ${reviewTextsDir}`;
    log(`  ⚠️  Refusing to push: ${error}`);
    log('     It must be a checkout whose origin is broadway-review-texts. A gitignored');
    log('     copy cannot be committed, and any other repo would take these paths as its');
    log('     own. Point REVIEW_TEXTS_DIR at the clone (scripts/lib/review-texts-dir.js).');
    return { pushed: false, error };
  }
  const relPaths = touchedPaths.map((p) => path.relative(reviewTextsDir, p));
  const escaped = relPaths.filter((p) => p === '' || path.isAbsolute(p)
    || p === '..' || p.startsWith(`..${path.sep}`));
  if (escaped.length) {
    const error = `${escaped.length} path(s) are outside ${reviewTextsDir}: ${escaped.slice(0, 3).join(', ')}`;
    log(`  ⚠️  Refusing to push: ${error}`);
    log('     The files were written to a different review-texts root than the one being');
    log('     pushed; write and push the single dir resolveReviewTextsDir() returns.');
    return { pushed: false, error };
  }
  const q = relPaths.map((p) => `"${p}"`).join(' ');
  try {
    // Stage only what this run touched; -A so a renamed-away path is a deletion.
    exec(`git -C "${reviewTextsDir}" add -A -- ${q}`, { stdio: 'pipe' });
    const status = String(exec(`git -C "${reviewTextsDir}" status --porcelain -- ${q}`, { encoding: 'utf8' }) || '').trim();
    if (status) {
      exec(`git -C "${reviewTextsDir}" commit -m ${JSON.stringify(message)}`, { stdio: 'pipe' });
    } else {
      // Clean tree is only "nothing to push" if no earlier commit is stuck
      // locally (a prior run that committed then failed at push).
      const ahead = String(exec(`git -C "${reviewTextsDir}" rev-list --count origin/main..HEAD`, { encoding: 'utf8' }) || '0').trim();
      if (ahead === '0') {
        log('  — No changes to push (files match remote).');
        return { pushed: true };
      }
    }
    // BRO-6485: one pull-rebase then one push lost the race to concurrent ingest
    // runs ("fetch first", run 40951242833). The shared helper re-fetches,
    // rebases and retries within its 240s deadline.
    const res = pushRetry({ cwd: reviewTextsDir, branch: 'HEAD:main' });
    if (!res.ok) {
      const error = String(res.stderr || `push-with-retry exit ${res.code}`).trim().split('\n').slice(-3).join(' | ');
      log(`  ⚠️  Push to review-texts failed: ${error}`);
      return { pushed: false, error };
    }
    log(`  ✓ Pushed ${relPaths.length} review-text file(s) to private repo`);
    return { pushed: true };
  } catch (e) {
    const error = execErrorDetail(e);
    log(`  ⚠️  Push to review-texts failed: ${error}`);
    return { pushed: false, error };
  }
}

/**
 * Dispatch the downstream workflows. Returns array of {name, ok, deferred?}.
 *
 * BRO-6532: the per-show scoring dispatch goes through the bulk-workflow cap.
 * With too many scoring runs already in flight, a show outside its opening-night
 * window is deferred to the scheduled half-price batch runs (4x daily), which is
 * where routine catch-up scoring goes anyway (BRO-5047). Real
 * runs check the cap by default; tests that inject `exec` opt in via `capCheck`.
 */
function dispatchDownstream({
  showId, newReviews, only, exec = execSync, log = console.log,
  capCheck = exec === execSync ? checkCap : null, urgent = isUrgentShowId,
}) {
  let workflows = downstreamWorkflows(showId, newReviews);
  if (only) workflows = workflows.filter((w) => only.includes(w.file));
  return workflows.map((wf) => {
    if (capCheck && CAPS[wf.file] && !urgent(showId)) {
      const cap = capCheck({ workflow: wf.file, log });
      if (!cap.ok) {
        log(`::warning::${wf.name} deferred for ${showId}: ${cap.reason}. The next scheduled batch run will score it.`);
        return { name: wf.name, ok: true, deferred: true };
      }
    }
    try {
      exec(`gh workflow run ${wf.file} ${wf.args}`, { stdio: 'pipe' });
      log(`  ✓ ${wf.name} triggered`);
      return { name: wf.name, ok: true };
    } catch (e) {
      log(`::warning::${wf.name} failed to trigger for ${showId}: ${String(e.message).split('\n')[0]}`);
      return { name: wf.name, ok: false };
    }
  });
}

/**
 * What ingest-urls.js does when its review-texts push failed. In CI the workflow's
 * commit step re-pushes the stranded commit, then dispatches from the marker, so
 * the run is not a failure there; with --no-rebuild nothing is dispatched at all
 * (BRO-6485: exiting 1 there turned recovered runs red). Elsewhere nothing will
 * push the files, so the run fails.
 * @returns {'write-marker'|'none'|'fail'}
 */
function pushFailureAction({ inCiWithCommitStep, noRebuild }) {
  if (!inCiWithCommitStep) return 'fail';
  return noRebuild ? 'none' : 'write-marker';
}

/** Push, and only if the push landed, dispatch. A failed push never dispatches (CI would score a clone without the files). */
function landIngestedReviews({ showId, extraShowIds = [], reviewTextsDir, touchedPaths, newReviews, message, only, exec, log, isCheckout, pushRetry }) {
  const push = pushReviewTexts({ reviewTextsDir, touchedPaths, message, exec, log, isCheckout, pushRetry });
  if (!push.pushed) return { push, dispatched: [] };
  const shows = [...new Set([showId, ...extraShowIds])];
  return { push, dispatched: shows.flatMap((id) => dispatchDownstream({ showId: id, newReviews, only, exec, log })) };
}

module.exports = { pushReviewTexts, dispatchDownstream, landIngestedReviews, pushFailureAction };
