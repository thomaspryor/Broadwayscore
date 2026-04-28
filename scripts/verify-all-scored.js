#!/usr/bin/env node
/**
 * verify-all-scored.js — Gap 1: post-rebuild orphan-unscored guard.
 *
 * For every show currently in the ±N-day opening-night window
 * (status=open AND |today - openingDate| ≤ N days), walks
 * data/review-texts/{show-id}/ and asserts every includable file with
 * substantial text or aggregator excerpt has at least one score in
 * humanReviewScore | adjudicatedScore | originalScore(Normalized) |
 * llmScore.score (1-100). assignedScore is rebuild output and lives in
 * reviews.json — never on per-file JSON.
 *
 * Failures get:
 *   1. data/audit/orphan-unscored-{showId}.json  — broadcast gate marker
 *   2. Discord warning alert (60-min cooldown per show)
 *   3. workflow_dispatch on llm-ensemble-score.yml  (rescore + fast_rebuild)
 *
 * Lost Boys 2026-04-26 #8 (memory/lost-boys-2026-opening-night-postmortem.md):
 * amNY Matt Windman + Exeunt Loren Noveck reached the live page with
 * fullText on disk but no llmScore/assignedScore. The orchestrator's auto-
 * discovery path (BWW Review Roundup, Playbill Verdict, DTLI scrapers)
 * created stub files without always triggering the LLM ensemble. The
 * ensemble has budget caps and contentTier gates that silently skip files;
 * by the time rebuild ran, those files were unscored and never rendered.
 *
 * Defense-in-depth pairing: scripts/collect-review-texts.js now runs a
 * text-only score-extractor pre-pass (Gap 2) that populates originalScore
 * for any review with an extractable rating in fullText. This script
 * catches the residual cases the pre-pass can't recover (no extractable
 * rating, but the LLM ensemble would still have produced a number).
 *
 * CLI:
 *   node scripts/verify-all-scored.js                       # all shows in window
 *   node scripts/verify-all-scored.js --show=<showId>       # single show
 *   node scripts/verify-all-scored.js --window-days=7
 *   node scripts/verify-all-scored.js --dry-run             # no alerts/dispatch/marker writes
 *   node scripts/verify-all-scored.js --force               # bypass per-show cooldown
 *   node scripts/verify-all-scored.js --no-dispatch         # write marker + alert, skip workflow_dispatch
 *
 * Exit codes:
 *   0 — every show in window passes (or no shows in window)
 *   0 — orphans found AND alerts/markers were written successfully
 *       (we DO NOT exit non-zero — that breaks the rebuild pipeline; the
 *        marker file + Discord alert are the signal)
 *   1 — fatal error (shows.json missing, etc.)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { sendAlert } = require('./lib/discord-notify');
// Canonical rebuild-includability gate. Used here instead of a bespoke
// exclusion-flag list so this guard cannot drift away from rebuild's actual
// inclusion logic (Codex 2026-04-27 P0: bespoke predicate would silently miss
// stale-cleared wrongShow files, fullTextWrongAuthor + excerpt cases, etc).
const { isIncludableForRebuild } = require('./lib/review-guards');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const STATE_FILE = path.join(AUDIT_DIR, 'verify-all-scored-state.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const NO_DISPATCH = args.includes('--no-dispatch');
const SHOW_FILTER =
  (args.find((a) => a.startsWith('--show=')) || '').replace('--show=', '') || null;
const WINDOW_DAYS =
  parseInt(
    (args.find((a) => a.startsWith('--window-days=')) || '').replace('--window-days=', ''),
    10,
  ) || 7;
// Minimum body length below which we don't even consider a file scoreable.
// Below this most files lack the signal an extractor or LLM needs.
const MIN_BODY_CHARS = 100;
const COOLDOWN_MS = 60 * 60 * 1000; // 60 min per-show
const PUBLIC_REPO_OWNER = process.env.GITHUB_REPOSITORY?.split('/')?.[0] || 'thomaspryor';
const PUBLIC_REPO_NAME = process.env.GITHUB_REPOSITORY?.split('/')?.[1] || 'Broadwayscore';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isWithinWindow(openingDate, now, windowDays) {
  if (!openingDate) return false;
  const t = new Date(openingDate).getTime();
  if (!Number.isFinite(t)) return false;
  const diff = Math.abs(t - now.getTime());
  return diff <= windowDays * 24 * 60 * 60 * 1000;
}

/**
 * Decide whether a review-text file is "scoreable enough that missing-score is
 * a real bug" by deferring to the canonical `isIncludableForRebuild()` guard.
 * Anything rebuild would include in reviews.json is fair game for the orphan-
 * unscored audit; anything rebuild would exclude is out of scope (because
 * those files don't reach the live page anyway).
 *
 * Why use the canonical helper: rebuild's includability has nuances this
 * audit MUST mirror or it will produce false negatives. wrongShow=true with
 * wrongShowCleared() override is INCLUDED by rebuild — a bespoke "skip if
 * wrongShow=true" predicate misses real orphans. fullTextWrongAuthor +
 * stagedoorExcerpt is INCLUDED. isRoundupArticle stale-flag is INCLUDED.
 * Codex ship-check 2026-04-27 caught the drift on this script's first
 * predicate.
 *
 * The optional `show` argument enables wrongShow's `isLikelyStaleWrongShow`
 * stale-flag override (needs show.openingDate + show.id).
 *
 * Returns { eligible, reason } — `reason` is null when eligible, else a
 * coarse label ('not-includable' or the canonical excluded-by-rebuild bucket
 * if available).
 */
