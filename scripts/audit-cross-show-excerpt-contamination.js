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
 * BRO-4159: the default target is now the WHOLE corpus (every excerpt-only
 * file), not BRO-461's fixed 259-file backlog. --list/--file narrow it.
 * --plan-out=DIR writes the auto-flag-eligible rows as pending-fix plans
 * (review-field-edit wrongShow actions) for execute-approved-fix.js.
 *
 * Usage:
 *   node scripts/audit-cross-show-excerpt-contamination.js
 *   node scripts/audit-cross-show-excerpt-contamination.js --plan-out=data/pending-fixes
 *   node scripts/audit-cross-show-excerpt-contamination.js --apply
 *   node scripts/audit-cross-show-excerpt-contamination.js --list=/path/to/list.txt
 *   node scripts/audit-cross-show-excerpt-contamination.js --review-texts-dir=/path
 */

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { wrongShowCleared } = require('./lib/review-guards');
const { invalidateWrongShowAutoClear } = require('./lib/review-write-guard');
const {
  buildExcerptIndex,
  findCrossShowMatches,
  shouldAutoFlag,
  isQuarantinedTargetMatch,
  stillExcerptOnly,
  selectAuditTargets,
  buildFlagPlans,
  isAuditableShowDir,
} = require('./lib/excerpt-contamination-audit');

