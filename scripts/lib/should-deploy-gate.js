#!/usr/bin/env node
'use strict';

/**
 * Content-aware should-deploy gate for vercel-deploy.yml.
 *
 * Decides whether a deploy trigger should actually build, by comparing what is
 * LIVE on Vercel (latest READY production deployment, via check-prod-deploy.js
 * --json — the 2026-06-26 lesson: GitHub run conclusions are not proof of
 * deployment) against main HEAD, restricted to paths that affect built site
 * output. ~93% of main commits are bookkeeping (health stamps, audit logs,
 * watermarks) that rebuild an identical site; before this gate that meant
 * ~139 production builds/day and ISR-write + origin-transfer + build-CPU
 * charges dominating the Vercel bill (2026-07 cost analysis).
 *
 * Skip rules (scheduled ticks only — the gate ONLY skips on positive proof):
 *   - baseline known AND baseline == HEAD AND data unchanged  → skip (no-new-commits)
 *   - baseline known AND site+data diff empty AND deploy <6h  → skip (content-gate)
 * EVERYTHING else proceeds: unknown baseline, Vercel API failure, git fetch or
 * diff failure, deploy older than 6h (staleness backstop), any non-schedule
 * event (workflow_dispatch / workflow_run keep their "ship now" semantics,
 * deduped only when HEAD is already live AND core data hasn't advanced).
 * A wrongly-run build costs cents; a wrongly-skipped deploy is silent staleness.
 *
 * Core-data awareness (BRO-3149): reviews.json/shows.json live in the private
 * broadway-scorecard-data repo and are pulled into data/ at BUILD time — they
 * never appear in this repo's git tree, so the SITE_PATHS diff above is BLIND
 * to a core-data-only change (e.g. a scored opening-night review landing via
 * Rebuild Reviews (Fast)). Before this fix that blind spot rode the 6h
 * staleness backstop every time — confirmed incident: a scored review landed
 * 2026-09-10, the very next 5-min tick SKIPped (content-gate), prod stayed
 * stale until a manual FORCE-DEPLOY. Fix: the Deploy step stamps the git blob
 * SHA of data/reviews.json AND data/shows.json (as pulled for THAT build) onto
 * the Vercel deployment via `vercel deploy --meta reviewsBlobSha=... --meta
 * showsBlobSha=...` — both files, not just reviews.json, so a shows.json-only
 * change (e.g. a status flip) isn't a second blind spot. This gate reads that
 * back from the live deployment (check-prod-deploy.js's `reviewsBlobSha`/
 * `showsBlobSha`) and compares it to the CURRENT blob SHAs of those files in
 * the private repo (two GitHub Contents API calls, run in parallel — `sha` is
 * returned for files of any size, even when `content` is omitted past the
 * 1MB inline-content cutoff; verified live that this equals `git hash-object`
 * on the same bytes). Deliberately NOT a full core-data checkout in this job
 * (which stays ~15s by design) and NOT a separate throttled watermark file —
 * the baseline updates atomically with each real deployment, so (unlike an
 * async/throttled record) it can't re-trigger a redundant deploy on the ticks
 * immediately following a real one.
 *
 * Known residual (accepted tradeoff, not fixed here): rebuild-all-reviews.js
 * unconditionally stamps a fresh `_meta.lastUpdated` on every run, so the
 * blob hash — and therefore this gate's `dataDiffResult` — changes even when
 * no review/show CONTENT actually changed. That costs at most one redundant
 * deploy per rebuild cycle (rebuild-fast's own 4h safety-net cron, at worst),
 * consistent with this file's existing bias ("a wrongly-run build costs
 * cents; a wrongly-skipped deploy is silent staleness") — filtering the
 * volatile field out would require downloading full file content on the gate
 * side (defeating the no-clone, ~15s design goal for a 17MB+ file).
 *
 * Kill switch: repo variable DEPLOY_GATE_DISABLED=true (passed as GATE_DISABLED)
 * forces proceed on every trigger — the 2am phone-operable escape hatch.
 *
 * Env (set by the workflow; overridable for tests):
 *   VERCEL_TOKEN         required for the live baseline lookup
 *   REVIEW_TEXTS_TOKEN   required for the core-data blob SHA lookup (private repo)
 *   GATE_EVENT_NAME      github.event_name (schedule | workflow_dispatch | workflow_run)
 *   GATE_DISABLED        'true' → kill switch
 *   GATE_HEAD_SHA        override HEAD (default: git rev-parse HEAD)
 *   GATE_BASELINE_JSON   test seam: JSON {deployedSha, ageSec, reviewsBlobSha,
 *                         showsBlobSha} — skips the API call
 *   GATE_DATA_SHA_JSON   test seam: JSON {reviewsSha, showsSha} — skips the
 *                         GitHub Contents API calls
 *   GITHUB_OUTPUT        when set, proceed=/reason= are appended there
 *
 * The deploy job's fast-vs-full prebuild step ("Check if data changed",
 * vercel-deploy.yml) keeps its own narrower data-path regex — different
 * question (HOW to build, not WHETHER); see cross-reference comment there.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Tracked public-repo paths that shape the built site. public/data/** is
// regenerated by rebuild workflows and committed here, so review/score updates
// are caught by this list. data/* core files (shows.json, reviews.json, …) are
// NOT tracked in this repo (private core-data checkout at build time) — the 6h
// staleness backstop covers changes that only land there. scripts/ is included
// because prebuild scripts shape build output (over-triggers on scraper-only
// commits; err toward deploying).
const SITE_PATHS = [
  'src/',
  'public/',
  'content/',
  'scripts/',
  'next.config.js',
  'tailwind.config.ts',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
  'vercel.json',
  '.vercelignore',
];

const STALENESS_BACKSTOP_SEC = 6 * 3600;

// git diff --quiet exit codes: 0 = no diff, 1 = diff, anything else = error.
function classifyDiffExit(code) {
  if (code === 0) return 'clean';
  if (code === 1) return 'dirty';
  return 'error';
}

/**
 * Pure decision function — the only place skip/proceed logic lives.
 * @param {object} i
 * @param {string} i.eventName     schedule | workflow_dispatch | workflow_run
 * @param {boolean} i.gateDisabled kill switch
 * @param {string|null} i.baselineSha  live READY prod deployment SHA (null = unknown)
 * @param {number|null} i.deployAgeSec age of that deployment (null = unknown)
 * @param {string} i.headSha
 * @param {'clean'|'dirty'|'error'|null} i.diffResult site-path diff vs baseline
 * @param {'clean'|'dirty'|'error'|null} i.dataDiffResult core-data (reviews.json)
 *   blob-SHA diff vs the SHA stamped on the live deployment — see BRO-3149
 *   header comment. null/'error' (lookup unavailable) never forces a skip or
 *   a proceed on its own; it just falls through to the site-path signal.
 * @returns {{proceed: boolean, reason: string}}
 */
