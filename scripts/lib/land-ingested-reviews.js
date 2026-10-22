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
    try {
      exec(`git -C "${reviewTextsDir}" pull --rebase --autostash origin main`, { stdio: 'pipe' });
    } catch (rebaseErr) {
      log(`  ⚠️  Pull-rebase failed: ${execErrorDetail(rebaseErr)}`);
      log('  Attempting push anyway; if it fails resolve manually.');
    }
    exec(`git -C "${reviewTextsDir}" push origin main`, { stdio: 'pipe' });
    log(`  ✓ Pushed ${relPaths.length} review-text file(s) to private repo`);
    return { pushed: true };
  } catch (e) {
    const error = execErrorDetail(e);
    log(`  ⚠️  Push to review-texts failed: ${error}`);
    return { pushed: false, error };
  }
}

/** Dispatch the downstream workflows. Returns array of {name, ok}. */
function dispatchDownstream({ showId, newReviews, only, exec = execSync, log = console.log }) {
  let workflows = downstreamWorkflows(showId, newReviews);
  if (only) workflows = workflows.filter((w) => only.includes(w.file));
  return workflows.map((wf) => {
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

/** Push, and only if the push landed, dispatch. A failed push never dispatches (CI would score a clone without the files). */
function landIngestedReviews({ showId, extraShowIds = [], reviewTextsDir, touchedPaths, newReviews, message, only, exec, log, isCheckout }) {
  const push = pushReviewTexts({ reviewTextsDir, touchedPaths, message, exec, log, isCheckout });
  if (!push.pushed) return { push, dispatched: [] };
  const shows = [...new Set([showId, ...extraShowIds])];
  return { push, dispatched: shows.flatMap((id) => dispatchDownstream({ showId: id, newReviews, only, exec, log })) };
}

module.exports = { pushReviewTexts, dispatchDownstream, landIngestedReviews };