const USAGE = `audit-cross-show-excerpt-contamination.js — BRO-461 excerpt cross-show audit.

Usage:
  node scripts/audit-cross-show-excerpt-contamination.js [options]

Options:
  --list=PATH               check only this backlog list (default: the whole corpus)
  --file=SHOW/FILE.json     check only this file (repeatable; wins over --list)
  --plan-out=DIR            write auto-flag-eligible scored+unflagged rows as pending-fix plans
                            (<issue>.json, <issue>-p2.json, ...); refuses to overwrite an existing plan
  --issue=ID                plan id for --plan-out (default bro-4159)
  --shows-path=PATH         shows.json for target titles (default data/shows.json; optional)
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
    list: arg(argv, 'list', null),
    files: argv.filter((a) => a.startsWith('--file=')).map((a) => a.slice('--file='.length)).filter(Boolean),
    planOut: arg(argv, 'plan-out', null),
    issue: arg(argv, 'issue', 'bro-4159'),
    showsPath: arg(argv, 'shows-path', path.join(ROOT, 'data', 'shows.json')),
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

/** Returns null (rather than a corrupt {showId, file} pair) for a line with no '/'. */
function splitRel(rel) {
  const idx = rel.lastIndexOf('/');
  if (idx < 0) return null;
  return { showId: rel.slice(0, idx), file: rel.slice(idx + 1) };
}

/** Walk the whole corpus once, yielding {showId, file, filePath, data} for every review-text record. */
function walkCorpus(reviewTextsDir) {
  const out = [];
  let malformed = 0;
  let unreadableDirs = 0;
  const showDirs = listShowDirs(reviewTextsDir).filter(isAuditableShowDir);
  for (const showId of showDirs) {
    const showPath = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(showPath).filter((f) => isReviewTextFile(f));
    } catch (e) {
      unreadableDirs++;
      console.warn(`::warning::walkCorpus: skipping unreadable show dir '${showId}' (${e.code || e.message})`);
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
  return { records: out, malformed, unreadableDirs };
}

/** id -> [title]; empty map when shows.json is absent (cloud/worktree). */
function loadTitlesById(showsPath) {
  const out = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const shows = Array.isArray(raw) ? raw : (raw.shows || []);
    for (const s of shows) if (s && s.id && s.title) out.set(s.id, [s.title]);
  } catch { /* titles derive from the show id alone */ }
  return out;
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

  let listLines = null;
  if (opts.list) {
    try {
      listLines = loadBacklogList(opts.list);
    } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
  }

  console.log('[audit-cross-show-excerpt-contamination] scanning corpus (single pass)…');
  const { records, malformed, unreadableDirs } = walkCorpus(reviewTextsDir);
  const byRel = new Map(records.map((r) => [`${r.showId}/${r.file}`, r]));
  console.log(`[audit-cross-show-excerpt-contamination] ${records.length} files scanned (${malformed} malformed, ${unreadableDirs} unreadable dirs), building index…`);
  const index = buildExcerptIndex(records);
  console.log(`[audit-cross-show-excerpt-contamination] index built: ${index.size} distinct normalized text entries`);
  const { mode, targets: backlog } = selectAuditTargets(records, { files: opts.files, list: listLines });
  console.log(`[audit-cross-show-excerpt-contamination] target: ${mode}${mode === 'list' ? ` ${opts.list}` : ''} (${backlog.length} entries)`);
  const planRows = [];

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
  let targetOwnsSkipped = 0;
  let quarantinedOnly = 0;
  const titlesById = loadTitlesById(opts.showsPath);

  for (const rel of backlog) {
    const parsed = splitRel(rel);
    if (!parsed) {
      missing++;
      perFile.push({ rel, showId: null, file: null, exists: false, scored: false, alreadyFlagged: false, matches: [], action: 'malformed-backlog-line' });
      continue;
    }
    const { showId, file } = parsed;
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

    const matches = findCrossShowMatches(showId, file, rec.data, index, { titles: titlesById.get(showId) || [] })
      .sort((a, b) => b.matchLength - a.matchLength);

    if (matches.length > 0) withMatches++;
    const best = matches[0] || null;
    if (best && best.confidence === 'high') highConfidenceCount++;

    // Check EVERY match, not just the longest — a shorter but corroborated
    // match can be auto-flag-eligible while the single longest match isn't
    // (e.g. the longest match is an uncorroborated duplicate-slug pair while
    // a shorter match is a verified wrongFullText hit).
    // BRO-4159: if ANY match's quarantined text looks like the target show's
    // own review, nothing auto-flags this file; a human decides.
    // BRO-5622: matches through the target's own (quarantined, unscored)
    // wrongFullText never flag and, when they are all there is, leave the
    // manual queue too. ownsText still looks at every match: it only blocks.
    const onlyQuarantined = matches.length > 0 && matches.every((m) => isQuarantinedTargetMatch(m));
    const ownsText = matches.some((m) => m.targetOwnsText);
    const eligibleMatch = ownsText ? null : (matches.find((m) => shouldAutoFlag(m)) || null);
    let action = matches.length === 0 ? 'no-match' : 'needs-manual-review';
    if (onlyQuarantined) {
      quarantinedOnly++;
      action = 'quarantined-target-text-only';
    } else if (ownsText) {
      targetOwnsSkipped++;
      action = 'needs-manual-review-target-owns-text';
    }
    if (eligibleMatch) {
      autoFlagEligible++;
      action = 'auto-flag-eligible';
      if (scored && !flagged && !wrongShowCleared(rec.data)) {
        planRows.push({ rel, match: eligibleMatch, oldValue: rec.data.wrongShow ?? null });
      }
      if (opts.apply && !flagged) {
        try {
          const data = JSON.parse(fs.readFileSync(rec.filePath, 'utf8'));
          // wrongShowCleared: a human may have already reviewed and cleared
          // a stale flag on this exact file (review-guards.js's 5-signal
          // manual-clear contract). Without this check an --apply run could
          // silently stomp that override — the same guard
          // audit-cross-attribution-by-critic.js's --apply already applies.
          if (!data.wrongShow && !data.wrongProduction && !wrongShowCleared(data)) {
            data.wrongShow = true;
            invalidateWrongShowAutoClear(data);
            data.wrongShowReason = `Cross-attribution (BRO-461/BRO-4159 excerpt-only cross-show audit): ${eligibleMatch.targetField} content verbatim-matches ${eligibleMatch.matchedShowId}/${eligibleMatch.matchedFile}'s ${eligibleMatch.matchedField}, which already carries verified wrong-show content for the identical text (match length ${eligibleMatch.matchLength} chars).`;
            data.crossAttributionAudit = {
              detectedShowId: eligibleMatch.matchedShowId,
              evidence: `${eligibleMatch.targetField} text verbatim-matches ${eligibleMatch.matchedShowId}/${eligibleMatch.matchedFile} (${eligibleMatch.matchedField})`,
              matchLength: eligibleMatch.matchLength,
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
      target: mode,
      listPath: opts.list,
      files: opts.files,
      apply: opts.apply,
    },
    summary: {
      backlogEntries: backlog.length,
      corpusFilesScanned: records.length,
      corpusMalformed: malformed,
      corpusUnreadableDirs: unreadableDirs,
      missing,
      notScored,
      noLongerExcerptOnly,
      alreadyFlagged: alreadyFlaggedCount,
      checked,
      withMatches,
      highConfidence: highConfidenceCount,
      autoFlagEligible,
      applied,
      autoFlagEligibleUnflagged: planRows.length,
      targetOwnsTextSkipped: targetOwnsSkipped,
      quarantinedTargetTextOnly: quarantinedOnly,
    },
    files: perFile,
  };

  if (opts.planOut) {
    let plans;
    try {
      plans = buildFlagPlans(planRows, { issue: opts.issue, makeId: () => crypto.randomUUID() });
    } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
    const existing = plans.map(({ name }) => path.join(opts.planOut, `${name}.json`)).filter((f) => fs.existsSync(f));
    if (existing.length > 0) {
      console.error(`Refusing to overwrite existing plan file(s): ${existing.join(', ')}. Pass a new --issue=ID.`);
      process.exit(2);
    }
    fs.mkdirSync(opts.planOut, { recursive: true });
    for (const { name, plan } of plans) {
      const out = path.join(opts.planOut, `${name}.json`);
      fs.writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
      console.log(`Plan written: ${out} (${plan.plan.actions.length} actions)`);
    }
    if (plans.length === 0) console.log('No auto-flag-eligible unflagged files: no plan written.');
  }

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
  console.log(`    not yet flagged:      ${planRows.length}`);
  console.log(`  target owns text (skipped): ${targetOwnsSkipped}`);
  console.log(`  only via target's quarantined wrongFullText (skipped): ${quarantinedOnly}`);
  if (opts.apply) console.log(`  applied:              ${applied}`);
  console.log(`Report written: ${opts.reportPath}`);
  if (!opts.apply && planRows.length > 0) {
    console.log('\nRun with --plan-out=data/pending-fixes to write these as approved-fix plans (wrongShow edits).');
  }
}

if (require.main === module) {
  main();
}

module.exports = { walkCorpus, loadBacklogList, splitRel, isScored, isFlagged };