function decide({ eventName, gateDisabled, baselineSha, deployAgeSec, headSha, diffResult, dataDiffResult }) {
  if (gateDisabled) return { proceed: true, reason: 'kill-switch' };

  if (eventName !== 'schedule') {
    // Explicit ship intent — dedup only when this exact SHA is verifiably live
    // (strictly less skip-prone than the old gh-run-list dedup, which skipped
    // against SHAs of runs that never deployed) AND core data hasn't advanced
    // past what that live deployment shipped (BRO-3149 — a rebuild that
    // changed ONLY private core-data without moving public HEAD used to dedup
    // here even though a redeploy would ship fresher data).
    if (baselineSha && baselineSha === headSha) {
      if (dataDiffResult === 'dirty') return { proceed: true, reason: 'data-changed' };
      return { proceed: false, reason: 'already-live' };
    }
    return { proceed: true, reason: 'explicit-ship' };
  }

  if (!baselineSha) return { proceed: true, reason: 'no-baseline-fail-open' };
  if (baselineSha === headSha) {
    if (dataDiffResult === 'dirty') return { proceed: true, reason: 'data-changed' };
    // dataDiffResult is 'clean'/'error'/null here. A positively-clean data
    // signal is a genuine no-op — skip immediately (matches pre-BRO-3149
    // behavior for this branch, which had no second signal at all). An
    // UNKNOWN data signal (error/null — e.g. a transient API failure or a
    // missing token) must NOT silently swallow the staleness backstop: an
    // idle public repo (baselineSha === headSha can persist for a while in a
    // quiet window) combined with a persistently-broken data lookup would
    // otherwise strand core-data staleness indefinitely, since this branch
    // used to return before the age check ever ran (Codex adversarial
    // review, BRO-3149). Still requires deployAgeSec to be known and past
    // the backstop — an unknown age alone doesn't force a proceed here,
    // consistent with the "positive proof only" skip philosophy in the
    // header comment.
    if (dataDiffResult !== 'clean' && deployAgeSec != null && deployAgeSec > STALENESS_BACKSTOP_SEC) {
      return { proceed: true, reason: 'staleness-backstop' };
    }
    return { proceed: false, reason: 'no-new-commits' };
  }
  if (deployAgeSec == null) return { proceed: true, reason: 'no-age-fail-open' };
  if (deployAgeSec > STALENESS_BACKSTOP_SEC) return { proceed: true, reason: 'staleness-backstop' };
  if (diffResult === 'dirty') return { proceed: true, reason: 'content-changed' };
  if (dataDiffResult === 'dirty') return { proceed: true, reason: 'data-changed' };
  if (diffResult === 'clean') return { proceed: false, reason: 'content-gate' };
  return { proceed: true, reason: 'diff-error-fail-open' };
}

