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
 * (candidate discovery, content-quality gating, checkpoint/push) so each
 * outlet script only supplies its login/cookie/selector specifics.
 */

const fs = require('fs');
const { readReviewForUpdate, persistReviewSnapshot } = require('./persist-review-snapshot');
const path = require('path');

const { evaluateDatePlausibility } = require('./date-plausibility');
const { recoverReviewText } = require('./gap-acceptance');
const { withReviewTextsLock } = require('./review-texts-lock');
const { checkpointReviewTexts, retryPendingPushes, createWriteTracker } = require('./review-texts-checkpoint');

// Same worktree-symlink gap as REVIEW_TEXTS_DIR above — data/shows.json is a
// gitignored symlink into the private ~/broadway-scorecard-data clone, so a
// worktree checkout (git tree only) never has it. Fall back to the home-dir
// clone directly; SHOWS_JSON_PATH overrides both for tests/alternate setups.
const SHOWS_JSON_PATH = process.env.SHOWS_JSON_PATH
  || (fs.existsSync(path.join(__dirname, '..', '..', 'data', 'shows.json'))
    ? path.join(__dirname, '..', '..', 'data', 'shows.json')
    : path.join(require('os').homedir(), 'broadway-scorecard-data', 'shows.json'));

// Lazy-loaded, memoized once per process.
let _showsByIdCache = null;
function getShowById(showId) {
  if (!_showsByIdCache) {
    _showsByIdCache = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(SHOWS_JSON_PATH, 'utf8'));
      const shows = Array.isArray(parsed) ? parsed : (parsed.shows || []);
      for (const s of shows) { if (s && s.id) _showsByIdCache.set(s.id, s); }
    } catch { /* leave cache empty — date-plausibility check below just no-ops */ }
  }
  return _showsByIdCache.get(showId) || null;
}

/**
 * Date-plausibility guard (task #915, follow-up to #895's 7 wrongProduction
 * false positives — e.g. hamlet-2026/nytimes--charles-isherwood.json was a
 * 2015 Classic Stage Company review, 11 years before the 2026 show's opening,
 * admitted because the bare word "hamlet" trivially satisfies
 * validateShowMentioned). safeWriteReview's own date-implausible gate only
 * fires when publishDate is arriving for the FIRST time; these candidate
 * files already carry a publishDate from initial discovery, so that gate
 * never sees this write — check here instead, against the existing date.
 * Exported so every outlet's recovery script shares one implementation
 * (recover-wsj-browser.js predates this shared helper and has its own local
 * processRecoveredText — it calls this directly rather than duplicating the
 * date logic a second time).
 *
 * @param {{showId: string}} candidate
 * @param {{publishDate?: string}} data - the on-disk review record (already
 *   read by the caller) whose publishDate is being checked
 * @returns {string|null} a rejection reason, or null if plausible / unknown
 */
function checkDatePlausibility(candidate, data) {
  if (!data.publishDate) return null;
  const show = getShowById(candidate.showId);
  if (!show) return null;
  const verdict = evaluateDatePlausibility({ review: data, show });
  if (!verdict.implausible) return null;
  return `date implausible: publishDate ${data.publishDate} is ${verdict.daysBefore}d before earliest show date ${verdict.earliestDate} (likely wrong production — declare priorRuns if this is a legitimate earlier run)`;
}

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
 * @param {{dryRun?: boolean, tracker?: Set<string>}} [opts]
 * @returns {{ok: boolean, code: string, reason?: string, newLen?: number}}
 */
function processRecoveredText(candidate, rawText, labels, opts = {}) {
  const r = recoverReviewText({
    filePath: candidate.filePath,
    rawText,
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
    message: `feat: ${commitMessagePrefix} - ${stats.recovered} reviews recovered (task #831)`,
    onLanded: opts.onLanded,
    pushScript: opts.pushScript,
    pushEnv: opts.pushEnv,
  });
  for (const p of paths) tracker.delete(p);
  console.log(`  [Checkpoint] ${res.pushed ? 'Pushed' : 'Nothing new to push'} (${stats.recovered} recovered so far; ${res.landed.length} file(s) confirmed on origin/main)`);
  for (const n of res.notLanded) console.log(`  [Checkpoint] NOT on origin/main after push: ${n.rel}`);
  return res;
}

module.exports = { loadCandidates, processRecoveredText, stampDead, startRun, checkpoint, RUN_WRITES, REVIEW_TEXTS_DIR, checkDatePlausibility, getShowById };
