#!/usr/bin/env node

/**
 * Sweep for NAMED_NON_REVIEW_URL_PATTERNS matches already on disk (BRO-4101).
 *
 * scripts/lib/non-review-url-patterns.js's NAMED_NON_REVIEW_URL_PATTERNS was
 * only ever consulted at DISCOVERY time (audit-show-review-gap.js's
 * isReviewUrl(), the S5 coverage-adversarial-probe's classifyNonReviewUrl()) —
 * never at ingest or rebuild. review-file-writer.js and review-guards.js now
 * both apply it going forward (the BRO-4101 fix), but files ingested BEFORE
 * those guards existed are already on disk and need a one-time sweep.
 *
 * NAMED_NON_REVIEW_URL_PATTERNS was curated purely as a discovery-time reject
 * — several entries are host-wide (e.g. newyorkcitytheatre.com) rather than
 * path-scoped, which is safe to skip discovering but NOT safe to blindly flag
 * on disk: a full-corpus scan (2026-09-24) found a genuine, scored,
 * contentTier:complete review (burn-this-2019's new-york-city-theatre--
 * nicola-quinn.json, source show-score-playwright, critic Nicola Quinn) whose
 * legitimate citation URL happens to sit on a named-pattern host. --apply
 * therefore only auto-flags the verified-safe subset: source starting with
 * 'serp-discovery' — the exact shape of the reported contamination (a raw,
 * unvetted SERP hit on a named ticketing/listing host, no aggregator/human
 * vetting). Every other match is reported for visibility but never
 * auto-flagged; review it by hand before deciding source-by-source.
 *
 * Modeled on scripts/audit-exclusion-flags.js's report-default/--apply/
 * safeWriteReview(force:true) convention.
 *
 * Usage:
 *   node scripts/sweep-named-non-review-urls.js                  # report, exits 0
 *   node scripts/sweep-named-non-review-urls.js --apply           # flag the safe subset
 *   node scripts/sweep-named-non-review-urls.js --show=ID
 *   node scripts/sweep-named-non-review-urls.js --gate --max=10
 *   node scripts/sweep-named-non-review-urls.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { namedNonReviewReason } = require('./lib/non-review-url-patterns.js');
const { isUnvettedSerpSource } = require('./lib/unvetted-serp-sources.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');
const { safeWriteReview } = require('./lib/review-write-guard');

const USAGE = `sweep-named-non-review-urls.js — flag existing review-texts files whose URL matches a NAMED_NON_REVIEW_URL_PATTERNS entry (BRO-4101)

Usage:
  node scripts/sweep-named-non-review-urls.js [--apply] [--show=ID] [--gate] [--max=10] [--json]

  --apply     write isNonReview=true to the verified-safe subset (unvetted
              SERP-sourced records — see lib/unvetted-serp-sources.js). Every
              other match is reported only — see the file header for why a
              blanket apply is unsafe.
              Default is report-only.
  --show=ID   scope the sweep to one show directory
  --gate      exit 1 when the auto-flaggable match count exceeds --max (informational)
  --max=N     ceiling for --gate (default 10)
  --json      machine-readable output
`;

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const LOG_PATH = path.join(AUDIT_DIR, 'named-non-review-url-sweep.json');

const SKIP_DIRS = new Set(['_pending', '_superseded-misattributed']);

// Verified against the full 44,443-file corpus (2026-09-24): source-scoping
// to isUnvettedSerpSource catches every confirmed contamination case (all
// Unknown/placeholder-byline listing/ticket/cast pages) with zero false
// positives, while an unscoped flag would have caught legitimate aggregator-
// sourced content sharing a host with a named pattern.
function isAutoFlaggable(data) {
  return isUnvettedSerpSource(data.source);
}

function parseArgs(argv) {
  const args = {
    apply: argv.includes('--apply'),
    gate: argv.includes('--gate'),
    json: argv.includes('--json'),
    show: null,
    max: parseMaxArgOrExit(argv, { defaultMax: 10, scriptName: 'sweep-named-non-review-urls' }),
  };
  for (const a of argv) {
    if (a.startsWith('--show=')) args.show = a.split('=')[1];
  }
  return args;
}

function listShowDirs(dir, showFilter) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dirs: [], rootMissing: true };
  }
  if (entries.length === 0) return { dirs: [], rootMissing: true };
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => !showFilter || name === showFilter)
    .filter((name) => {
      try { return fs.statSync(path.join(dir, name)).isDirectory(); }
      catch { return false; }
    });
  return { dirs, rootMissing: false };
}

function applyFlag(data, reason) {
  data.isNonReview = true;
  data.isNonReviewReason = `${reason} (auto: named non-review URL pattern, BRO-4101 sweep)`;
  return data;
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);

  const autoFlaggable = [];
  const needsReview = [];
  const applyFailures = [];
  let scanned = 0;

  const { dirs: showDirs, rootMissing } = listShowDirs(REVIEW_TEXTS_DIR, args.show);
  try {
    assertCorpusScanned(0, { corpusRootMissing: rootMissing });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { continue; }
      scanned++;

      if (!data.url || data.isNonReview === true) continue;
      const reason = namedNonReviewReason(data.url);
      if (!reason) continue;

      const hit = {
        showId,
        file,
        url: data.url,
        reason,
        source: data.source || null,
        criticName: data.criticName || null,
        contentTier: data.contentTier || null,
        score: (data.llmScore && data.llmScore.score) || data.assignedScore || null,
      };

      if (isAutoFlaggable(data)) {
        autoFlaggable.push(hit);
        if (args.apply) {
          try {
            applyFlag(data, reason);
            safeWriteReview(filePath, data, { force: true });
            const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (after.isNonReview !== true) {
              console.error(`  ERROR: write did not stick for ${showId}/${file} (isNonReview=${after.isNonReview})`);
              applyFailures.push({ showId, file, reason: 'write-did-not-stick' });
            }
          } catch (e) {
            console.error(`  ERROR applying flag to ${showId}/${file}: ${e.message}`);
            applyFailures.push({ showId, file, reason: e.message });
          }
        }
      } else {
        needsReview.push(hit);
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ scanned, autoFlaggable, needsReview, applyFailures, applied: args.apply }, null, 2));
  } else {
    console.log(`Named non-review URL sweep: ${scanned} review file(s) scanned.`);
    console.log(`  ${autoFlaggable.length} serp-discovery match(es) (${args.apply ? 'FLAGGED' : 'report-only, pass --apply to flag'}):`);
    for (const h of autoFlaggable) console.log(`    ${h.showId}/${h.file}  reason=${h.reason} critic=${h.criticName} score=${h.score}`);
    console.log(`  ${needsReview.length} other-sourced match(es) (NOT auto-flagged — needs manual review, see file header):`);
    for (const h of needsReview) console.log(`    ${h.showId}/${h.file}  reason=${h.reason} source=${h.source} critic=${h.criticName} contentTier=${h.contentTier}`);
    if (applyFailures.length) {
      console.log(`  ${applyFailures.length} apply FAILURE(s) — these did NOT get flagged despite being counted above:`);
      for (const f of applyFailures) console.log(`    ${f.showId}/${f.file}  ${f.reason}`);
    }
  }

  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify({
    _meta: { generatedAt: new Date().toISOString(), scanned, autoFlaggableCount: autoFlaggable.length, needsReviewCount: needsReview.length, applyFailureCount: applyFailures.length, applied: args.apply },
    autoFlaggable,
    needsReview,
    applyFailures,
  }, null, 2) + '\n');
  if (!args.json) console.log(`\nAudit log: ${LOG_PATH}`);

  if (args.apply && applyFailures.length) {
    console.error(`\nFAIL: ${applyFailures.length} file(s) failed to apply — do not treat this run as a clean sweep.`);
    process.exit(1);
  }

  try {
    assertCorpusScanned(scanned, { gate: args.gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  if (args.gate && autoFlaggable.length > args.max) {
    console.error(`\nFAIL: ${autoFlaggable.length} auto-flaggable hit(s) > max ${args.max}.`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { main, isAutoFlaggable, applyFlag, REVIEW_TEXTS_DIR };
