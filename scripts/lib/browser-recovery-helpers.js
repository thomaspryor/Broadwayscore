/**
 * Shared pieces for authenticated real-browser review-text recovery (task #831,
 * generalizing scripts/recover-wsj-browser.js to NYT + New Yorker).
 *
 * recover-wsj-subscriber.js's plain-fetch() + __NEXT_DATA__ approach was dead
 * on two counts for WSJ (see recover-wsj-browser.js header): bare fetch()
 * gets 401 even with valid cookies, and the server-rendered payload stays
 * paywall-locked until client-side hydration resolves entitlements. Real
 * browser + real cookies + a DOM read after hydration is the general-purpose
 * fix — this file factors out the parts that don't vary per outlet
 * (candidate discovery, the shared gap-acceptance gate, locked writes, scoped
 * checkpoint/push) so each outlet script only supplies its login/cookie/
 * selector specifics. The task #915 date-plausibility guard now lives in
 * gap-acceptance.js's acceptRecoveredText.
 */

const fs = require('fs');
const { readReviewForUpdate, persistReviewSnapshot } = require('./persist-review-snapshot');
const path = require('path');

const { recoverReviewText } = require('./gap-acceptance');
const { withReviewTextsLock } = require('./review-texts-lock');
const { checkpointReviewTexts, retryPendingPushes, createWriteTracker } = require('./review-texts-checkpoint');

// Overridable so a worktree session (which has no gitignored data/review-texts
// clone of its own — that private repo isn't part of this repo's git tree)
// can point at the main checkout's clone without a symlink. A symlink at this
// exact gitignored path is NOT matched by the trailing-slash `data/review-texts/`
// .gitignore pattern (git only treats a directory as matching that pattern,
// not a symlink-to-directory), so it would show up untracked instead of
// silently ignored — confirmed live 2026-08-02.
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', '..', 'data', 'review-texts');

// Every review file this process writes (recovered text or a dead-candidate
// stamp). checkpoint() stages exactly these paths, never `git add -A`
// (BRO-7171): the review-texts checkout is shared with other local writers.
const RUN_WRITES = createWriteTracker();

/**
 * Find review-text files for `filePrefix` (e.g. "nytimes", or a list of
 * prefixes when one paywall serves several outlets) that are not yet
 * contentTier=complete, are not already flagged wrong-show/wrong-production,
 * and carry a URL to refetch. Recency-first ordering via the trailing -YYYY
 * in the showId, matching recover-wsj-browser.js's proxy for "prioritize
 * recent shows" (openingDate/publishDate parsing was too inconsistent
 * corpus-wide to rely on directly).
 */