function isScoreableSurvivor(data, show) {
  if (!data || typeof data !== 'object') {
    return { eligible: false, reason: 'not-an-object' };
  }
  if (!isIncludableForRebuild(data, show || {})) {
    return { eligible: false, reason: 'not-includable-by-rebuild' };
  }
  return { eligible: true, reason: null };
}

function isInScoreRange(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 100;
}

/**
 * Does this source-file have a score the rebuild's getBestScore() would
 * return? Check ALL the fields rebuild reads, in precedence order
 * (rebuild-helpers.js getBestScore P0-P3): humanReviewScore, adjudicatedScore,
 * originalScoreNormalized + originalScore, llmScore.score.
 *
 * NOT a check on `data.assignedScore` — that field is the rebuild OUTPUT and
 * lives in reviews.json (the derived file), never in per-file JSON. The
 * 2026-04-27 ship-check found 5 false-positive "orphans" on Beaches because
 * the original predicate checked assignedScore on source files, where it's
 * always undefined regardless of scoring state.
 */
function hasValidScore(data) {
  if (!data || typeof data !== 'object') return false;
  // P0: humanReviewScore. Rebuild's getBestScore (rebuild-helpers.js:345-350)
  // SKIPS the human score when humanReviewScoreProvisional === true — the
  // operator wrote a tentative number but wants the LLM to override once
  // real scoring lands. A file with only a provisional human score and
  // no LLM/extractor signal is NOT scored by rebuild, so we must not
  // count it as scored here. Round-2 Codex P1.
  if (
    isInScoreRange(data.humanReviewScore) &&
    data.humanReviewScoreProvisional !== true
  ) {
    return true;
  }
  // P0a: adjudicatedScore.
  if (isInScoreRange(data.adjudicatedScore)) return true;
  // P0.5: originalScore + originalScoreNormalized. originalScoreNormalized is
  // the canonical 1-100 form; presence of a parseable originalScore string
  // alone is also enough — rebuild's parseOriginalScore() handles strings.
  //
  // Skip when originalScoreCleared===true (rebuild's getBestScore at
  // rebuild-helpers.js:413-430 also skips P0.5 in this case unless the
  // Tier-1.5 override fires). Without this check, a deliberately-cleared
  // score would look "valid" here while rebuild excludes it from P0.5 —
  // false-negative orphan-unscored. Round-2 ship-check P2.
  if (data.originalScoreCleared !== true) {
    if (isInScoreRange(data.originalScoreNormalized)) return true;
    if (typeof data.originalScore === 'string' && data.originalScore.trim().length > 0) {
      return true;
    }
  }
  // P1: llmScore.score (the LLM ensemble result).
  if (data.llmScore && typeof data.llmScore === 'object') {
    if (isInScoreRange(data.llmScore.score)) return true;
  }
  return false;
}

function loadState() {
  const state = loadJSON(STATE_FILE, { version: 1, updatedAt: null, shows: {} });
  if (!state.shows) state.shows = {};
  return state;
}

