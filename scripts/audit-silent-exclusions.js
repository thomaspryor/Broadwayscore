#!/usr/bin/env node
/**
 * audit-silent-exclusions.js
 *
 * CLI for the two silent-exclusion detectors added by task #1188:
 *
 *   (a) OUTLET DOMAIN MOVES — an unregistered host in
 *       data/audit/unknown-aggregator-outlets.json that derives the same
 *       identity slug as an outlet registered under a DIFFERENT domain. That
 *       is the shape of one-minute-critic's move to 1minutecritic.substack.com,
 *       which silently dropped every review on the new host behind a routine
 *       `domain-mismatch` skip until it was found by hand.
 *
 *   (b) MISSING contentTier — a review with real text, a real byline, no
 *       rejection flags, and no contentTier: a file that fell out of the
 *       classification path entirely, which nothing anywhere reported.
 *
 * Decision logic lives in scripts/lib/silent-exclusion-detectors.js (pure,
 * unit-tested) and is shared verbatim with the daily health check, so the CLI
 * and the digest can never disagree about what counts as a finding.
 *
 * BASELINE MODEL: same posture as audit-star-score-mismatch.js. A time window
 * is the wrong filter — these defects are found long after they land — so the
 * known/triaged backlog is baselined in data/audit/silent-exclusions-baseline
 * .json and the health check alerts only on findings NOT in it.
 *
 * USAGE:
 *   node scripts/audit-silent-exclusions.js                  # NEW findings; exit 1 if any
 *   node scripts/audit-silent-exclusions.js --all            # everything, ignore baseline (exit 0)
 *   node scripts/audit-silent-exclusions.js --write-baseline # ack the current backlog
 *   node scripts/audit-silent-exclusions.js --json           # machine-readable
 *   node scripts/audit-silent-exclusions.js --show=<id>      # (b) for one show
 *
 * EXIT CODES: 0 = no new findings (or --all / --write-baseline). 1 = new
 * findings. 2 = usage/error, including a vacuous scan (task #1065): a corpus
 * walk that saw ZERO files is a broken checkout, not a clean corpus, and must
 * never be reported as a pass.
 */

const fs = require('fs');
const path = require('path');
const {
  scanMissingContentTier,
  missingTierKey,
  detectOutletDomainMoves,
  domainMoveKey,
} = require('./lib/silent-exclusion-detectors');

const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
const UNKNOWN_HOSTS_PATH = path.join(ROOT, 'data', 'audit', 'unknown-aggregator-outlets.json');
const BASELINE_PATH = path.join(ROOT, 'data', 'audit', 'silent-exclusions-baseline.json');
const REPORT_PATH = path.join(ROOT, 'data', 'audit', 'silent-exclusions.json');

function parseArgs(argv) {
  const args = { all: false, json: false, writeBaseline: false, show: null, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--all') args.all = true;
    else if (a === '--json') args.json = true;
    else if (a === '--write-baseline') args.writeBaseline = true;
    else if (a.startsWith('--show=')) args.show = a.slice(7);
  }
  return args;
}