function loadCandidates({ filePrefix, showsAllowlist, maxUrls = Infinity }) {
  let dirs;
  try {
    dirs = fs.readdirSync(REVIEW_TEXTS_DIR);
  } catch (e) {
    throw new Error(
      `Cannot read review-texts dir at ${REVIEW_TEXTS_DIR} (${e.code || e.message}). ` +
      `Worktree sessions have no private review-texts clone of their own — set ` +
      `REVIEW_TEXTS_DIR to the main checkout's path, e.g. REVIEW_TEXTS_DIR=/path/to/Broadwayscore/data/review-texts.`
    );
  }
  const prefixes = [].concat(filePrefix);
  const candidates = [];
  for (const dir of dirs) {
    if (showsAllowlist && !showsAllowlist.has(dir)) continue;
    const showPath = path.join(REVIEW_TEXTS_DIR, dir);
    let stat;
    try { stat = fs.statSync(showPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let files;
    try { files = fs.readdirSync(showPath); } catch { continue; }
    for (const f of files) {
      if (!prefixes.some((p) => f.startsWith(`${p}--`)) || !f.endsWith('.json')) continue;
      const filePath = path.join(showPath, f);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (data.contentTier === 'complete') continue;
      if (data.wrongShow || data.wrongProduction) continue;
      if (!data.url) continue;

      candidates.push({
        reviewId: `${dir}/${f}`,
        filePath,
        url: data.url,
        showId: data.showId || dir,
        existingChars: (data.fullText || '').length,
        contentTier: data.contentTier || 'unknown',
      });
    }
  }
  candidates.sort((a, b) => {
    const ya = (a.showId.match(/-(\d{4})$/) || [])[1] || '0';
    const yb = (b.showId.match(/-(\d{4})$/) || [])[1] || '0';
    return yb.localeCompare(ya);
  });

  return candidates.slice(0, maxUrls);
}

/**
 * Gate and write recovered text into a candidate's review file. A thin
 * adapter over gap-acceptance.js's recoverReviewText (BRO-7171), the single
 * gate every recovery route shares: lock, fresh read, acceptRecoveredText,
 * one safeWriteReview write with priorFullTextHash provenance.
 *
 * @param {object} candidate - from loadCandidates()
 * @param {string} rawText - text extracted from the live authenticated DOM
 * @param {object} labels - { fetchMethod, sourceMethod, contentTierReasonFallback }
 * @param {{dryRun?: boolean, tracker?: Set<string>, headline?: string}} [opts]  headline: the
 *   fetched page's own og:title/h1 (gap-acceptance headlineIdentity, The Stage only)
 * @returns {{ok: boolean, code: string, reason?: string, newLen?: number}}
 */
function processRecoveredText(candidate, rawText, labels, opts = {}) {
  const r = recoverReviewText({
    filePath: candidate.filePath,
    rawText,
    headline: opts.headline || null,
    // The browser fetched candidate.url: refuse if another writer moved the
    // record's url meanwhile, so old-page text never lands under a new url.
    expectUrl: candidate.url || null,
    labels,
    dryRun: !!opts.dryRun,
    tracker: opts.tracker || RUN_WRITES,
  });
  return { ok: r.ok, code: r.code, reason: r.reason, newLen: r.newLen };
}

/**
 * Stamp a candidate whose fetch failed, under the review-texts lock, and
 * track the file for the next checkpoint.
 * @param {{filePath: string}} candidate
 * @param {object} fields - fields to set (e.g. incompleteReason, incompleteDetail)
 * @param {{tracker?: Set<string>}} [opts]
 */
function stampDead(candidate, fields, opts = {}) {
  withReviewTextsLock(`stamp:${path.basename(candidate.filePath)}`, () => {
    const data = readReviewForUpdate(candidate.filePath);
    Object.assign(data, fields);
    persistReviewSnapshot({ filePath: candidate.filePath, data, trailingNewline: true });
  });
  (opts.tracker || RUN_WRITES).add(path.resolve(candidate.filePath));
}

/**
 * Run before any new work: push what an earlier run committed but could not
 * push, restore commits a concurrent reset wiped. Throws when the push still
 * fails, so a run never piles new work onto an unpushed backlog.
 */
function startRun(opts = {}) {
  const r = retryPendingPushes({ repoDir: opts.repoDir || REVIEW_TEXTS_DIR, onLanded: opts.onLanded });
  if (r.entries) {
    console.log(`  [Pending] ${r.entries} earlier checkpoint(s): ${r.landed.length} landed, ${r.restored.length} restored, ${r.notLanded.length} not landed`);
    for (const n of r.notLanded) console.log(`    not landed: ${n.rel} (${n.why || 'text not on origin/main'})`);
  }
  return r;
}

/**
 * Commit and push exactly the files this run wrote. A failed push THROWS
 * (ReviewTextsPushError): the caller's run stops instead of counting reviews
 * that exist only on this disk. Returns the checkpoint result; `landed` lists
 * the paths origin/main now holds.
 */
function checkpoint(stats, commitMessagePrefix, opts = {}) {
  if (stats.dryRun) return null;
  const tracker = opts.tracker || RUN_WRITES;
  if (!tracker.size) return null;
  const paths = [...tracker];
  const res = checkpointReviewTexts({
    repoDir: opts.repoDir || REVIEW_TEXTS_DIR,
    paths,
    expected: tracker.expected,
    message: `feat: ${commitMessagePrefix} - ${stats.recovered} reviews recovered (task #831)`,
    onLanded: opts.onLanded,
    pushScript: opts.pushScript,
    pushEnv: opts.pushEnv,
    retries: opts.retries,
  });
  for (const p of paths) { tracker.delete(p); if (tracker.expected) tracker.expected.delete(p); }
  console.log(`  [Checkpoint] ${res.pushed ? 'Pushed' : 'Nothing new to push'} (${stats.recovered} recovered so far; ${res.landed.length} file(s) confirmed on origin/main)`);
  for (const n of res.notLanded) console.log(`  [Checkpoint] NOT on origin/main after push: ${n.rel}`);
  return res;
}

/**
 * Take the whole-run recovery lock (recovery-run-lock.js) before a manual
 * recover-*-browser.js run opens Chrome, so it never overlaps the nightly
 * gap-recovery job (BRO-7171 Stage 3). Throws RunLockBusyError naming the
 * holder; the scripts' main().catch prints it and exits non-zero.
 */
function acquireRecoveryRunLock(label) {
  return require('./recovery-run-lock').acquireRunLock(label);
}

module.exports = { loadCandidates, processRecoveredText, stampDead, startRun, checkpoint, acquireRecoveryRunLock, RUN_WRITES, REVIEW_TEXTS_DIR };
