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
const { isVanishedReviewFile } = require('./gap-recovery-ledger');
const path = require('path');

const { recoverReviewText } = require('./gap-acceptance');
const { withReviewTextsLock } = require('./review-texts-lock');
const { checkpointReviewTexts, retryPendingPushes, createWriteTracker, logRenameOutcomes } = require('./review-texts-checkpoint');

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
function loadCandidates({ filePrefix, showsAllowlist, maxUrls = Infinity, includePending = false }) {
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
    if (dir.startsWith('_') || dir.startsWith('.')) continue; // _pending is scanned below, never as a show
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
        showId: dir,
        existingChars: (data.fullText || '').length,
        contentTier: data.contentTier || 'unknown',
      });
    }
  }
  if (includePending) candidates.push(...loadPendingCandidates({ prefixes, showsAllowlist }));
  candidates.sort((a, b) => {
    const ya = (a.showId.match(/-(\d{4})$/) || [])[1] || '0';
    const yb = (b.showId.match(/-(\d{4})$/) || [])[1] || '0';
    return yb.localeCompare(ya);
  });

  return candidates.slice(0, maxUrls);
}

/**
 * BRO-8195: a paywalled _pending stub the paid scraper cannot read (the drain settles it as
 * subscriber-fetch-failed, pending-triage.js) only ever reaches a review through the logged-in
 * browser. Eligible: a subscriber outlet with a url, either settled by that reason or still open.
 * Any other settle (junk, duplicate, identity reject) stays settled. Pure.
 */
function pendingSubscriberStubEligible(data) {
  const { SUBSCRIBER_OUTLETS } = require('./pending-triage');
  if (!data || !data.url || !SUBSCRIBER_OUTLETS.has(data.outletId)) return false;
  if (data.duplicateOf || data.rssIdentityRejected) return false;
  const settled = String(data.promoteSkippedReason || '');
  return !settled || settled.startsWith('subscriber-fetch-failed');
}

/**
 * BRO-8195: the logged-in browser did not reach the article: it was redirected to a home or section page
 * (an old WaPo story url lands on the homepage, whose feature module carries a food writer's byline the drain
 * then promoted), or it read almost no text. The drain trusts the url's slug for identity, so it must never
 * see such a page. Pure. Returns the reason or null.
 */
const PENDING_MIN_ARTICLE_CHARS = 500;
function pendingBrowserMissReason({ finalUrl, textLen }) {
  if (finalUrl) {
    let segs = null;
    try { segs = new URL(finalUrl).pathname.split('/').filter(Boolean); } catch { /* unparseable: judged on text alone */ }
    if (segs && segs.length <= 1) return `redirected off the article to ${finalUrl}`;
  }
  if (Number.isFinite(textLen) && textLen < PENDING_MIN_ARTICLE_CHARS) return `only ${textLen} chars of article text`;
  return null;
}

function loadPendingCandidates({ prefixes, showsAllowlist }) {
  const root = path.join(REVIEW_TEXTS_DIR, '_pending');
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const dir of dirs) {
    if (showsAllowlist && !showsAllowlist.has(dir)) continue;
    let files;
    try { files = fs.readdirSync(path.join(root, dir)); } catch { continue; }
    for (const f of files) {
      if (!prefixes.some((p) => f.startsWith(`${p}--`)) || !f.endsWith('.json')) continue;
      const filePath = path.join(root, dir, f);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      if (!pendingSubscriberStubEligible(data)) continue;
      out.push({
        reviewId: `_pending/${dir}/${f}`, filePath, url: data.url, showId: dir, file: f, pending: true,
        existingChars: (data.fullText || '').length, contentTier: 'pending',
      });
    }
  }
  return out;
}

/** The rehomed copy of a vanished stub: same file name (or name--hash) under another _pending show, rehomedFrom this show. */
function findRehomedCopy(candidate) {
  const root = path.join(REVIEW_TEXTS_DIR, '_pending');
  const stem = candidate.file.replace(/\.json$/, '');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    if (d === candidate.showId) continue;
    let files;
    try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) {
      if (f !== candidate.file && !(f.startsWith(`${stem}--`) && f.endsWith('.json'))) continue;
      try { const j = JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8')); if (j.rehomedFrom === candidate.showId && j.url === candidate.url) return path.join(root, d, f); } catch { /* unreadable: not ours */ }
    }
  }
  return null;
}

/**
 * BRO-8195: promote a _pending subscriber stub from the logged-in page's own html. The drain
 * (replay-pending-bylines.js processShow) does every check it does for a paid fetch (identity,
 * window, byline, same-critic collision); only its fetch is swapped for the html already read.
 * A subscriber-fetch-failed settle is re-opened first (the drain skips settled stubs). When the
 * drain still leaves the stub open, it settles with a typed reason so it stops counting as open;
 * clearing promoteSkippedReason re-opens it.
 * @returns {Promise<{outcome: 'promoted'|'settled'|'kept'|'vanished', detail?: string}>}
 */
