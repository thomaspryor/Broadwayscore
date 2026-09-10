#!/usr/bin/env node

/**
 * triage-review-gap.js (BRO-3153)
 *
 * Resolves one show+outlet gap the opening-night monitor thinks is missing
 * to a four-state answer, checking every pipeline stage BEFORE anyone
 * declares 'missed-discovery' and starts URL-resolution work:
 *
 *   1. Does a review-texts file exist for this show+outlet? (local checkout
 *      AND the review-texts data repo's origin/main, in BOTH the show's own
 *      directory and the `_pending/<showId>/` no-byline strand — either repo
 *      can be ahead of the other, and a review can be discovered-but-stuck
 *      in _pending before it ever reaches the show's real directory.)
 *   2. Is it in reviews.json? (local AND the core data repo's origin/main.)
 *   3. Is it in the live prod per-show JSON?
 *
 * Classification (scripts/lib/review-gap-triage.js):
 *   live-on-prod              — fully deployed, nothing to do.
 *   ingested-but-excluded     — a review-texts file exists but a guard
 *                                (wrongProduction, isNonReview, stub, ...)
 *                                blocks it from ever reaching reviews.json.
 *                                Fix the flag, don't hunt for a new URL.
 *   in-pipeline-awaiting-deploy — already ingested and/or scored; just
 *                                hasn't rebuilt/deployed yet. Wait or verify
 *                                the chain, don't re-dispatch discovery.
 *   true-missed-discovery     — genuinely never seen anywhere. Only this
 *                                state justifies URL-resolution work.
 *
 * Every check that can fail short of "confirmed absent" (git ls-tree/show
 * errors, a live-prod fetch that times out or 5xxs) is tracked separately in
 * `unverifiedOriginChecks`/`gitErrors` and printed as a WARNING — a failed
 * check must never look identical to a real negative. That silent-swallow
 * shape is exactly how the real BRO-3153 incident happened.
 *
 * Usage:
 *   node scripts/triage-review-gap.js --show=<show-id> --outlet=<outlet name>
 *   node scripts/triage-review-gap.js --show=<show-id> --outlet=<outlet name> --json
 *
 * Exit codes: 0 = classification produced (any of the 4 states), 2 = usage error.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { normalizeOutlet } = require('./lib/review-normalization');
const { explainExclusion } = require('./lib/review-guards');
const { resolveReviewTextsDir, mainWorktreeOf } = require('./lib/review-texts-dir');
const { classifyGap, justifiesUrlResolution } = require('./lib/review-gap-triage');

// ── Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
const orphans = [];
for (const a of args) {
  const m = a.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
  if (m) {
    flags[m[1]] = m[2] !== undefined ? m[2] : true;
  } else {
    orphans.push(a);
  }
}

// Require an actual STRING value, not just truthy — `--show` with no `=value`
// (a dropped `=`, easy typo) otherwise sets flags.show = true (boolean),
// which passes a bare `!showId` check and crashes later deep inside path.join
// with a TypeError instead of a clean usage error (ship-check review finding).
const showId = typeof flags.show === 'string' && flags.show ? flags.show : null;
const outletName = typeof flags.outlet === 'string' && flags.outlet ? flags.outlet : null;
const asJson = flags.json === true || flags.json === 'true';

if (!showId || !outletName) {
  console.error('Usage: node scripts/triage-review-gap.js --show=SHOW_ID --outlet="Outlet Name" [--json]');
  console.error('Both --show and --outlet require a value.');
  process.exit(2);
}

// An unquoted multi-word outlet (`--outlet=West End Best Friend` instead of
// `--outlet="West End Best Friend"`) splits at shell word boundaries: argv
// becomes ['--outlet=West', 'End', 'Best', 'Friend']. Only "West" would be
// captured as the outlet and the rest silently vanish — reproducing the
// exact incident shape (West End Best Friend truncated to an unmatched
// fragment, misreported as true-missed-discovery) as a caller-side footgun
// instead of a pipeline one (ship-check review finding). Treat leftover
// tokens as a hard usage error rather than dropping them.
if (orphans.length > 0) {
  console.error(`Usage error: unrecognized argument(s): ${orphans.join(' ')}`);
  console.error('This usually means --outlet was not quoted, e.g. use --outlet="West End Best Friend" (with quotes), not --outlet=West End Best Friend.');
  process.exit(2);
}

// ── Root resolution (worktree-safe: gitignored data clones only exist in the main checkout) ──

function candidateRoots() {
  const cwdRoot = process.cwd();
  const roots = [cwdRoot];
  const main = mainWorktreeOf(cwdRoot);
  if (main && path.resolve(main) !== path.resolve(cwdRoot)) roots.push(main);
  return roots;
}

function readJsonFromFirstRoot(relPath) {
  for (const root of candidateRoots()) {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
    } catch {
      // try next candidate root
    }
  }
  return null;
}

function coreDataRepoRoot() {
  return process.env.BSC_DATA_REPO || path.join(os.homedir(), 'broadway-scorecard-data');
}

// reviews.json on origin/main runs 20,000+ reviews / tens of MB — execFileSync's
// default 1MB maxBuffer throws ENOBUFS on it. A caller that swallows that error
// silently reports "not found", the exact false-negative this tool exists to
// prevent (confirmed against the live BRO-3153 case during development: the
// review WAS on origin/main and this bug reported it absent). Errors are
// returned, not swallowed, so callers can surface them instead of guessing.
const GIT_MAX_BUFFER = 1024 * 1024 * 512;
const GIT_TIMEOUT_MS = 15000;

// A stale local remote-tracking ref is indistinguishable from "not pushed
// yet" unless we refresh it first (ship-check adversarial review finding).
// Best-effort: a failed fetch degrades to whatever the local ref already has
// rather than blocking the whole tool, but the caller is told so it can
// treat the verdict as provisional.
function gitFetchOriginMain(cwd) {
  try {
    execFileSync('git', ['fetch', 'origin', 'main', '--quiet'],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

function gitShow(cwd, ref) {
  try {
    return { ok: true, out: execFileSync('git', ['show', ref], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

// Ls-tree failure (missing clone, missing ref, lock contention) must not
// collapse to the same empty-array shape as "confirmed no files here" — a
// caller that can't tell the two apart reports true-missed-discovery on a
// broken check (ship-check adversarial review finding).
function gitLsTreeRecursive(cwd, ref, pathspec) {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', pathspec],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, entries: out.split('\n').filter(Boolean) };
  } catch (e) {
    return { ok: false, entries: [], err: e.message };
  }
}

function toReviewList(doc) {
  if (!doc) return [];
  return Array.isArray(doc) ? doc : (doc.reviews || []);
}

// ── Stage 1: review-texts file (local + data-repo origin/main, show dir + _pending) ──

function localMatchesInDir(dir, outletId) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().startsWith(`${outletId}--`) && f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

function originMatchesUnderPrefix(entries, prefix, outletId) {
  return entries.filter((entry) => {
    if (!entry.startsWith(prefix)) return false;
    const rest = entry.slice(prefix.length);
    // must be a direct child (no further '/'), not a deeper nested path
    return !rest.includes('/') && rest.toLowerCase().startsWith(`${outletId}--`) && rest.endsWith('.json');
  });
}

function loadFile(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Finds every review-texts file that could plausibly be THIS outlet's review
 * for THIS show — local + origin/main, show dir + _pending strand — rather
 * than the first match found (ship-check adversarial review finding: a
 * single excluded/duplicate file must not mask a second, valid file for the
 * same outlet — filename collisions across critics on one outlet do happen).
 */
