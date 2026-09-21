#!/usr/bin/env node

/**
 * Audit isNonReview:true files whose classifier contentType is literally
 * 'review' but which have never been promoted to wrongShow:true (BRO-3862).
 *
 * See scripts/lib/nonreview-contenttype-wrongshow.js for the full background
 * on why this class exists and why audit-cross-show-url.js's URL-slug
 * detector can't catch it (content mismatch, not URL-shape mismatch).
 *
 * Report-only by default. --apply promotes matches to wrongShow:true,
 * mirroring the field shape audit-cross-show-url.js's --fix already writes
 * (wrongShow, isValid:false, rejectionReason, wrongShowReason,
 * wrongShowFlaggedDate) so downstream consumers (isScoreable, the
 * cross-attribution fix tools) treat these identically to every other
 * wrongShow file. isNonReview is left untouched — it already correctly
 * excludes the file from reviews.json; this audit only makes that exclusion
 * visible to the wrongShow-keyed pipeline instead of silently
 * piggy-backing on a flag that means something else.
 *
 * Usage:
 *   node scripts/audit-review-type-wrong-show.js                # report, exits 0
 *   node scripts/audit-review-type-wrong-show.js --apply         # promote matches
 *   node scripts/audit-review-type-wrong-show.js --show=ID
 *   node scripts/audit-review-type-wrong-show.js --gate --max=0
 *   node scripts/audit-review-type-wrong-show.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { isReviewTypeWrongShowGap } = require('./lib/nonreview-contenttype-wrongshow');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');
const { safeWriteReview, invalidateWrongShowAutoClear } = require('./lib/review-write-guard');

const USAGE = `audit-review-type-wrong-show.js — promote isNonReview:true/nonReviewType:'review' files to wrongShow (BRO-3862)

Usage:
  node scripts/audit-review-type-wrong-show.js [--apply] [--show=ID] [--gate] [--max=0] [--json]

  --apply     write wrongShow:true (+ reason/flag fields) to matched files.
              Default is report-only.
  --show=ID   scope the sweep to one show directory
  --gate      exit 1 when the match count exceeds --max (baseline floor, wired into CI)
  --max=N     ceiling for --gate (default 0 — every instance of this gap is actionable)
  --json      machine-readable output
`;

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const LOG_PATH = path.join(AUDIT_DIR, 'review-type-wrong-show-audit.json');

const SKIP_DIRS = new Set(['_pending', '_superseded-misattributed']);

function parseArgs(argv) {
  const args = {
    apply: argv.includes('--apply'),
    gate: argv.includes('--gate'),
    json: argv.includes('--json'),
    show: null,
    max: parseMaxArgOrExit(argv, { defaultMax: 0, scriptName: 'audit-review-type-wrong-show' }),
  };
  for (const a of argv) {
    if (a.startsWith('--show=')) args.show = a.split('=')[1];
  }
  return args;
}

// Same { dirs, rootMissing } contract as audit-exclusion-flags.js's
// listShowDirs — a missing/empty REVIEW_TEXTS_DIR has no legitimate reading
// distinct from a --show filter matching nothing (BRO-2283 vacuous-pass class).
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

function applyPromote(data, showId, file) {
  const now = new Date().toISOString();
  data.wrongShow = true;
  invalidateWrongShowAutoClear(data);
  data.isValid = false;
  data.rejectionReason = 'wrong_show';
  data.wrongShowReason = `nonReviewType='review' promoted: classify-non-reviews.js (${data.nonReviewClassifiedBy || 'gemini'}) identified this content as a genuine review, but not of ${showId} — content mismatch, not a URL-shape match (audit-review-type-wrong-show.js, BRO-3862).`;
  data.wrongShowFlaggedDate = now.slice(0, 10);
  return data;
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);

  const hits = [];
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
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      scanned++;

      if (!isReviewTypeWrongShowGap(data)) continue;

      hits.push({
        showId,
        file,
        outlet: data.outlet || data.outletId || null,
        critic: data.criticName || null,
        url: data.url || null,
        score: (data.llmScore && data.llmScore.score) || data.assignedScore || null,
        classifiedAt: data.classifiedAt || null,
      });

      if (args.apply) {
        try {
          applyPromote(data, showId, file);
          safeWriteReview(filePath, data, { force: true });
          const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (after.wrongShow !== true) {
            console.error(`  ERROR: write did not stick for ${showId}/${file} (wrongShow=${after.wrongShow})`);
          }
        } catch (e) {
          console.error(`  ERROR applying promote to ${showId}/${file}: ${e.message}`);
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ scanned, count: hits.length, applied: args.apply, hits }, null, 2));
  } else {
    console.log(`Review-type wrongShow gap audit: ${scanned} review file(s) scanned, ${hits.length} match(es) (${args.apply ? 'APPLIED' : 'report-only, pass --apply to promote'}).`);
    for (const h of hits) {
      console.log(`  ${h.showId}/${h.file}  score=${h.score} outlet=${h.outlet} url=${(h.url || '').slice(0, 80)}`);
    }
  }

  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify({
    _meta: { generatedAt: new Date().toISOString(), scanned, count: hits.length, applied: args.apply },
    hits,
  }, null, 2) + '\n');
  if (!args.json) console.log(`\nAudit log: ${LOG_PATH}`);

  try {
    assertCorpusScanned(scanned, { gate: args.gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  if (args.gate && hits.length > args.max && !args.apply) {
    console.error(`\nFAIL: ${hits.length} hit(s) > max ${args.max}. A new classify-non-reviews.js run stamped nonReviewType='review' without a wrongShow promotion — run with --apply to promote, or raise --max if the new hits are false positives.`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { applyPromote, main, REVIEW_TEXTS_DIR };