async function processPendingCandidate(candidate, html, opts = {}) {
  const { safeWriteReview } = require('./review-write-guard');
  const drain = opts.processShow || require('../replay-pending-bylines').processShow;
  const tracker = opts.tracker || RUN_WRITES;
  const dry = !!opts.dryRun;
  const read = () => { try { return JSON.parse(fs.readFileSync(candidate.filePath, 'utf8')); } catch { return null; } };
  const before = read();
  if (!before) return { outcome: 'vanished' };
  if (!pendingSubscriberStubEligible(before) || before.url !== candidate.url) return { outcome: 'kept', detail: 'stub changed since listing' };
  const miss = pendingBrowserMissReason({ finalUrl: opts.finalUrl, textLen: opts.textLen });
  if (miss && opts.probe) {
    // A lost login or an access wall is never evidence about the article (BRO-7171): re-probe the session first.
    let p = null;
    try { p = await opts.probe(); } catch (e) { p = { error: e.message }; }
    if (!p || p.error || !p.text || (p.len || 0) < (opts.minAuthChars || PENDING_MIN_ARTICLE_CHARS)) {
      return { outcome: 'session-lost', detail: `${miss}; session probe failed (${(p && p.error) || `${(p && p.len) || 0} chars`})` };
    }
  }
  if (miss) {
    if (dry) return { outcome: 'settled', detail: `${miss} (dry run)` };
    withReviewTextsLock(`settle:${candidate.file}`, () => {
      const d = read();
      if (!d) return;
      d.promoteSkippedReason = `subscriber-browser-no-article: the logged-in browser ${miss}; the url no longer serves the review, clear to retry (BRO-8195)`;
      d.promoteSkippedAt = new Date().toISOString();
      safeWriteReview(candidate.filePath, d);
    });
    tracker.add(path.resolve(candidate.filePath));
    return { outcome: 'settled', detail: miss };
  }
  if (before.promoteSkippedReason && !dry) {
    withReviewTextsLock(`reopen:${candidate.file}`, () => {
      const d = read();
      if (!d) return;
      d.reopenedFromSkip = d.promoteSkippedReason;
      d.promoteSkippedReason = null; d.promoteSkippedAt = null; // null, not delete: the write guard merges absent keys back
      d.pendingFetchFailures = 0;
      safeWriteReview(candidate.filePath, d);
    });
  }
  const showDir = path.join(REVIEW_TEXTS_DIR, candidate.showId);
  const listShow = () => { try { return new Set(fs.readdirSync(showDir)); } catch { return new Set(); } };
  const had = listShow();
  if (!dry) tracker.add(path.resolve(candidate.filePath)); // a drain that throws after the reopen still lands the reopen
  const res = await drain(candidate.showId, {
    files: [candidate.file], dryRun: dry, explicitScope: false, // never an owner alert from this path: the stub settles with a typed reason below
    fetch: async (u) => (u === candidate.url ? { content: html, success: true, method: 'subscriber-browser' } : null),
    ...(opts.drainDeps || {}),
  });
  if (dry) return { outcome: res.promoted ? 'promoted' : 'kept', detail: 'dry run' };
  tracker.add(path.resolve(candidate.filePath));
  const added = [...listShow()].filter((f) => !had.has(f));
  for (const f of added) tracker.add(path.resolve(path.join(showDir, f)));
  if (res.promoted) return { outcome: 'promoted', detail: added.join(', ') };
  const after = read();
  if (!after) {
    // Rehomed (rehomeStubFile writes _pending/<sibling>/<file or file--hash>): the copy must land with the deletion.
    const moved = findRehomedCopy(candidate);
    if (moved) { tracker.add(path.resolve(moved)); return { outcome: 'settled', detail: `rehomed to ${path.relative(REVIEW_TEXTS_DIR, moved)}` }; }
    return { outcome: 'settled', detail: 'stub removed by the drain (redundant copy)' };
  }
  if (after.promoteSkippedReason || after.rssIdentityRejected) return { outcome: 'settled', detail: String(after.promoteSkippedReason || 'rss identity') };
  withReviewTextsLock(`settle:${candidate.file}`, () => {
    const d = read();
    if (!d || d.promoteSkippedReason) return;
    d.promoteSkippedReason = `subscriber-browser-read-no-promote: the logged-in page was read and the drain still could not promote it (${d.pendingFetchAttemptResult || 'kept'}); clear to retry (BRO-8195)`;
    d.promoteSkippedAt = new Date().toISOString();
    safeWriteReview(candidate.filePath, d);
  });
  return { outcome: 'settled', detail: 'logged-in read, drain kept it' };
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
  let r;
  try {
  r = recoverReviewText({
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
  } catch (e) {
    // Renamed/removed by another writer mid-run: skip it, not a run-ending fault (BRO-7171).
    if (!isVanishedReviewFile(e, candidate.filePath)) throw e;
    return { ok: false, code: 'file_vanished', reason: `${path.basename(candidate.filePath)} was renamed or removed by another writer`, newLen: 0 };
  }
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
  let vanished = false;
  withReviewTextsLock(`stamp:${path.basename(candidate.filePath)}`, () => {
    let data;
    try { data = readReviewForUpdate(candidate.filePath); } catch (e) {
      if (!isVanishedReviewFile(e, candidate.filePath)) throw e;
      vanished = true;
      return;
    }
    Object.assign(data, fields);
    persistReviewSnapshot({ filePath: candidate.filePath, data, trailingNewline: true });
  });
  if (vanished) return;
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
    logRenameOutcomes(r, '    ');
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
  logRenameOutcomes(res, '  [Checkpoint] ');
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

module.exports = { loadCandidates, pendingSubscriberStubEligible, pendingBrowserMissReason, processPendingCandidate, processRecoveredText, stampDead, startRun, checkpoint, acquireRecoveryRunLock, RUN_WRITES, REVIEW_TEXTS_DIR };