function findReviewTextFiles(outletId, showId) {
  const reviewTextsDir = resolveReviewTextsDir();
  const showDir = path.join(reviewTextsDir, showId);
  const pendingDir = path.join(reviewTextsDir, '_pending', showId);

  const localFiles = [
    ...localMatchesInDir(showDir, outletId).map((p) => ({ path: p, data: loadFile(p), pending: false })),
    ...localMatchesInDir(pendingDir, outletId).map((p) => ({ path: p, data: loadFile(p), pending: true })),
  ];

  const fetchResult = gitFetchOriginMain(reviewTextsDir);

  const showTree = gitLsTreeRecursive(reviewTextsDir, 'origin/main', `${showId}/`);
  const pendingTree = gitLsTreeRecursive(reviewTextsDir, 'origin/main', `_pending/${showId}/`);
  const treeErrors = [showTree.err, pendingTree.err].filter(Boolean);

  const originCandidates = [
    ...originMatchesUnderPrefix(showTree.entries, `${showId}/`, outletId).map((p) => ({ relPath: p, pending: false })),
    ...originMatchesUnderPrefix(pendingTree.entries, `_pending/${showId}/`, outletId).map((p) => ({ relPath: p, pending: true })),
  ];

  const originFiles = [];
  const readErrors = [];
  for (const cand of originCandidates) {
    const result = gitShow(reviewTextsDir, `origin/main:${cand.relPath}`);
    if (result.ok) {
      let data = null;
      try {
        data = JSON.parse(result.out);
      } catch {
        // origin has a broken/mid-conflict file — treat as present but unreadable
      }
      // Absolute path in the SAME directory the file would occupy locally, even
      // though this particular filename may only exist on origin/main — lets
      // explainExclusion's sibling scans (duplicateOf, syndication) see real
      // local siblings instead of resolving nonsense relative to cwd (ship-check
      // adversarial review finding).
      originFiles.push({ path: path.join(reviewTextsDir, cand.relPath), data, pending: cand.pending });
    } else {
      readErrors.push(result.err);
    }
  }

  // When local and origin/main agree, findOriginFiles resolves to the SAME
  // absolute path as its local counterpart — dedupe so a file already in
  // sync doesn't inflate candidateCount or get exclusion-checked twice.
  const seenPaths = new Set();
  const allFiles = [...localFiles, ...originFiles].filter((f) => {
    if (seenPaths.has(f.path)) return false;
    seenPaths.add(f.path);
    return true;
  });
  const originError = [...treeErrors, ...readErrors].filter(Boolean).join('; ') || null;

  return {
    exists: allFiles.length > 0,
    files: allFiles,
    anyPending: allFiles.some((f) => f.pending),
    originError,
    fetchError: fetchResult.ok ? null : fetchResult.err,
    reviewTextsDir,
  };
}

