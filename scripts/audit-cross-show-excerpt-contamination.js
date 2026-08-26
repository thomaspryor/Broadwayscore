#!/usr/bin/env node
'use strict';

/**
 * audit-cross-show-excerpt-contamination.js — BRO-461.
 *
 * BRO-115's backfill unlocked 202 excerpt-only reviews for auto-scoring
 * (isIncludableForRebuild started recognizing excerpt fields, task #501).
 * One of the original 259-file backlog turned out to carry verbatim
 * cross-show content (Shadowlands review misattributed to Harry Potter and
 * the Cursed Child) that the fullText contentVerification LLM check would
 * have caught, but never runs on excerpt-sourced fields. This audits the
 * rest of that original backlog for the same failure mode.
 *
 * Detector: build a single in-memory index of every excerpt/fullText field
 * across the WHOLE review-texts corpus (one pass, not 202 separate greps —
 * the naive approach timed out), then look up each backlog file's own
 * fields against it. An exact (post-normalization) text match filed under a
 * DIFFERENT showId is the contamination signal.
 *
 * Usage:
 *   node scripts/audit-cross-show-excerpt-contamination.js
 *   node scripts/audit-cross-show-excerpt-contamination.js --apply
 *   node scripts/audit-cross-show-excerpt-contamination.js --list=/path/to/list.txt
 *   node scripts/audit-cross-show-excerpt-contamination.js --review-texts-dir=/path
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  buildExcerptIndex,
  findCrossShowMatches,
  shouldAutoFlag,
  stillExcerptOnly,
} = require('./lib/excerpt-contamination-audit');

const USAGE = `audit-cross-show-excerpt-contamination.js — BRO-461 excerpt cross-show audit.

Usage:
  node scripts/audit-cross-show-excerpt-contamination.js [options]

Options:
  --list=PATH               backlog list (default: ~/Documents/claude-outputs/excerpt-only-unscored-backfill-2026-07-26.txt)
  --review-texts-dir=PATH   override resolveReviewTextsDir()
  --report-path=PATH        default: data/audit/cross-show-excerpt-contamination-report.json
  --apply                   write wrongShow flags for auto-flag-eligible high-confidence matches
  --help, -h                print this usage and exit
`;

const ROOT = path.join(__dirname, '..');

function arg(args, name, fallback = null) {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : fallback;
}

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    list: arg(argv, 'list', path.join(os.homedir(), 'Documents', 'claude-outputs', 'excerpt-only-unscored-backfill-2026-07-26.txt')),
    reviewTextsDir: arg(argv, 'review-texts-dir', null),
    reportPath: arg(argv, 'report-path', path.join(ROOT, 'data', 'audit', 'cross-show-excerpt-contamination-report.json')),
  };
}

function loadBacklogList(listPath) {
  if (!fs.existsSync(listPath)) {
    throw new Error(`Backlog list not found: ${listPath}`);
  }
  return fs.readFileSync(listPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function splitRel(rel) {
  const idx = rel.lastIndexOf('/');
  return { showId: rel.slice(0, idx), file: rel.slice(idx + 1) };
}

/** Walk the whole corpus once, yielding {showId, file, filePath, data} for every review-text record. */
function walkCorpus(reviewTextsDir) {
  const out = [];
  let malformed = 0;
  const showDirs = listShowDirs(reviewTextsDir).filter((d) => d !== '_pending');
  for (const showId of showDirs) {
    const showPath = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(showPath).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(showPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        malformed++;
        continue;
      }
      out.push({ showId, file, filePath, data });
    }
  }
  return { records: out, malformed };
}

function isScored(data) {
  return !!(data && data.llmScore && data.llmScore.score);
}