// --- I/O below; decide() above stays pure for the colocated test ---

function getBaseline() {
  if (process.env.GATE_BASELINE_JSON) {
    try {
      const j = JSON.parse(process.env.GATE_BASELINE_JSON);
      return {
        sha: j.deployedSha || null,
        ageSec: j.ageSec != null ? j.ageSec : null,
        reviewsBlobSha: j.reviewsBlobSha || null,
        showsBlobSha: j.showsBlobSha || null,
      };
    } catch {
      return { sha: null, ageSec: null, reviewsBlobSha: null, showsBlobSha: null };
    }
  }
  try {
    const out = execFileSync(
      'node',
      [path.join(__dirname, '..', 'check-prod-deploy.js'), '--json'],
      { encoding: 'utf8', timeout: 30000 }
    );
    const j = JSON.parse(out);
    return {
      sha: j.deployedSha || null,
      ageSec: j.ageSec != null ? j.ageSec : null,
      reviewsBlobSha: j.reviewsBlobSha || null,
      showsBlobSha: j.showsBlobSha || null,
    };
  } catch (e) {
    console.log(`::warning::[content-gate] baseline lookup failed (${e.message.split('\n')[0]}) — failing open`);
    return { sha: null, ageSec: null, reviewsBlobSha: null, showsBlobSha: null };
  }
}

// The private core-data repo's blob SHAs for reviews.json + shows.json,
// straight from GitHub's Contents API — no clone needed. GitHub returns
// `sha` (the git blob object hash) for a file of any size even though
// `content` is omitted above the 1MB inline-content cutoff (reviews.json is
// ~17MB); verified live that this exactly equals `git hash-object` on the
// same bytes, which is what the Deploy step stamps onto the Vercel
// deployment (see header comment). Both files are tracked — not reviews.json
// alone — so a shows.json-only change (e.g. a status flip) isn't a second
// blind spot (Codex adversarial review, BRO-3149).
const DATA_REPO = 'thomaspryor/broadway-scorecard-data';
const DATA_TRACKED_FILES = ['reviews.json', 'shows.json'];

