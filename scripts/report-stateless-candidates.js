#!/usr/bin/env node
'use strict';

/**
 * report-stateless-candidates.js — Coverage Verdict S2 (task #906), scope item 4.
 *
 * WARN-ONLY CI report: for every recently-opened show in
 * data/audit/show-review-gap.json, does each review URL the audit knows about
 * carry exactly one candidate state? Anything without a state is printed (and
 * annotated with ::warning:: under GitHub Actions).
 *
 * ALWAYS EXITS 0. The plan forbids a hard fail until the report has run clean
 * for two weeks AND the failure sits behind the kill switch, so there is no
 * strict mode here at all — adding the exit code later is a deliberate,
 * reviewable change rather than a flag someone can flip early.
 *
 * Fail-open on every axis: missing/unreadable audit file, malformed JSON, a
 * pre-#906 file with no verdicts, or COVERAGE_GATE_DISABLED set → prints why
 * and exits 0. Never touches the network, never writes anything.
 *
 * Usage:
 *   node scripts/report-stateless-candidates.js [--window=30] [--json] [--file=path]
 */
const fs = require('fs');
const path = require('path');
const { reportStatelessCandidates, DEFAULT_WINDOW_DAYS } = require('./lib/stateless-candidates');
const { coverageGateDisabled } = require('./lib/coverage-gate');

const ROOT = path.join(__dirname, '..');
const DEFAULT_AUDIT_FILE = path.join(ROOT, 'data', 'audit', 'show-review-gap.json');

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function main() {
  const asJson = process.argv.includes('--json');
  const windowDays = Number(argValue('window', DEFAULT_WINDOW_DAYS));
  const file = argValue('file', DEFAULT_AUDIT_FILE);
  const inActions = !!process.env.GITHUB_ACTIONS;

  if (coverageGateDisabled()) {
    console.log('COVERAGE_GATE_DISABLED — stateless-candidate report skipped (no-op).');
    return;
  }

  let audit = null;
  try {
    audit = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.log(`⚠ ${path.relative(ROOT, file)} unreadable (${err.message}) — report skipped (fail-open).`);
    return;
  }

  const report = reportStatelessCandidates(audit.results, {
    now: new Date().toISOString(),
    windowDays: Number.isFinite(windowDays) ? windowDays : DEFAULT_WINDOW_DAYS,
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Stateless-candidate report (warn-only) — window ${report.windowDays}d, ${report.examined} recently-opened show(s) examined`);
  if (report.noVerdict.length) {
    // Informational: a verdict appears only after the audit re-runs. Pre-#906
    // rows legitimately have none.
    console.log(`  ℹ ${report.noVerdict.length} in-window show(s) have no censusVerdict yet: ${report.noVerdict.map((s) => s.showId).join(', ')}`);
  }
  if (report.unknownDate.length) {
    console.log(`  ℹ ${report.unknownDate.length} show(s) skipped — no parseable openingDate (unknown-date, not a finding)`);
  }

  if (!report.findings.length) {
    console.log('  ✓ every known review URL on every in-window show carries a candidate state');
    return;
  }

  for (const f of report.findings) {
    const bits = [];
    if (f.statelessUrls.length) bits.push(`${f.statelessUrls.length} URL(s) with no state`);
    if (f.statelessOutlets.length) bits.push(`${f.statelessOutlets.length} cited outlet(s) with no state`);
    if (f.unknownStates.length) bits.push(`${f.unknownStates.length} candidate(s) with an unrecognized state`);
    const line = `${f.showId} (opened ${f.openingDate}, verdict=${f.verdict}, ${f.statedCount}/${f.knownCount} stated): ${bits.join(', ')}`;
    console.log(`  • ${line}`);
    for (const u of f.statelessUrls.slice(0, 5)) console.log(`      no state: ${u}`);
    for (const o of f.statelessOutlets.slice(0, 5)) console.log(`      no state (cited, no URL): ${o}`);
    for (const u of f.unknownStates.slice(0, 5)) console.log(`      unrecognized state ${JSON.stringify(u.state)}: ${u.url || u.outletId}`);
    if (inActions) console.log(`::warning title=Stateless coverage candidates::${line}`);
  }
  console.log(`  ${report.totals.shows} show(s), ${report.totals.statelessUrls} stateless URL(s), ${report.totals.statelessOutlets} stateless cited outlet(s), ${report.totals.unknownStates} unrecognized state(s) — advisory only, exit 0`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // Even an unexpected crash must not fail the job this runs in.
    console.log(`⚠ stateless-candidate report crashed (${err.message}) — advisory only, exit 0`);
  }
}

module.exports = { main };