function saveState(state) {
  // Atomic write — same reasoning as writeMarker. Concurrent rebuild-fast
  // and rebuild-reviews can both call saveState; without atomicity the
  // second writer can produce a half-written JSON that crashes future
  // loads. Round-2 Codex P2 (note: this does NOT eliminate the lost-update
  // race on lastAlertAt — that's bounded-impact and accepted, see comment
  // in main()).
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${STATE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

function markerFilePath(showId) {
  return path.join(AUDIT_DIR, `orphan-unscored-${showId}.json`);
}

function writeMarker(showId, payload) {
  // Atomic write — temp file + rename — so a parallel rebuild-fast and
  // rebuild-reviews invocation can't produce a half-written marker that
  // crashes the broadcast gate's JSON.parse. Same pattern used by every
  // checkpointed batch script in scripts/.
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const final = markerFilePath(showId);
  const tmp = `${final}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmp, final);
}

function clearMarker(showId) {
  const f = markerFilePath(showId);
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {
    // best-effort
  }
}

/**
 * Garbage-collect marker files for shows that aged out of the opening-night
 * window or closed entirely. Without this, a marker written on day N stays
 * in main forever — even after rebuild and the LLM ensemble would have
 * filled the score in. The broadcast gate then trips on stale data the next
 * time the show id reappears in the broadcast pending set (status=open
 * lookback bumps, manual operator dispatch). Codex ship-check 2026-04-27 P0.
 *
 * `seenShowIds` = the set of shows the current run audited. Anything else
 * with a marker is stale.
 */
function gcStaleMarkers(seenShowIds) {
  let files;
  try {
    files = fs.readdirSync(AUDIT_DIR).filter((f) => /^orphan-unscored-.+\.json$/.test(f));
  } catch {
    return [];
  }
  const removed = [];
  for (const f of files) {
    const showId = f.replace(/^orphan-unscored-/, '').replace(/\.json$/, '');
    if (seenShowIds.has(showId)) continue;
    try {
      fs.unlinkSync(path.join(AUDIT_DIR, f));
      removed.push(showId);
    } catch {
      // best-effort
    }
  }
  return removed;
}

async function dispatchRescore(showId) {
  const token = process.env.GITHUB_TOKEN || process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    console.warn('[verify-all-scored] No GITHUB_TOKEN/REVIEW_TEXTS_TOKEN — skipping rescore dispatch');
    return { ok: false, error: 'no-token' };
  }
  const body = {
    ref: 'main',
    inputs: {
      show_id: showId,
      fast_rebuild: 'true',
      run_calibration: 'false',
      run_validation: 'false',
      // Per-show concurrency lane (matches /ingest pattern). Without a
      // per-show suffix every dispatch queues into the same default group.
      rescore_reason: `verify-all-scored-${showId}`,
    },
  };
  try {
    const url = `https://api.github.com/repos/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/llm-ensemble-score.yml/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-verify-all-scored',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `${res.status} ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// ─── Audit a single show ─────────────────────────────────────────────────────

/**
 * Walk a show's review-texts/ directory and return every orphan-unscored file.
 *
 * @param {string} showId
 * @returns {{orphans: Array<{file: string, outletId: string, criticName: string, fullTextLen: number, fileFlags: object}>, totalScanned: number, eligibleScanned: number}}
 */
function auditShow(showId, show) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  let files;
  try {
    files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { orphans: [], totalScanned: 0, eligibleScanned: 0 };
  }

  const orphans = [];
  let eligibleScanned = 0;
  for (const file of files) {
    const filePath = path.join(showDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // Corrupt JSON — flag separately so it surfaces; don't crash the audit.
      orphans.push({
        file,
        outletId: 'unknown',
        criticName: 'unknown',
        fullTextLen: 0,
        fileFlags: { corrupt: true },
      });
      continue;
    }

    const { eligible, reason } = isScoreableSurvivor(data, show);
    if (!eligible) continue;
    eligibleScanned++;

    if (hasValidScore(data)) continue;

    orphans.push({
      file,
      outletId: data.outletId || 'unknown',
      criticName: data.criticName || 'unknown',
      url: data.url || null,
      fullTextLen: typeof data.fullText === 'string' ? data.fullText.length : 0,
      // Source-of-truth score fields (NOT assignedScore — that's rebuild output
      // and lives in reviews.json). Captured for the marker file so the
      // operator can see what's missing at a glance.
      humanReviewScore: data.humanReviewScore ?? null,
      adjudicatedScore: data.adjudicatedScore ?? null,
      originalScore: data.originalScore ?? null,
      originalScoreNormalized: data.originalScoreNormalized ?? null,
      llmScore: data.llmScore?.score ?? null,
      contentTier: data.contentTier ?? null,
      eligibilityReason: reason, // null when eligible
    });
  }

  return { orphans, totalScanned: files.length, eligibleScanned };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();

  const showsDoc = loadJSON(SHOWS_FILE);
  if (!showsDoc) {
    console.error('[verify-all-scored] Could not read shows.json — aborting');
    process.exit(1);
  }
  const shows = showsDoc.shows || showsDoc;

  let targets;
  if (SHOW_FILTER) {
    const show = shows.find((s) => s.id === SHOW_FILTER);
    if (!show) {
      console.error(`[verify-all-scored] --show=${SHOW_FILTER} not in shows.json`);
      process.exit(1);
    }
    targets = [show];
  } else {
    targets = shows.filter(
      (s) => s.status === 'open' && isWithinWindow(s.openingDate, now, WINDOW_DAYS),
    );
  }

  if (targets.length === 0) {
    console.log('[verify-all-scored] No shows in opening-night window — nothing to check.');
    // Empty-window must still GC stale markers — otherwise a marker from a
    // prior in-window run lingers forever and trips the broadcast gate next
    // time that show id re-enters the pending set (status churn, lookback
    // bumps). Round-2 ship-check P1.
    if (!DRY_RUN && !SHOW_FILTER) {
      const removed = gcStaleMarkers(new Set());
      if (removed.length > 0) {
        console.log(`[verify-all-scored] GC'd ${removed.length} stale marker(s) on empty window: ${removed.join(', ')}`);
      }
    }
    process.exit(0);
  }

  console.log(
    `[verify-all-scored] Checking ${targets.length} show(s) in ±${WINDOW_DAYS}d window` +
      (DRY_RUN ? ' [dry-run]' : '') +
      (NO_DISPATCH ? ' [no-dispatch]' : ''),
  );

  const state = loadState();
  const showsWithOrphans = [];
  const allDispatches = [];
  const seenIds = new Set();

  for (const show of targets) {
    seenIds.add(show.id);
    const result = auditShow(show.id, show);
    console.log(
      `  ${show.id}: ${result.totalScanned} files, ${result.eligibleScanned} eligible, ${result.orphans.length} orphan-unscored`,
    );

    if (result.orphans.length === 0) {
      // All clear — clear any stale marker from a prior failed run.
      if (!DRY_RUN) clearMarker(show.id);
      continue;
    }

    showsWithOrphans.push({ show, result });

    const prev = state.shows[show.id];
    const prevAlertAt = prev?.lastAlertAt || null;
    let suppressAlert = false;
    if (!FORCE && prevAlertAt) {
      const sinceMs = now.getTime() - new Date(prevAlertAt).getTime();
      if (sinceMs < COOLDOWN_MS) {
        const minutesLeft = Math.ceil((COOLDOWN_MS - sinceMs) / 60000);
        console.log(
          `    ↳ in cooldown (${minutesLeft}m left) — skipping alert + dispatch (marker still written)`,
        );
        suppressAlert = true;
      }
    }

    let dispatchInfo = null;
    if (!suppressAlert && !NO_DISPATCH && !DRY_RUN) {
      dispatchInfo = await dispatchRescore(show.id);
      allDispatches.push({ showId: show.id, ...dispatchInfo });
      if (dispatchInfo.ok) {
        console.log(`    ↳ dispatched llm-ensemble-score.yml for ${show.id}`);
      } else {
        console.warn(
          `    ↳ rescore dispatch failed for ${show.id}: ${dispatchInfo.error}`,
        );
      }
    }

    // Build marker AFTER dispatch so it accurately records what happened.
    // The broadcast gate reads `lastDispatch` to print an honest error
    // message: "rescore in flight" only when dispatch.ok was true.
    const markerPayload = {
      version: 1,
      showId: show.id,
      openingDate: show.openingDate || null,
      detectedAt: now.toISOString(),
      windowDays: WINDOW_DAYS,
      orphans: result.orphans,
      orphanCount: result.orphans.length,
      // Broadcast gate reads this file and refuses to send while orphans
      // exist on any pending show. See opening-night-broadcast.yml.
      blockBroadcast: true,
      // Honest report of what verify-all-scored did this run. Possible values:
      //   'ok'         — workflow_dispatch succeeded; rescore is queued
      //   'failed:...' — dispatch attempted but errored
      //   'suppressed-cooldown' — within 60-min cooldown, no dispatch
      //   'suppressed-no-dispatch-flag' — --no-dispatch CLI flag
      //   'dry-run'    — --dry-run; no real action taken
      lastDispatch: suppressAlert
        ? 'suppressed-cooldown'
        : NO_DISPATCH
          ? 'suppressed-no-dispatch-flag'
          : DRY_RUN
            ? 'dry-run'
            : dispatchInfo && dispatchInfo.ok
              ? 'ok'
              : `failed:${dispatchInfo ? dispatchInfo.error : 'unknown'}`,
      lastDispatchAt: dispatchInfo && dispatchInfo.ok ? now.toISOString() : null,
    };

    if (!DRY_RUN) {
      writeMarker(show.id, markerPayload);
    }

    state.shows[show.id] = {
      openingDate: show.openingDate || null,
      lastOrphanCount: result.orphans.length,
      lastSeenAt: now.toISOString(),
      lastAlertAt: suppressAlert
        ? prevAlertAt
        : DRY_RUN
          ? prevAlertAt
          : now.toISOString(),
    };

    if (suppressAlert) continue;
  }

  // Garbage-collect snapshots for shows no longer in window.
  if (!SHOW_FILTER) {
    for (const id of Object.keys(state.shows)) {
      if (!seenIds.has(id)) delete state.shows[id];
    }
  }

  // GC marker files for shows that aged out of the window. Without this, a
  // marker file from a prior run that's no longer in pending lingers in main
  // forever — and trips the broadcast gate the next time that show id
  // re-enters the pending set (lookback bumps, manual operator dispatch).
  // Codex ship-check 2026-04-27 P0. Only run when no --show filter so we
  // don't accidentally clear unrelated shows' markers.
  if (!DRY_RUN && !SHOW_FILTER) {
    const removed = gcStaleMarkers(seenIds);
    if (removed.length > 0) {
      console.log(`[verify-all-scored] GC'd ${removed.length} stale marker(s): ${removed.join(', ')}`);
    }
  }

  // Concurrency note (Codex round-2 P2): rebuild-fast and rebuild-reviews
  // can run simultaneously and both call saveState. The atomic rename
  // prevents corrupt JSON, but the read-decide-write is still a lost-update
  // race on `lastAlertAt`. Worst case: cooldown timestamp gets rolled back
  // to an older run's value, allowing a duplicate Discord alert one rebuild
  // cycle later. Duplicate dispatch is harmless (per-show concurrency lane
  // in llm-ensemble-score.yml serializes them). Accepted, not fixed —
  // proper resolution would require a workflow-level concurrency group on
  // the verify-all-scored step or a CAS-style lock helper.
  if (!DRY_RUN) saveState(state);

  if (showsWithOrphans.length === 0) {
    console.log('[verify-all-scored] All eligible reviews scored across all shows in window.');
    process.exit(0);
  }

  // Aggregate Discord alert.
  const fields = showsWithOrphans.map(({ show, result }) => {
    const sample = result.orphans
      .slice(0, 5)
      .map((o) => `${o.outletId}/${o.criticName} (${o.fullTextLen}c)`)
      .join('\n');
    return {
      name: `${show.title || show.id} — ${result.orphans.length} orphan${result.orphans.length === 1 ? '' : 's'}`,
      value: `${sample}${result.orphans.length > 5 ? `\n…and ${result.orphans.length - 5} more` : ''}`,
      inline: false,
    };
  });

  const description =
    `${showsWithOrphans.length} show(s) in the ±${WINDOW_DAYS}d opening-night window have ` +
    `review files with includable text but no assignedScore. Marker files written to ` +
    `data/audit/orphan-unscored-{showId}.json — broadcast will be blocked until the LLM ensemble fills these in.`;

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would send Discord alert:');
    console.log('Title: Orphan-Unscored Reviews — Opening-Night Window');
    console.log('Description:', description);
    for (const f of fields) {
      console.log(`\n— ${f.name} —`);
      console.log(f.value);
    }
  } else if (process.env.DISCORD_WEBHOOK_ALERTS) {
    const ok = await sendAlert({
      title: `Orphan-Unscored Reviews — ${showsWithOrphans.length} show(s)`,
      description,
      severity: 'warning',
      fields,
      url: `https://github.com/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions`,
    });
    console.log(`[verify-all-scored] Discord alert dispatch: ${ok ? 'sent' : 'FAILED'}`);
  } else {
    console.warn('[verify-all-scored] DISCORD_WEBHOOK_ALERTS not set — skipping Discord alert');
  }

  // We DO NOT exit non-zero. The rebuild pipeline calls this with
  // continue-on-error: true anyway, but exiting 0 keeps the workflow log
  // clean and avoids tripping naive `if: failure()` gates downstream. The
  // marker file + Discord alert are the actionable signals.
  console.log(
    `[verify-all-scored] Wrote ${showsWithOrphans.length} marker file(s); dispatched ${allDispatches.filter((d) => d.ok).length}/${allDispatches.length} rescore(s).`,
  );
  process.exit(0);
}

// ─── Exports for testing ─────────────────────────────────────────────────────

module.exports = {
  isScoreableSurvivor,
  hasValidScore,
  isWithinWindow,
  auditShow,
  markerFilePath,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('[verify-all-scored] Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
