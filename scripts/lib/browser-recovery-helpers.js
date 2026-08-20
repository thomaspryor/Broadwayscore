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
const path = require('path');
const { execSync } = require('child_process');

const { classifyContentTier, isGarbageContent, validateShowMentioned, countWords } = require('./content-quality');
const { cleanText, stripTrailingJunk } = require('./text-cleaning');
const { evaluateDatePlausibility } = require('./date-plausibility');
const { markRescoreFlagged } = require('./rescore-lifecycle');

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

const PUSH_WITH_RETRY = path.join(__dirname, 'push-with-retry.sh');

/**
 * Find review-text files for `filePrefix` (e.g. "nytimes") that are not yet
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
      if (!f.startsWith(filePrefix) || !f.endsWith('.json')) continue;
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
 * Clean, quality-gate, and write recovered text into a candidate's review
 * file. Mirrors recover-wsj-browser.js's processRecoveredText exactly.
 *
 * @param {object} candidate - from loadCandidates()
 * @param {string} rawText - text extracted from the live authenticated DOM
 * @param {object} labels - { fetchMethod, sourceMethod, contentTierReasonFallback }
 */
function processRecoveredText(candidate, rawText, labels) {
  let cleanedText = cleanText(rawText);
  cleanedText = stripTrailingJunk(cleanedText);
  if (cleanedText.length < 300) {
    return { ok: false, reason: `too short after cleaning (${cleanedText.length})` };
  }

  const garbageCheck = isGarbageContent(cleanedText);
  if (garbageCheck.isGarbage) {
    return { ok: false, reason: `garbage content: ${garbageCheck.reason}` };
  }

  // Order matters: "off-west-end" must be checked before the shorter
  // "west-end" alternative, or the "off-" prefix is left dangling in the
  // derived title (360-allstars-off-west-end-2026 -> "360 allstars off",
  // confirmed live 2026-08-02 — validateShowMentioned then rejects a real,
  // correctly-recovered Off-West-End review as "show not mentioned").
  const showTitle = candidate.showId.replace(/-\d{4}$/, '').replace(/-(off-west-end|west-end|off-broadway|regional)$/, '').replace(/-/g, ' ');
  const mentionResult = validateShowMentioned(cleanedText, showTitle, candidate.showId);
  if (!mentionResult.valid) {
    return { ok: false, reason: `show not mentioned: "${showTitle}"` };
  }

  const data = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));
  if (data.fullText && data.fullText.length >= cleanedText.length) {
    return { ok: false, reason: `not longer than existing (${data.fullText.length} >= ${cleanedText.length})` };
  }

  const dateRejection = checkDatePlausibility(candidate, data);
  if (dateRejection) {
    return { ok: false, reason: dateRejection };
  }

  data.fullText = cleanedText;
  data.isFullReview = cleanedText.length > 1500;
  data.textWordCount = countWords(cleanedText);
  data.textFetchedAt = new Date().toISOString();
  data.fetchMethod = labels.fetchMethod;
  data.sourceMethod = labels.sourceMethod;

  const tierResult = classifyContentTier(data);
  data.contentTier = tierResult.contentTier || tierResult.tier;
  data.contentTierReason = tierResult.tierReason || tierResult.reason || labels.contentTierReasonFallback;

  if (data.llmScore?.score) {
    data.needsRescore = true;
    data.rescoreReason = `fullText recovered via ${labels.sourceMethod} (task #831)`;
    markRescoreFlagged(data);
  }

  fs.writeFileSync(candidate.filePath, JSON.stringify(data, null, 2) + '\n');
  return { ok: true, newLen: cleanedText.length };
}

/**
 * Stamp a dead-candidate's incompleteReason and checkpoint-commit any
 * recovered files to the (separate) review-texts repo. Identical retry/backoff
 * shape to recover-wsj-browser.js.
 */
function checkpoint(stats, commitMessagePrefix) {
  if (stats.dryRun) return;
  const reviewTextsRepo = REVIEW_TEXTS_DIR;
  try {
    execSync('git add -A', { stdio: 'pipe', cwd: reviewTextsRepo });
    try {
      execSync('git diff --staged --quiet', { stdio: 'pipe', cwd: reviewTextsRepo });
      return; // nothing staged
    } catch {} // non-zero = there ARE staged changes
    const msg = `feat: ${commitMessagePrefix} - ${stats.recovered} reviews recovered (task #831)`;
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe', cwd: reviewTextsRepo });
    // push-with-retry.sh (not a hand-rolled `git pull --rebase`) — a bare
    // rebase-fetch carries no depth bound, and ~130 of this repo's CI
    // workflows check out on fetch-depth:1, so an unbounded fetch here would
    // pull the whole ~2.1GB/165k-commit history instead of the small delta
    // (task #466, caught by the unbounded-fetch push audit).
    try {
      execSync(`bash "${PUSH_WITH_RETRY}" 5`, { stdio: 'pipe', cwd: reviewTextsRepo, timeout: 180000 });
      console.log(`  [Checkpoint] Pushed (${stats.recovered} recovered so far)`);
    } catch {
      console.log('  [Checkpoint] WARNING: could not push after retries');
    }
  } catch (e) {
    console.log(`  [Checkpoint] Error: ${e.message}`);
  }
}

module.exports = { loadCandidates, processRecoveredText, checkpoint, REVIEW_TEXTS_DIR, checkDatePlausibility, getShowById };
