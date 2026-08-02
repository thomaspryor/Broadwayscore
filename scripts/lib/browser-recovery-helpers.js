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

// Overridable so a worktree session (which has no gitignored data/review-texts
// clone of its own — that private repo isn't part of this repo's git tree)
// can point at the main checkout's clone without a symlink. A symlink at this
// exact gitignored path is NOT matched by the trailing-slash `data/review-texts/`
// .gitignore pattern (git only treats a directory as matching that pattern,
// not a symlink-to-directory), so it would show up untracked instead of
// silently ignored — confirmed live 2026-08-02.
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', '..', 'data', 'review-texts');

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

  const showTitle = candidate.showId.replace(/-\d{4}$/, '').replace(/-(west-end|off-broadway|regional)$/, '').replace(/-/g, ' ');
  const mentionResult = validateShowMentioned(cleanedText, showTitle, candidate.showId);
  if (!mentionResult.valid) {
    return { ok: false, reason: `show not mentioned: "${showTitle}"` };
  }

  const data = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));
  if (data.fullText && data.fullText.length >= cleanedText.length) {
    return { ok: false, reason: `not longer than existing (${data.fullText.length} >= ${cleanedText.length})` };
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
    for (let i = 0; i < 5; i++) {
      try {
        execSync('git pull --rebase origin main', { stdio: 'pipe', cwd: reviewTextsRepo, timeout: 30000 });
        execSync('git push origin main', { stdio: 'pipe', cwd: reviewTextsRepo, timeout: 30000 });
        console.log(`  [Checkpoint] Pushed (${stats.recovered} recovered so far)`);
        return;
      } catch {
        try { execSync('git rebase --abort', { stdio: 'pipe', cwd: reviewTextsRepo }); } catch {}
        const delay = 3000 + Math.random() * 5000;
        const start = Date.now();
        while (Date.now() - start < delay) {}
      }
    }
    console.log('  [Checkpoint] WARNING: could not push after 5 attempts');
  } catch (e) {
    console.log(`  [Checkpoint] Error: ${e.message}`);
  }
}

module.exports = { loadCandidates, processRecoveredText, checkpoint, REVIEW_TEXTS_DIR };
