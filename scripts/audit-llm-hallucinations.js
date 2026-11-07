#!/usr/bin/env node

/**
 * audit-llm-hallucinations.js
 *
 * Sweeps all review-text files for LLM contentVerification hallucinations.
 * These are files where verifiedBy='llm:*' and isValid:true, but the actual
 * fullText (or wrongFullText) contains no show-identifying keyword — browser
 * update prompts, paywall walls, sidebar lists, wrong-show content, etc.
 *
 * Why: LLM contentVerification hallucinates isValid:true ~48% of the time on
 * garbage pages. See feedback_llm_verifier_hallucinates.md and Notion card
 * 33f637c5-416f-814c-9102-f10a0849d986.
 *
 * Two cohorts audited:
 *
 *   A) LIVE hallucinations: fullText populated + llm-verified but no keyword
 *      in fullText. These are actively corrupting reviews.json scores.
 *
 *   B) QUARANTINED hallucinations: showNotMentioned:true + wrongFullText +
 *      llm-verified. These are NOT in reviews.json (quarantined by rebuild's
 *      auto-clear gate), but we still want to see the list to confirm the
 *      gate is working.
 *
 * Output:
 *   data/audit/llm-hallucination-suspects.json
 *
 * Usage:
 *   node scripts/audit-llm-hallucinations.js
 *   node scripts/audit-llm-hallucinations.js --show=hamilton-2015
 */

const fs = require('fs');
const path = require('path');
const {
  buildShowKeywordSet,
  findShowKeywordInText,
  checkLlmVerificationAgainstKeywords,
} = require('./lib/review-guards');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const OUTPUT_PATH = path.join(AUDIT_DIR, 'llm-hallucination-suspects.json');

const args = process.argv.slice(2);
const SHOW_FILTER = args.find(a => a.startsWith('--show='))?.split('=')[1];

if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });

const showsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
const showsArray = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = new Map();
for (const s of showsArray) showById.set(s.id, s);

const liveSuspects = [];       // Cohort A
const quarantineSuspects = []; // Cohort B
const noShowSkipped = [];      // review dir has no matching shows.json entry

let totalFiles = 0;
let cohortAEligible = 0;
let cohortBEligible = 0;

const showDirs = fs
  .readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .map(d => d.name)
  .filter(d => !SHOW_FILTER || d === SHOW_FILTER)
  .sort();

for (const showDir of showDirs) {
  const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
  let files;
  try {
    files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  } catch (e) {
    continue;
  }

  const show = showById.get(showDir);
  if (!show) {
    noShowSkipped.push({ showDir, fileCount: files.length });
    totalFiles += files.length;
    continue;
  }

  const keywordSet = buildShowKeywordSet(show);

  for (const file of files) {
    totalFiles++;
    const filePath = path.join(dirPath, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      continue;
    }

    const cv = data.contentVerification;
    if (!cv || typeof cv.verifiedBy !== 'string' || !cv.verifiedBy.startsWith('llm:')) continue;
    if (cv.isValid !== true) continue;
    if (cv.wrongArticle === true) continue;

    // Cohort A: fullText populated, no wrongShow/wrongProduction flags yet.
    if (
      data.fullText &&
      data.fullText.length >= 100 &&
      !data.wrongShow &&
      !data.wrongProduction &&
      !data.contentMismatchNote &&
      !data.needsReview
    ) {
      cohortAEligible++;
      const check = checkLlmVerificationAgainstKeywords(show, data.fullText, cv);
      if (check && !check.passed) {
        liveSuspects.push({
          showId: showDir,
          showTitle: show.title,
          showYear: show.year || (show.openingDate || '').slice(0, 4),
          outletId: data.outletId || file.split('--')[0],
          criticSlug: (file.split('--')[1] || '').replace(/\.json$/, ''),
          filePath: path.relative(process.cwd(), filePath),
          verifiedBy: cv.verifiedBy,
          verifiedAt: cv.verifiedAt || null,
          fullTextLength: data.fullText.length,
          fullTextPreview: data.fullText.slice(0, 240),
          keywordsChecked: check.keywordsChecked,
          url: data.url || null,
          assignedScore: data.assignedScore || null,
          cohort: 'A-live',
        });
      }
    }

    // Cohort B: quarantined (showNotMentioned:true + wrongFullText). Expected
    // outcome: every one of these has a failing keyword check — that's why
    // rebuild's auto-clear left them quarantined. If any PASS the keyword
    // check, the rebuild gate has a bug.
    if (data.showNotMentioned === true && data.wrongFullText && data.wrongFullText.length >= 100) {
      cohortBEligible++;
      const check = checkLlmVerificationAgainstKeywords(show, data.wrongFullText, cv);
      if (check) {
        quarantineSuspects.push({
          showId: showDir,
          showTitle: show.title,
          outletId: data.outletId || file.split('--')[0],
          criticSlug: (file.split('--')[1] || '').replace(/\.json$/, ''),
          filePath: path.relative(process.cwd(), filePath),
          verifiedBy: cv.verifiedBy,
          wrongFullTextLength: data.wrongFullText.length,
          wrongFullTextPreview: data.wrongFullText.slice(0, 240),
          keywordCheckPassed: check.passed,
          matchedKeyword: check.matchedKeyword,
          cohort: check.passed ? 'B-quarantined-but-matches-gate-bug' : 'B-quarantined-confirmed',
        });
      }
    }
  }
}

const byOutletA = {};
for (const s of liveSuspects) byOutletA[s.outletId] = (byOutletA[s.outletId] || 0) + 1;

const quarantineGateBugs = quarantineSuspects.filter(s => s.keywordCheckPassed);

const output = {
  generatedAt: new Date().toISOString(),
  totals: {
    totalFiles,
    cohortAEligible,
    cohortALiveSuspects: liveSuspects.length,
    cohortBEligible,
    cohortBQuarantineBugs: quarantineGateBugs.length,
    showsWithoutMetadata: noShowSkipped.length,
  },
  byOutletLive: byOutletA,
  liveSuspects,
  quarantineGateBugs,
};

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');

console.log('');
console.log('LLM-hallucination audit complete');
console.log('================================');
console.log(`  Total files scanned:     ${totalFiles}`);
console.log(`  Cohort A (live) eligible:${cohortAEligible}`);
console.log(`  Cohort A SUSPECTS:       ${liveSuspects.length}`);
console.log(`  Cohort B (quarantine):   ${cohortBEligible}`);
console.log(`  Cohort B gate bugs:      ${quarantineGateBugs.length}`);
console.log(`  Shows w/o metadata:      ${noShowSkipped.length} (${noShowSkipped.reduce((a, x) => a + x.fileCount, 0)} files skipped)`);
console.log('');
if (liveSuspects.length > 0) {
  console.log('Top live suspects by outlet:');
  const sorted = Object.entries(byOutletA).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [outlet, n] of sorted) console.log(`  ${outlet.padEnd(22)} ${n}`);
  console.log('');
}
console.log(`Full suspect list: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
