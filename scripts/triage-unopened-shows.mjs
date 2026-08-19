#!/usr/bin/env node
/**
 * triage-unopened-shows.mjs — BRO-80
 *
 * The pre-opening temporal gate (review-guards.js isPrematureReviewForUnopenedShow,
 * added 2026-07-21) excludes reviews published long before a never-opened show's
 * own previews/opening window. That gate is right for aggregator contamination
 * (a title-matched review of a DIFFERENT production) but wrong for a genuine
 * EARLIER RUN of the SAME production whose shows.json entry hasn't declared
 * priorRuns yet — those reviews are legitimate and belong back in scoring once
 * priorRuns is declared.
 *
 * This script finds every never-opened show (status announced/upcoming/previews,
 * no priorRuns declared) that is currently carrying scored reviews the gate is
 * excluding, and classifies each show as:
 *   - likely-single-prior-run  — reviews cluster in one window; a human should
 *     confirm the real opening/closing dates and declare show.priorRuns
 *   - likely-contamination     — majority already independently flagged
 *     wrongProduction/wrongShow; the gate is corroborating a known-bad file
 *   - needs-human-review       — ambiguous (multiple year-clusters, wide span)
 *
 * This is a READ-ONLY report generator. It never writes to shows.json or any
 * review-text file — declaring priorRuns needs a human (or a follow-up script)
 * to confirm real dates/venue via Playbill/IBDB per CLAUDE.md §3.
 *
 * Usage:
 *   node scripts/triage-unopened-shows.mjs                 # full sweep, writes report
 *   node scripts/triage-unopened-shows.mjs --show=ID        # single show, prints only
 *   node scripts/triage-unopened-shows.mjs --json           # print full JSON to stdout too
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { isPrematureReviewForUnopenedShow, hasValidScore } = require('./lib/review-guards');
const { classifyPriorRunCandidate } = require('./lib/prior-run-triage');

const args = process.argv.slice(2);
const showArg = args.find(a => a.startsWith('--show='));
const ONLY_SHOW = showArg ? showArg.slice('--show='.length) : null;
const PRINT_JSON = args.includes('--json');

const DATA_ROOT = process.env.BSC_DATA_ROOT || path.join(process.cwd());
const DATA_DIR = path.join(DATA_ROOT, 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const TRIAGE_DIR = path.join(AUDIT_DIR, 'triage');
const REPORT_PATH = path.join(TRIAGE_DIR, 'unopened-shows-prior-runs.json');

const UNOPENED_STATUSES = new Set(['announced', 'upcoming', 'previews']);

function hasDeclaredPriorRuns(show) {
  return Array.isArray(show.priorRuns)
    && show.priorRuns.some(r => r && (r.openingDate || r.closingDate || r.previewsStartDate));
}

function loadShows() {
  const showsPath = path.join(DATA_DIR, 'shows.json');
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}

function collectPrematureScoredReviews(show, reviewTextsDir) {
  const dir = path.join(reviewTextsDir, show.id);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // unreadable file — not evidence either way
    }
    if (!isPrematureReviewForUnopenedShow(data, show)) continue;
    if (!hasValidScore(data)) continue;
    out.push({
      file,
      outletId: data.outletId,
      criticName: data.criticName,
      publishDate: data.publishDate,
      url: data.url,
      wrongProduction: data.wrongProduction === true,
      wrongShow: data.wrongShow === true,
      fullText: data.fullText,
    });
  }
  return out;
}

function main() {
  const shows = loadShows();
  const reviewTextsDir = resolveReviewTextsDir();
  if (!fs.existsSync(reviewTextsDir)) {
    console.error(`[triage-unopened-shows] review-texts dir not found: ${reviewTextsDir}`);
    process.exit(1);
  }

  const candidates = ONLY_SHOW ? shows.filter(s => s.id === ONLY_SHOW) : shows;
  const results = [];

  for (const show of candidates) {
    const status = String(show.status || '').toLowerCase();
    if (!UNOPENED_STATUSES.has(status)) continue;
    if (hasDeclaredPriorRuns(show)) continue;

    const reviews = collectPrematureScoredReviews(show, reviewTextsDir);
    if (reviews.length === 0) continue;

    const classification = classifyPriorRunCandidate(show, reviews);
    results.push({
      showId: show.id,
      title: show.title,
      market: show.market,
      status: show.status,
      venue: show.venue,
      previewsStartDate: show.previewsStartDate || null,
      openingDate: show.openingDate || null,
      verdict: classification.verdict,
      reasoning: classification.reasoning,
      stats: classification.stats,
      suggestedPriorRun: classification.suggestedPriorRun,
      reviews: reviews.map(r => ({
        file: r.file,
        outletId: r.outletId,
        criticName: r.criticName,
        publishDate: r.publishDate,
        url: r.url,
        wrongProduction: r.wrongProduction,
        wrongShow: r.wrongShow,
      })),
    });
  }

  const byVerdict = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  const totalFiles = results.reduce((sum, r) => sum + r.stats.count, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    linearIssue: 'BRO-80',
    scannedShows: candidates.length,
    flaggedShows: results.length,
    flaggedFiles: totalFiles,
    byVerdict,
    shows: results.sort((a, b) => b.stats.count - a.stats.count),
  };

  console.log(`[triage-unopened-shows] ${results.length} shows / ${totalFiles} files carrying gate-excluded scored reviews`);
  console.log(`[triage-unopened-shows] by verdict: ${JSON.stringify(byVerdict)}`);
  for (const r of report.shows) {
    console.log(`  ${r.verdict.padEnd(24)} ${r.showId} (${r.stats.count} files, venue=${r.venue || 'TBA'})`);
  }

  if (PRINT_JSON) {
    console.log(JSON.stringify(report, null, 2));
  }

  if (!ONLY_SHOW) {
    fs.mkdirSync(TRIAGE_DIR, { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
    console.log(`[triage-unopened-shows] wrote ${REPORT_PATH}`);
  }
}

main();