function usage() {
  console.log(`audit-silent-exclusions.js — detect two silent-exclusion classes with no other detector.

  (default)          list NEW findings (not in the baseline); exit 1 if any
  --all              everything, ignore the baseline (audit mode; always exit 0)
  --write-baseline   snapshot ALL current findings into the baseline (after triage)
  --show=<id>        restrict the contentTier scan to a single show directory
  --json             machine-readable output
  -h, --help         this help

Reads:  data/outlet-registry.json, data/audit/unknown-aggregator-outlets.json, data/review-texts/
Writes: ${path.relative(ROOT, REPORT_PATH)} (and the baseline with --write-baseline)`);
}

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // --help must not write anything (task #534 class).
  if (args.help) { usage(); process.exit(0); }

  const baselineFile = readJSON(BASELINE_PATH, {}) || {};
  const useBaseline = !args.all && !args.writeBaseline;
  const tierBaseline = useBaseline ? (baselineFile.missingContentTier || []) : [];
  const moveBaseline = useBaseline ? (baselineFile.outletDomainMoves || []) : [];

  // ── (a) outlet domain moves ──────────────────────────────────────────────
  const registry = readJSON(REGISTRY_PATH);
  const unknown = readJSON(UNKNOWN_HOSTS_PATH);
  if (!registry || !registry.outlets) {
    console.error(`ERROR: cannot read outlet registry at ${REGISTRY_PATH}`);
    process.exit(2);
  }
  const moves = detectOutletDomainMoves({
    outlets: registry.outlets,
    unknownHosts: (unknown && unknown.outlets) || [],
    baselineKeys: moveBaseline,
  });

  // ── (b) missing contentTier ──────────────────────────────────────────────
  // review-texts is a private repo (CLAUDE.md §11) and is legitimately absent
  // on some checkouts. Absent = skipped and SAID SO. Present but empty = a
  // broken checkout, which is an error, not a pass (task #1065).
  let tier = null;
  const reviewTextsPresent = fs.existsSync(REVIEW_TEXTS_DIR);
  if (reviewTextsPresent) {
    // The canonical inclusion predicate needs each review's show record —
    // without it four of explainExclusion's rules go dark and the scan
    // over-reports. See scripts/lib/silent-exclusion-detectors.js.
    const showsById = {};
    const showsFile = readJSON(path.join(ROOT, 'data', 'shows.json'));
    for (const s of (showsFile?.shows || [])) if (s?.id) showsById[s.id] = s;
    tier = scanMissingContentTier(REVIEW_TEXTS_DIR, {
      shows: args.show ? [args.show] : undefined,
      baselineKeys: tierBaseline,
      showsById,
    });
  }

  if (args.writeBaseline) {
    const payload = {
      generatedAt: new Date().toISOString(),
      note: 'Acked backlog for scripts/audit-silent-exclusions.js. Findings NOT listed here alert in the daily health check.',
      outletDomainMoves: moves.findings.map(domainMoveKey),
      missingContentTier: tier ? tier.findings.map(missingTierKey) : (baselineFile.missingContentTier || []),
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Baseline written: ${payload.outletDomainMoves.length} domain move(s), ${payload.missingContentTier.length} missing-tier finding(s)`);
    console.log(path.relative(ROOT, BASELINE_PATH));
    process.exit(0);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    outletDomainMoves: {
      scannedHosts: moves.scanned,
      domainlessMatches: moves.domainlessMatches,
      baselinedCount: moves.baselinedCount,
      findings: moves.findings,
    },
    missingContentTier: tier
      ? {
        scannedFiles: tier.scanned,
        baselinedCount: tier.baselinedCount,
        predicateErrors: tier.predicateErrors,
        firstPredicateError: tier.firstPredicateError,
        findings: tier.findings,
      }
      : { skipped: 'review-texts not checked out (private repo)' },
  };
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('=== (a) Probable outlet domain moves ===');
    console.log(`Scanned ${moves.scanned} unregistered host(s); ${moves.domainlessMatches} matched a domainless outlet (separate class, not reported); ${moves.baselinedCount} baselined.`);
    if (moves.findings.length === 0) {
      console.log('No probable domain moves.');
    } else {
      for (const f of moves.findings) {
        console.log(`  ${f.host} → outlet "${f.outletId}" (registered: ${f.registeredDomain}) — ${f.occurrences} occurrence(s)`);
        if (f.sampleUrl) console.log(`      e.g. ${f.sampleUrl}`);
      }
      console.log('\nFix: if the host really is that outlet, add it to the outlet\'s domainAliases in data/outlet-registry.json.');
      console.log('Otherwise register it as its own outlet, or ack with --write-baseline.');
    }

    console.log('\n=== (b) Reviews with text + byline + no contentTier ===');
    if (!tier) {
      console.log('Skipped — data/review-texts not checked out (private repo).');
    } else {
      console.log(`Scanned ${tier.scanned} file(s); ${tier.baselinedCount} baselined.`);
      if (tier.predicateErrors) {
        // Loud, because a predicate that threw decided nothing — "no findings"
        // off the back of it would be a false all-clear.
        console.log(`  ⚠ inclusion check FAILED on ${tier.predicateErrors} file(s) — those were not judged at all.`);
        console.log(`    first: ${tier.firstPredicateError}`);
        console.log('    Usually a missing data/shows.json in this checkout.');
      }
      if (tier.findings.length === 0) {
        console.log('No unclassified reviews.');
      } else {
        for (const f of tier.findings) {
          console.log(`  ${f.showId}/${f.file} — ${f.criticName} (${f.outletId}), ${f.chars} chars, scored: ${f.hasScore}`);
        }
        console.log('\nFix: re-run classification for the show, or restore the tier via classifyContentTier() in scripts/lib/content-quality.js.');
      }
    }
    console.log(`\nReport: ${path.relative(ROOT, REPORT_PATH)}`);
  }

  // A corpus walk that saw zero files is a broken checkout, not a clean corpus.
  if (tier && tier.scanned === 0 && !args.show) {
    console.error('\nERROR: review-texts is present but the scan saw 0 files — broken checkout, refusing to report a pass.');
    process.exit(2);
  }

  if (args.all) process.exit(0);
  const newFindings = moves.findings.length + (tier ? tier.findings.length : 0);
  process.exit(newFindings > 0 ? 1 : 0);
}

if (require.main === module) main();
