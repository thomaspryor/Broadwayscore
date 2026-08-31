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
 * // venue-write-guard-ok: the `venue:` field on each report row is copied
 * straight into report.json for human review, never back into shows.json.
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
const { isPrematureReviewForUnopenedShow, hasValidScore, explainExclusion } = require('./lib/review-guards');
const { classifyPriorRunCandidate, classifyReadmissionRisk } = require('./lib/prior-run-triage');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');

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

// Files whose exclusion reasons could not be evaluated (predicate threw).
// Surfaced loudly: an unevaluated file is not a safe file.
let unknownCount = 0;
const unknownSamples = [];

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
  if (!fs.existsSync(dir)) return { reviews: [], unreadableCount: 0, scannedCount: 0 };
  const out = [];
  let unreadableCount = 0;
  let scannedCount = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    scannedCount++;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      unreadableCount++; // unreadable file — not evidence either way, but worth surfacing
      continue;
    }
    if (!isPrematureReviewForUnopenedShow(data, show)) continue;
    if (!hasValidScore(data)) continue;
    // Readmission risk: the temporal gate expires when the show opens, so ask
    // the canonical predicate what excludes this file NOW vs what would exclude
    // it once status flips. filePath is mandatory — explainExclusion returns
    // 'duplicateOf' for every file when it is omitted.
    const fp = path.join(dir, file);
    // Flip ONLY the status. Deliberately does NOT fabricate previews/opening
    // dates for an undated show: several downstream guards derive a production
    // YEAR from those fields, so a synthetic "today" would answer a different
    // question than "what happens when this show opens" (it would answer "what
    // happens if it opened today"). Leaving them absent keeps the simulation to
    // the one variable that actually expires — the temporal gate itself.
    const openedShow = { ...show, status: 'open' };
    // undefined (not null) means "could not evaluate" — see classifyReadmissionRisk.
    let beforeReason;
    let afterReason;
    try {
      beforeReason = explainExclusion(data, show, fp);
      afterReason = explainExclusion(data, openedShow, fp);
    } catch (err) {
      // A predicate throw (missing registry, unreadable duplicate target) must
      // not sink the whole sweep, but it must not read as "safe" either: the
      // reasons stay undefined and the row is classified 'unknown'.
      unknownCount++;
      unknownSamples.push(`${show.id}/${file}: ${err && err.message}`);
    }
    out.push({
      readmissionRisk: classifyReadmissionRisk({ beforeReason, afterReason }),
      beforeReason,
      afterReason,
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
  return { reviews: out, unreadableCount, scannedCount };
}

function main() {
  const shows = loadShows();
  const reviewTextsDir = resolveReviewTextsDir();
  if (!fs.existsSync(reviewTextsDir)) {
    console.error(`[triage-unopened-shows] review-texts dir not found: ${reviewTextsDir}`);
    process.exit(1);
  }

  console.log(`[triage-unopened-shows] review-texts dir: ${reviewTextsDir}`);

  const candidates = ONLY_SHOW ? shows.filter(s => s.id === ONLY_SHOW) : shows;
  const results = [];
  let totalUnreadable = 0;
  let totalScanned = 0;

  for (const show of candidates) {
    const status = String(show.status || '').toLowerCase();
    if (!UNOPENED_STATUSES.has(status)) continue;
    if (hasDeclaredPriorRuns(show)) continue;

    const { reviews, unreadableCount, scannedCount } = collectPrematureScoredReviews(show, reviewTextsDir);
    totalUnreadable += unreadableCount;
    totalScanned += scannedCount;
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
        readmissionRisk: r.readmissionRisk,
        beforeReason: r.beforeReason,
        afterReason: r.afterReason,
        outletId: r.outletId,
        criticName: r.criticName,
        publishDate: r.publishDate,
        url: r.url,
        wrongProduction: r.wrongProduction,
        wrongShow: r.wrongShow,
      })),
    });
  }

  // FAIL LOUD on a vacuous sweep. review-texts is a private-repo checkout that
  // can be missing/empty in CI or a worktree; reporting "readmission risk: none"
  // in that state is worse than no check at all, because it goes quiet exactly
  // when it can see nothing. Only gate the full sweep — a --show=ID run
  // legitimately scans one directory.
  assertCorpusScanned(totalScanned, { gate: !ONLY_SHOW, label: reviewTextsDir });

  const byVerdict = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  const totalFiles = results.reduce((sum, r) => sum + r.stats.count, 0);
  // Files the expiring temporal gate is the ONLY thing holding out. These are
  // the opening-night landmines: each readmits into the live score the moment
  // the show's status flips. Advisory, not a hard gate — explainExclusion is a
  // strong diagnostic mirror of the rebuild's rules, not the audit of record
  // (see its docstring), so a false positive must not be able to red main.
  const readmissionRisks = [];
  const unevaluated = [];
  for (const r of results) {
    for (const rv of r.reviews) {
      if (rv.readmissionRisk === 'readmits-on-open') {
        readmissionRisks.push({ showId: r.showId, file: rv.file, publishDate: rv.publishDate, outletId: rv.outletId });
      } else if (rv.readmissionRisk === 'unknown') {
        unevaluated.push({ showId: r.showId, file: rv.file });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    linearIssue: 'BRO-80',
    scannedShows: candidates.length,
    flaggedShows: results.length,
    flaggedFiles: totalFiles,
    readmissionRiskFiles: readmissionRisks.length,
    readmissionRisks,
    unevaluatedFiles: unevaluated.length,
    unevaluated,
    unreadableFiles: totalUnreadable,
    byVerdict,
    shows: results.sort((a, b) => b.stats.count - a.stats.count),
  };

  console.log(`[triage-unopened-shows] ${results.length} shows / ${totalFiles} files carrying gate-excluded scored reviews`);
  console.log(`[triage-unopened-shows] by verdict: ${JSON.stringify(byVerdict)}`);
  if (totalUnreadable > 0) {
    console.log(`[triage-unopened-shows] WARNING: ${totalUnreadable} review-text files failed to parse and were skipped (not counted as evidence either way)`);
  }
  for (const r of report.shows) {
    console.log(`  ${r.verdict.padEnd(24)} ${r.showId} (${r.stats.count} files, venue=${r.venue || 'TBA'})`);
  }

  if (readmissionRisks.length > 0) {
    // "would", not "will": explainExclusion mirrors the rebuild's rules but is
    // explicitly NOT the audit of record (see its docstring), so each hit is a
    // candidate to confirm against the rebuild, not a settled fact.
    console.log(`\n[triage-unopened-shows] READMISSION RISK: ${readmissionRisks.length} review(s) appear to be held out ONLY by the expiring pre-opening gate and would re-enter scoring when their show opens:`);
    for (const x of readmissionRisks) console.log(`  ! ${x.showId} | ${x.file} | pub=${x.publishDate}`);
    console.log('[triage-unopened-shows] Confirm against the rebuild, then fix each: declare show.priorRuns if it is a genuine earlier run, else set wrongProduction + an operator wrongProductionReason.');
  } else {
    console.log('[triage-unopened-shows] readmission risk: none — every gate-excluded review also has a durable exclusion.');
  }

  if (unevaluated.length > 0) {
    console.log(`[triage-unopened-shows] WARNING: ${unevaluated.length} file(s) could NOT be evaluated (exclusion predicate threw) — these are UNKNOWN, not safe:`);
    for (const s of unknownSamples.slice(0, 10)) console.log(`  ? ${s}`);
  }

  if (PRINT_JSON) {
    console.log(JSON.stringify(report, null, 2));
  }

  if (!ONLY_SHOW) {
    fs.mkdirSync(TRIAGE_DIR, { recursive: true });
    const next = JSON.stringify(report, null, 2) + '\n';
    // Skip the write when only generatedAt would change. This report lives in
    // data/audit/triage/, which BOTH data-health-check.yml and
    // rebuild-reviews.yml stage and commit — an unconditional write would mint
    // a no-op commit on every cron run and add avoidable push contention on a
    // directory the merge registry already documents as multi-writer.
    let prevBody = null;
    try {
      const prev = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
      delete prev.generatedAt;
      prevBody = JSON.stringify(prev);
    } catch {
      // No previous report (or unreadable) — fall through and write.
    }
    const nextCompare = { ...report };
    delete nextCompare.generatedAt;
    if (prevBody !== null && prevBody === JSON.stringify(nextCompare)) {
      console.log(`[triage-unopened-shows] unchanged since last run — left ${REPORT_PATH} untouched`);
    } else {
      fs.writeFileSync(REPORT_PATH, next);
      console.log(`[triage-unopened-shows] wrote ${REPORT_PATH}`);
    }
  }
}

try {
  main();
} catch (err) {
  if (err instanceof CorpusNotScannedError) {
    console.error(`[triage-unopened-shows] ${err.message}`);
    process.exit(1);
  }
  throw err;
}