async function fetchBlobSha(filePath, token) {
  const res = await fetch(
    `https://api.github.com/repos/${DATA_REPO}/contents/${filePath}?ref=main`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${filePath}`);
  const j = await res.json();
  return j.sha || null;
}

async function getDataBlobShas() {
  if (process.env.GATE_DATA_SHA_JSON) {
    try {
      const j = JSON.parse(process.env.GATE_DATA_SHA_JSON);
      return { reviewsSha: j.reviewsSha || null, showsSha: j.showsSha || null };
    } catch {
      return { reviewsSha: null, showsSha: null };
    }
  }
  const token = process.env.REVIEW_TEXTS_TOKEN;
  if (!token) return { reviewsSha: null, showsSha: null };
  try {
    const [reviewsSha, showsSha] = await Promise.all(
      DATA_TRACKED_FILES.map((f) => fetchBlobSha(f, token))
    );
    return { reviewsSha, showsSha };
  } catch (e) {
    console.log(`::warning::[content-gate] data blob sha lookup failed (${e.message}) — failing open`);
    return { reviewsSha: null, showsSha: null };
  }
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts });
}

function runDiff(baselineSha, headSha) {
  try {
    git(['fetch', '--depth=1', 'origin', baselineSha], { stdio: 'ignore', timeout: 60000 });
  } catch {
    return { result: 'error', files: [] };
  }
  let code = 0;
  try {
    git(['diff', '--quiet', '--no-renames', baselineSha, headSha, '--', ...SITE_PATHS], { stdio: 'ignore' });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 128;
  }
  const result = classifyDiffExit(code);
  let files = [];
  if (result === 'dirty') {
    try {
      files = git(['diff', '--name-only', '--no-renames', baselineSha, headSha, '--', ...SITE_PATHS])
        .trim().split('\n').filter(Boolean).slice(0, 20);
    } catch { /* listing is best-effort */ }
  }
  return { result, files };
}

function writeOutput(proceed, reason) {
  const lines = `proceed=${proceed}\nreason=${reason}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

async function main() {
  const eventName = process.env.GATE_EVENT_NAME || 'schedule';
  const gateDisabled = process.env.GATE_DISABLED === 'true';
  const headSha = process.env.GATE_HEAD_SHA || git(['rev-parse', 'HEAD']).trim();

  const baseline = gateDisabled
    ? { sha: null, ageSec: null, reviewsBlobSha: null, showsBlobSha: null }
    : getBaseline();

  // Only run the (fetch + diff) when the decision can actually depend on it.
  let diff = { result: null, files: [] };
  if (
    !gateDisabled &&
    eventName === 'schedule' &&
    baseline.sha && baseline.sha !== headSha &&
    baseline.ageSec != null && baseline.ageSec <= STALENESS_BACKSTOP_SEC
  ) {
    diff = runDiff(baseline.sha, headSha);
  }

  // Core-data blob-SHA lookup is two cheap API calls (no clone), so unlike
  // the site diff above it's not worth narrowing to the schedule-only window —
  // the non-schedule 'already-live' dedup branch needs it too (see decide()).
  // 'dirty' if EITHER tracked file's blob SHA differs from the live baseline.
  let dataDiffResult = null;
  if (!gateDisabled) {
    const { reviewsSha, showsSha } = await getDataBlobShas();
    const knownNow = [reviewsSha, showsSha].filter(Boolean).length;
    const knownBaseline = [baseline.reviewsBlobSha, baseline.showsBlobSha].filter(Boolean).length;
    if (knownNow === DATA_TRACKED_FILES.length && knownBaseline === DATA_TRACKED_FILES.length) {
      dataDiffResult =
        reviewsSha !== baseline.reviewsBlobSha || showsSha !== baseline.showsBlobSha ? 'dirty' : 'clean';
    } else if (knownNow > 0 || knownBaseline > 0) {
      dataDiffResult = 'error'; // partial/ambiguous lookup — don't force either way
    }
  }

  const { proceed, reason } = decide({
    eventName,
    gateDisabled,
    baselineSha: baseline.sha,
    deployAgeSec: baseline.ageSec,
    headSha,
    diffResult: diff.result,
    dataDiffResult,
  });

  const short = (s) => (s ? s.slice(0, 10) : 'unknown');
  const verb = proceed ? 'DEPLOY' : 'SKIP';
  console.log(
    `::notice::[content-gate] ${verb} — reason=${reason} baseline=${short(baseline.sha)} head=${short(headSha)} deployAge=${baseline.ageSec != null ? Math.round(baseline.ageSec / 60) + 'm' : 'unknown'} event=${eventName} dataDiff=${dataDiffResult || 'unknown'}`
  );
  if (diff.files.length) console.log(`::notice::[content-gate] changed site files (first ${diff.files.length}): ${diff.files.join(', ')}`);

  writeOutput(proceed, reason);
}

module.exports = { decide, classifyDiffExit, SITE_PATHS, STALENESS_BACKSTOP_SEC };

if (require.main === module) {
  main().catch((e) => {
    console.error(`::error::[content-gate] gate crashed: ${e.stack || e.message}`);
    process.exit(1);
  });
}