function isFlagged(data) {
  return !!(data && (data.wrongShow || data.wrongProduction || data.duplicateOf));
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const opts = parseArgs(argv);

  const reviewTextsDir = opts.reviewTextsDir || resolveReviewTextsDir();
  console.log(`[audit-cross-show-excerpt-contamination] review-texts: ${reviewTextsDir}`);
  if (!fs.existsSync(reviewTextsDir)) {
    console.error(`Review-texts dir not found: ${reviewTextsDir}`);
    process.exit(2);
  }

  let backlog;
  try {
    backlog = loadBacklogList(opts.list);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  console.log(`[audit-cross-show-excerpt-contamination] backlog: ${opts.list} (${backlog.length} entries)`);

  console.log('[audit-cross-show-excerpt-contamination] scanning corpus (single pass)…');
  const { records, malformed } = walkCorpus(reviewTextsDir);
  const byRel = new Map(records.map((r) => [`${r.showId}/${r.file}`, r]));
  console.log(`[audit-cross-show-excerpt-contamination] ${records.length} files scanned (${malformed} malformed), building index…`);
  const index = buildExcerptIndex(records);
  console.log(`[audit-cross-show-excerpt-contamination] index built: ${index.size} distinct normalized text entries`);

  const perFile = [];
  let missing = 0;
  let notScored = 0;
  let alreadyFlaggedCount = 0;
  let noLongerExcerptOnly = 0;
  let checked = 0;
  let withMatches = 0;
  let highConfidenceCount = 0;
  let autoFlagEligible = 0;
  let applied = 0;

  for (const rel of backlog) {
    const { showId, file } = splitRel(rel);
    const rec = byRel.get(rel);
    if (!rec) {
      missing++;
      perFile.push({ rel, showId, file, exists: false, scored: false, alreadyFlagged: false, matches: [], action: 'file-not-found' });
      continue;
    }

    const scored = isScored(rec.data);
    const flagged = isFlagged(rec.data);
    const excerptOnly = stillExcerptOnly(rec.data);
    if (!scored) notScored++;
    if (flagged) alreadyFlaggedCount++;
    if (scored && !flagged) checked++;

    if (!excerptOnly) {
      noLongerExcerptOnly++;
      // Re-collected with real fullText since the backlog was generated —
      // already covered by the standing fullText contentVerification check
      // (enrich-reviews.yml), out of BRO-461's scope. Report it so the file
      // still appears as "checked" in the audit trail, but don't match its
      // now-vestigial excerpt fields.
      perFile.push({
        rel, showId, file, exists: true, scored, alreadyFlagged: flagged,
        excerptOnly: false, matchCount: 0, bestMatch: null, matches: [],
        action: 'no-longer-excerpt-only',
      });
      continue;
    }

    const matches = findCrossShowMatches(showId, file, rec.data, index)
      .sort((a, b) => b.matchLength - a.matchLength);

    if (matches.length > 0) withMatches++;
    const best = matches[0] || null;
    if (best && best.confidence === 'high') highConfidenceCount++;

    let action = matches.length === 0 ? 'no-match' : 'needs-manual-review';
    if (best && shouldAutoFlag(best)) {
      autoFlagEligible++;
      action = 'auto-flag-eligible';
      if (opts.apply && !flagged) {
        try {
          const data = JSON.parse(fs.readFileSync(rec.filePath, 'utf8'));
          if (!data.wrongShow && !data.wrongProduction) {
            data.wrongShow = true;
            data.wrongShowReason = `Cross-attribution (BRO-461 excerpt-only backfill audit): ${best.targetField} content verbatim-matches ${best.matchedShowId}/${best.matchedFile}'s ${best.matchedField}, which already carries wrongProduction/wrongShow for the identical content (match length ${best.matchLength} chars).`;
            data.crossAttributionAudit = {
              detectedShowId: best.matchedShowId,
              evidence: `${best.targetField} text verbatim-matches ${best.matchedShowId}/${best.matchedFile} (${best.matchedField})`,
              matchLength: best.matchLength,
              flaggedAt: new Date().toISOString(),
              flaggedBy: 'BRO-461 audit-cross-show-excerpt-contamination.js --apply',
            };
            const tmp = `${rec.filePath}.tmp`;
            fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
            fs.renameSync(tmp, rec.filePath);
            applied++;
            action = 'flagged';
          }
        } catch (e) {
          console.error(`  Error applying flag to ${rel}: ${e.message}`);
        }
      }
    }

    perFile.push({
      rel,
      showId,
      file,
      exists: true,
      scored,
      alreadyFlagged: flagged,
      excerptOnly: true,
      matchCount: matches.length,
      bestMatch: best,
      matches,
      action,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      reviewTextsDir,
      listPath: opts.list,
      apply: opts.apply,
    },
    summary: {
      backlogEntries: backlog.length,
      missing,
      notScored,
      noLongerExcerptOnly,
      alreadyFlagged: alreadyFlaggedCount,
      checked,
      withMatches,
      highConfidence: highConfidenceCount,
      autoFlagEligible,
      applied,
    },
    files: perFile,
  };

  fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
  fs.writeFileSync(opts.reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('');
  console.log(`Backlog entries:        ${backlog.length}`);
  console.log(`Missing (not found):    ${missing}`);
  console.log(`Not yet scored:         ${notScored}`);
  console.log(`No longer excerpt-only: ${noLongerExcerptOnly} (re-collected w/ fullText, out of scope)`);
  console.log(`Already flagged:        ${alreadyFlaggedCount}`);
  console.log(`Checked (scored+clean): ${checked}`);
  console.log(`With cross-show match:  ${withMatches}`);
  console.log(`  high confidence:      ${highConfidenceCount}`);
  console.log(`  auto-flag-eligible:   ${autoFlagEligible}`);
  if (opts.apply) console.log(`  applied:              ${applied}`);
  console.log(`Report written: ${opts.reportPath}`);
  if (!opts.apply && autoFlagEligible > 0) {
    console.log('\nRun with --apply to flag auto-flag-eligible matches as wrongShow.');
  }
}

if (require.main === module) {
  main();
}

module.exports = { walkCorpus, loadBacklogList, splitRel, isScored, isFlagged };
