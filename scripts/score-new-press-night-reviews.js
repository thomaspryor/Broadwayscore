#!/usr/bin/env node
/**
 * score-new-press-night-reviews.js — start scoring for a press-night review
 * the moment it is pushed (BRO-6886).
 *
 * Called by .github/actions/push-review-texts after a successful push, with the
 * list of review-text paths that push carried. For every urgent show (in or
 * near its opening-night window) with a new review that has no usable score,
 * dispatches a show-scoped llm-ensemble-score.yml run (fast_rebuild=true) on
 * the same per-show lane as verify-all-scored.js. Rules:
 * scripts/lib/press-night-scoring-dispatch.js.
 *
 * Advisory: always exits 0. Writes nothing. Never runs inside the scoring
 * workflow itself (its own push would re-dispatch it for a file it failed on).
 *
 * Usage:
 *   node scripts/score-new-press-night-reviews.js --files=<path-list-file> [--dry-run]
 * Env:
 *   GITHUB_TOKEN, REVIEW_TEXTS_TOKEN  dispatch tokens (second is the fallback on 401/403/404)
 *   PRESS_NIGHT_SCORING_DISPATCH_DISABLED=true  kill switch
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `score-new-press-night-reviews.js — dispatch scoring for new unscored press-night reviews.

Usage:
  node scripts/score-new-press-night-reviews.js --files=<path-list-file> [--dry-run]
  node scripts/score-new-press-night-reviews.js --help, -h
`;

const REPO_ROOT = path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(REPO_ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const SCORING_WORKFLOW_NAME = 'LLM Ensemble Score Reviews';
const LANE_REASON = 'verify-all-scored'; // shared lane with the safety net

const log = (m) => console.log(`[score-new-press-night-reviews] ${m}`);

async function listScoringRuns(token) {
  const { fetchGitHubJSON } = require('./lib/gh-api-client.js');
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  const url = `https://api.github.com/repos/${repo}/actions/workflows/llm-ensemble-score.yml/runs?per_page=50`;
  const body = await fetchGitHubJSON(url, { token, caller: 'score-new-press-night-reviews' });
  return (body && body.workflow_runs) || [];
}

async function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const dryRun = args.includes('--dry-run');
  const filesArg = (args.find((a) => a.startsWith('--files=')) || '').slice('--files='.length);

  if (process.env.PRESS_NIGHT_SCORING_DISPATCH_DISABLED === 'true') { log('disabled by kill switch'); return; }
  if (process.env.GITHUB_WORKFLOW === SCORING_WORKFLOW_NAME) { log('inside the scoring workflow; not dispatching itself'); return; }
  if (!filesArg || !fs.existsSync(filesArg)) { log('no changed-file list; nothing to do'); return; }
  if (!fs.existsSync(SHOWS_FILE)) { log('data/shows.json not checked out in this job; skipping'); return; }

  const lib = require('./lib/press-night-scoring-dispatch');
  const changed = lib.parseChangedFiles(fs.readFileSync(filesArg, 'utf8').split('\n'));
  if (changed.length === 0) { log('no review files in this push'); return; }

  const raw = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows || [];
  let evidence = null;
  try { evidence = require('./lib/review-evidence').loadReviewEvidence(); } catch { /* optional */ }
  const { isScoreableSurvivor, hasValidScore, isDispatchActionable } = require('./verify-all-scored.js');

  const selected = lib.selectShowsNeedingScoring({
    changed,
    shows,
    evidence,
    reviewTextsDir: REVIEW_TEXTS_DIR,
    readReview: (showId, file) => {
      try { return JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, showId, file), 'utf8')); } catch { return null; }
    },
    predicates: { isScoreableSurvivor, hasValidScore, isDispatchActionable },
  });
  log(`${changed.length} review file(s) in this push; ${selected.length} urgent show(s) with a new unscored review`);
  if (selected.length === 0) return;
  for (const s of selected) log(`  ${s.showId}: ${s.files.join(', ')}`);

  const tokens = [process.env.GITHUB_TOKEN, process.env.REVIEW_TEXTS_TOKEN].filter(Boolean);
  if (tokens.length === 0) { log('::warning::no GITHUB_TOKEN/REVIEW_TEXTS_TOKEN; cannot dispatch scoring'); return; }

  let runs = [];
  try {
    runs = await listScoringRuns(tokens[0]);
  } catch (e) {
    // Fail open: an extra dispatch is absorbed by the per-show lane.
    log(`::warning::could not list scoring runs (${String(e.message).slice(0, 120)}); dispatching without the waiting-run check`);
  }
  const { dispatch, skipped } = lib.dropShowsWithWaitingRun(selected, runs);
  for (const s of skipped) log(`  ${s.showId}: a scoring run is already waiting to start; it will see this push`);

  const { dispatchRescore } = require('./lib/dispatch-rescore');
  for (const s of dispatch) {
    if (dryRun) { log(`  [dry-run] would dispatch llm-ensemble-score.yml for ${s.showId}`); continue; }
    let result = null;
    for (const token of tokens) {
      result = await dispatchRescore(s.showId, { reason: LANE_REASON, token });
      if (result.ok || !/^(401|403|404)\b/.test(String(result.error || ''))) break;
    }
    if (result && result.ok) log(`  dispatched llm-ensemble-score.yml for ${s.showId}`);
    else log(`::warning::scoring dispatch failed for ${s.showId}: ${result && result.error}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`::warning::score-new-press-night-reviews crashed (advisory): ${err && err.stack ? err.stack : err}`);
  }).finally(() => process.exit(0));
}

module.exports = { main };