/**
 * A gap justifies "fix the flag" (ingested-but-excluded) only when EVERY
 * candidate file is excluded — one includable file for the outlet is enough
 * to prove the review is genuinely in the pipeline, regardless of a stray
 * excluded duplicate/twin.
 */
function resolveExclusion(files, showRecord) {
  if (files.length === 0) return null;
  let firstRule = null;
  for (const f of files) {
    if (!f.data) continue; // unreadable file — neither proves includable nor excluded
    const rule = explainExclusion(f.data, showRecord, f.path);
    if (!rule) return null; // an includable file exists — that wins
    if (!firstRule) firstRule = rule;
  }
  return firstRule;
}

// ── Stage 2: reviews.json (local + core-data-repo origin/main) ─────────────

function checkReviewsJson(showId, outletId) {
  const local = readJsonFromFirstRoot(path.join('data', 'reviews.json'));
  const inLocal = toReviewList(local).some((r) => r.showId === showId && r.outletId === outletId);

  const dataRepoRoot = coreDataRepoRoot();
  const fetchResult = gitFetchOriginMain(dataRepoRoot);
  const originResult = gitShow(dataRepoRoot, 'origin/main:reviews.json');
  let origin = null;
  let originError = null;
  if (originResult.ok) {
    try {
      origin = JSON.parse(originResult.out);
    } catch (e) {
      originError = `origin/main:reviews.json parsed but invalid JSON: ${e.message}`;
    }
  } else {
    originError = originResult.err;
  }
  const inOrigin = toReviewList(origin).some((r) => r.showId === showId && r.outletId === outletId);

  return {
    inLocal,
    inOrigin,
    inEither: inLocal || inOrigin,
    originError,
    fetchError: fetchResult.ok ? null : fetchResult.err,
  };
}

// ── Stage 3: live prod ───────────────────────────────────────────────────

async function fetchLiveShowJson(showId) {
  const url = `https://broadwayscorecard.com/data/shows/${showId}.json`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: ac.signal });
    clearTimeout(timer);
    if (res.status === 404) {
      // A confirmed, meaningful signal: the show itself has never deployed at
      // all, not a transient failure — distinct from a timeout/5xx where we
      // genuinely could not check (ship-check adversarial review finding).
      return { ok: true, checked: true, json: null, showNotDeployed: true };
    }
    if (!res.ok) return { ok: false, checked: false, err: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, checked: true, json };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, checked: false, err: err.name === 'AbortError' ? 'timeout (8s)' : String(err) };
  }
}

// The live per-show JSON only ever carries an outlet DISPLAY name (`o`), not
// an outletId — generate-mobile-show-details.js never emits one. Re-deriving
// an id via normalizeOutlet is the same canonical function every write path
// (filenames, reviews.json) already uses, so it's the best available signal,
// but a display-name collision in outlet-registry.json's alias map (a bare
// `Map.set`, last-write-wins) or an unregistered outlet falling through to
// the bare-slug fallback could in principle mismatch. No existing consumer
// does this same round-trip today (ship-check review finding) — flagged here
// rather than "fixed" because there's no better signal in the payload to use.
function checkLiveProd(json, outletId) {
  if (!json || !Array.isArray(json.rv)) return false;
  return json.rv.some((r) => normalizeOutlet(r.o || '') === outletId);
}

