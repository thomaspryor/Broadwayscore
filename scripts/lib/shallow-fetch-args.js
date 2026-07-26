'use strict';
/**
 * Depth-bounding arguments for push-with-retry.sh's post-conflict `git fetch`.
 * Task #466.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * ~100 of the 129 workflows that push through scripts/lib/push-with-retry.sh
 * run on an actions/checkout with the default `fetch-depth: 1`, i.e. a SHALLOW
 * clone with a single commit. When a push is rejected because main advanced,
 * the script fetches the new tip. A fetch that carries NO depth bound asks
 * upload-pack for that ref's history with no cut-off — and from a shallow repo
 * the server answers with the ENTIRE repository (165k+ commits, ~2.1 GB) rather
 * than the ~500-object delta. Measured 2026-07-26 against live main from a
 * depth-1 clone 30 min behind the tip: >1.4 GB pulled and still running when
 * killed at 300 s, for both the bare (`git fetch origin main`) and the
 * explicit-destination (`+refs/heads/main:refs/remotes/origin/main`) form.
 * With GIT_NET_TIMEOUT_SEC=90 that is a guaranteed rc=124 on every retry, which
 * is why run 30191044729 failed 7/7 attempts at the same ~90 s wall with
 * essentially zero variance. The refspec form was never the variable — the
 * missing depth bound was.
 *
 * WHY NOT JUST --depth=1
 * ----------------------
 * It is fast, and it is wrong. `--depth=1` makes the fetched tip a parentless
 * shallow root, so the pre-push base commit is no longer an ancestor of
 * origin/<branch>. push-with-retry.sh then rebases/merges against a tip with no
 * common history: `git rebase -X theirs origin/main` would replay the shallow
 * root's whole-tree snapshot as if it were our change, reverting whatever else
 * landed on main. A fast fetch that loses ancestry is worse than a slow one.
 *
 * THE FIX
 * -------
 * `--shallow-since=@<epoch>` deepens to exactly the window we need: everything
 * from just before our own base commit up to the new tip. Ancestry is restored
 * (the base commit is inside the window), and the server sends only that window
 * instead of the whole history. It is self-tuning — a job that pushes 3 minutes
 * after checkout pulls 3 minutes of churn; one that pushes an hour later pulls
 * an hour.
 *
 * Same clones, same 30-min gap, measured 2026-07-26 (time / exit / ancestry):
 *     no depth bound (bare AND explicit)   300s  rc=124   —
 *     --deepen=1                           300s  rc=124   —
 *     --depth=1                            3-8s  rc=0     ancestry=NO   ← fast, wrong
 *     --depth=200                            46s rc=0     ancestry=YES
 *     --deepen=200                           41s rc=0     ancestry=YES
 *     --shallow-since=base-5min               8s rc=0     ancestry=YES  ← shipped
 * A fixed --depth is both ~5x slower and brittle: --depth=200 spans only ~80
 * min of this repo's ~150 commits/hour, so a longer job silently loses
 * ancestry again. The since-window cannot go stale that way.
 *
 * Only applies to shallow repos. A `fetch-depth: 0` checkout must keep the
 * plain unbounded fetch: passing --shallow-since to a complete clone would
 * TRUNCATE it into a shallow one, throwing away history the job may need.
 */

const DEFAULT_SLACK_SEC = 1800; // 30 min either side of the base commit's date
// Only reached when the boundary date is unusable. Kept at the measured
// --depth=200 (46s) rather than something larger: it must still finish inside
// GIT_NET_TIMEOUT_SEC=90, and 200 commits covers ~80 min of this repo's churn.
const DEFAULT_FALLBACK_DEPTH = 200;

/**
 * @param {object} opts
 * @param {boolean} opts.isShallow           `git rev-parse --is-shallow-repository`
 * @param {number|string} opts.oldestCommitEpoch  committer epoch of the oldest
 *        LOCAL commit (the shallow boundary) — `git log --format=%ct HEAD | tail -1`
 * @param {number} [opts.slackSec]           widen the window by this much
 * @param {number} [opts.fallbackDepth]      used when the epoch is unusable
 * @returns {string[]} extra args to pass to `git fetch` (possibly empty)
 */
function shallowFetchArgs(opts = {}) {
  const {
    isShallow,
    oldestCommitEpoch,
    slackSec = DEFAULT_SLACK_SEC,
    fallbackDepth = DEFAULT_FALLBACK_DEPTH,
  } = opts;

  // Complete clone: unbounded fetch is both correct and cheap. Bounding it here
  // would shallow-ify a repo the caller deliberately checked out in full.
  if (!isShallow) return [];

  const epoch = Number(oldestCommitEpoch);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    // No usable boundary date (empty/corrupt log). A fixed depth still bounds
    // the transfer; it may or may not restore ancestry, and the caller's
    // post-fetch ancestry check escalates if it doesn't.
    return [`--depth=${fallbackDepth}`];
  }

  const slack = Number.isFinite(Number(slackSec)) && Number(slackSec) > 0 ? Math.floor(Number(slackSec)) : 0;
  const since = Math.max(1, Math.floor(epoch) - slack);
  return [`--shallow-since=@${since}`];
}

module.exports = { shallowFetchArgs, DEFAULT_SLACK_SEC, DEFAULT_FALLBACK_DEPTH };

// CLI: emit the args space-separated so bash can read them into an array.
// None of the emitted args can contain whitespace, so word-splitting is safe.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const args = shallowFetchArgs({
    isShallow: get('is-shallow') === 'true',
    oldestCommitEpoch: get('oldest-epoch'),
    slackSec: get('slack-sec') !== undefined ? Number(get('slack-sec')) : undefined,
  });
  process.stdout.write(args.join(' '));
}