// ── Main ─────────────────────────────────────────────────────────────────

(async () => {
  const outletId = normalizeOutlet(outletName);

  const show = readJsonFromFirstRoot(path.join('data', 'shows.json'));
  const showRecord = Array.isArray(show)
    ? show.find((s) => s.id === showId)
    : (show && (show.shows || []).find((s) => s.id === showId));

  const reviewText = findReviewTextFiles(outletId, showId);
  const reviewsJson = checkReviewsJson(showId, outletId);
  const live = await fetchLiveShowJson(showId);
  const inLiveProd = live.checked ? checkLiveProd(live.json, outletId) : false;

  const exclusionRule = resolveExclusion(reviewText.files, showRecord);

  const state = classifyGap({
    reviewTextsExists: reviewText.exists,
    exclusionRule,
    inReviewsJson: reviewsJson.inEither,
    inLiveProd,
  });

  // A check that could not be completed (git error, live-prod timeout/5xx)
  // must never look identical to a confirmed negative — that silent-swallow
  // shape is what let the real BRO-3153 incident report a review as missing
  // that origin/main already had. A live-prod 404 is NOT an unverified check
  // — it's a confirmed "show never deployed" signal.
  const gitErrors = [reviewText.originError, reviewsJson.originError].filter(Boolean);
  const fetchWarnings = [reviewText.fetchError, reviewsJson.fetchError]
    .filter(Boolean)
    .map((e) => `origin/main ref may be stale (fetch failed: ${e})`);
  if (!live.checked) gitErrors.push(`live prod check failed: ${live.err}`);
  const unverifiedOriginChecks = gitErrors.length > 0;

  const result = {
    showId,
    outlet: outletName,
    outletId,
    state,
    justifiesUrlResolution: justifiesUrlResolution(state),
    unverifiedOriginChecks,
    gitErrors,
    fetchWarnings,
    signals: {
      reviewTexts: {
        existsLocal: reviewText.files.some((f) => f.path.startsWith(reviewText.reviewTextsDir) && !f.path.includes('origin')),
        candidateCount: reviewText.files.length,
        anyPendingByline: reviewText.anyPending,
        paths: reviewText.files.map((f) => f.path),
        exclusionRule,
        originCheckError: reviewText.originError,
      },
      reviewsJson: {
        inLocal: reviewsJson.inLocal,
        inOriginMain: reviewsJson.inOrigin,
        originCheckError: reviewsJson.originError,
      },
      liveProd: {
        checked: live.checked,
        showNotDeployed: !!live.showNotDeployed,
        fetchError: live.checked ? null : live.err,
        present: inLiveProd,
      },
    },
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(state);
    console.log(`  show:    ${showId}`);
    console.log(`  outlet:  ${outletName} (outletId: ${outletId})`);
    console.log(`  review-texts: ${reviewText.files.length} candidate file(s)${reviewText.anyPending ? ' [includes _pending no-byline strand — run replay-pending-bylines.js]' : ''}${exclusionRule ? ` [EXCLUDED: ${exclusionRule}]` : ''}${reviewText.originError ? ` [origin/main check FAILED: ${reviewText.originError}]` : ''}`);
    console.log(`  reviews.json: local=${reviewsJson.inLocal} origin/main=${reviewsJson.inOrigin}${reviewsJson.originError ? ` [origin/main check FAILED: ${reviewsJson.originError}]` : ''}`);
    console.log(`  live prod:    ${live.checked ? (live.showNotDeployed ? 'show not deployed at all (404)' : `present=${inLiveProd}`) : `unchecked (${live.err})`}`);
    for (const w of fetchWarnings) console.log(`  WARNING: ${w}`);
    if (gitErrors.length > 0) {
      console.log(`  WARNING: ${gitErrors.length} check(s) could not be completed — this classification may be understating pipeline progress. Do not treat '${state}' as final until these are resolved.`);
    }
    console.log(`  => ${justifiesUrlResolution(state) ? 'URL-resolution work is justified.' : 'Do NOT start URL-resolution work.'}`);
  }

  process.exit(0);
})();
