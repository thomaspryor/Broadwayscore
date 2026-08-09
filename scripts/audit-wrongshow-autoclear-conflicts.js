#!/usr/bin/env node
/**
 * audit-wrongshow-autoclear-conflicts.js — find review files where an
 * auto-clear heuristic overruled the multi-model ensemble's own rejection.
 *
 * The defect (coverage-pipeline tracker #2 / task #1146, 2026-08-09):
 * rebuild-all-reviews.js cleared `wrongShow` on any London-market file whose URL
 * was a UK/major outlet, and cleared it again for any file carrying
 * allowCrossMarket — even when the ensemble scoreability check had already
 * rejected that file as wrong_show, with claude + openai + gemini independently
 * naming a DIFFERENT production. A blanket domain heuristic beating the
 * strongest evidence the pipeline produces.
 * `romeo-and-juliet-west-end-2026/london-theatre--holly-omahony.json` was LIVE
 * serving Noughts & Crosses text.
 *
 * wrongProduction has the identical hole and a larger population, so this audits
 * BOTH flags. Fixing one and leaving the cousin is how this class survives.
 *
 * The forward fix is hasEnsembleRejection() in
 * scripts/lib/wrong-production-autoclear.js, which all four auto-clear
 * predicates now consult. This script is the BACKFILL and the standing gate for
 * files already in the bad state — the rebuild cannot heal them, because once
 * the flag is deleted there is nothing left for it to re-evaluate.
 *
 * Usage:
 *   node scripts/audit-wrongshow-autoclear-conflicts.js            # report
 *   node scripts/audit-wrongshow-autoclear-conflicts.js --strict   # exit 1 if any remain
 *   node scripts/audit-wrongshow-autoclear-conflicts.js --fix      # re-assert the flags
 *   ... --json                                                     # machine-readable
 *
 * --fix re-asserts wrongShow/wrongProduction = true and stamps a manual
 * *Reason (a PROTECTED_FIELD), so the flag survives both the next rebuild and
 * the push-time restore rather than being cleared again on the next cron.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { hasEnsembleRejection } = require('./lib/wrong-production-autoclear');
const { safeWriteReview } = require('./lib/review-write-guard');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

const USAGE = `audit-wrongshow-autoclear-conflicts.js — auto-clear vs ensemble-verdict conflicts

Usage:
  node scripts/audit-wrongshow-autoclear-conflicts.js [--strict] [--fix] [--json]

  --strict  exit 1 when any conflict remains (wire into CI)
  --fix     re-assert the flag with a manual reason so it survives rebuild + push restore
  --json    emit the findings as JSON
`;

// The two conflicting states, each: the ensemble said X, an auto-clear undid it.
const CLASSES = [
  {
    kind: 'wrong_show',
    flag: 'wrongShow',
    breadcrumb: 'wrongShowAutoCleared',
    reasonField: 'wrongShowReason',
    atField: 'wrongShowReasonAt',
  },
  {
    kind: 'wrong_production',
    flag: 'wrongProduction',
    breadcrumb: 'wrongProductionAutoCleared',
    reasonField: 'wrongProductionReason',
    atField: 'wrongProductionReasonAt',
  },
];

function listShowDirs() {
  let entries;
  try {
    entries = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true });
  } catch (e) {
    // Vacuous-gate guard (task #1065 class): a missing corpus must FAIL, never
    // report a clean zero. A gate that passes because it looked at nothing is
    // worse than no gate.
    console.error(`::error::review-texts corpus unreadable at ${REVIEW_TEXTS_DIR} (${e.message}) — this audit cannot report 0 without reading it.`);
    process.exit(2);
  }
  return entries.filter((d) => d.isDirectory()).map((d) => d.name);
}

function scan() {
  const findings = [];
  let filesRead = 0;
  for (const showId of listShowDirs()) {
    const dir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const file of files) {
      const fp = path.join(dir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      filesRead++;
      for (const c of CLASSES) {
        if (!hasEnsembleRejection(data, c.kind)) continue;
        if (!data[c.breadcrumb]) continue;      // no auto-clear happened
        if (data[c.flag] === true) continue;    // flag survived — not a conflict
        findings.push({
          showId,
          file,
          path: path.relative(path.join(__dirname, '..'), fp),
          kind: c.kind,
          flag: c.flag,
          breadcrumb: String(data[c.breadcrumb]),
          rejectedBy: data.rejectedBy || null,
          // First model clause only — enough to identify the verdict in a log
          // without dumping paragraphs of LLM prose.
          reasoning: String(data.rejectionReasoning || '').slice(0, 160),
          url: data.url || null,
        });
      }
    }
  }
  return { findings, filesRead };
}

function applyFix(findings) {
  const today = new Date().toISOString().split('T')[0];
  let fixed = 0;
  const failures = [];
  for (const f of findings) {
    const c = CLASSES.find((x) => x.kind === f.kind);
    const fp = path.join(__dirname, '..', f.path);
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {
      failures.push(`${f.path}: unreadable (${e.message})`);
      continue;
    }
    data[c.flag] = true;
    // A manual *Reason is what every auto-clear predicate already respects, and
    // it is a PROTECTED_FIELD — so this is what makes the re-flag durable across
    // the next rebuild AND the push-time restore. Without it the next cron
    // simply clears the flag again.
    data[c.reasonField] = `ensemble-unanimous-${f.kind.replace('_', '-')} (audit-wrongshow-autoclear-conflicts, task #1146)`;
    data[c.atField] = today;
    try {
      safeWriteReview(fp, data, { force: true });
    } catch (e) {
      failures.push(`${f.path}: write failed (${e.message})`);
      continue;
    }
    // Verify-after-write: the old auto-clear paths swallowed safeWriteReview
    // errors entirely (rebuild-all-reviews.js:2608/2620 `catch (e) {}`), so a
    // partial fix could report success while the corpus stayed wrong.
    try {
      const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (after[c.flag] !== true || !after[c.reasonField]) {
        failures.push(`${f.path}: write did not stick (${c.flag}=${after[c.flag]})`);
        continue;
      }
    } catch (e) {
      failures.push(`${f.path}: unreadable after write (${e.message})`);
      continue;
    }
    fixed++;
  }
  return { fixed, failures };
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const strict = argv.includes('--strict');
  const fix = argv.includes('--fix');
  const asJson = argv.includes('--json');

  let { findings, filesRead } = scan();

  if (fix && findings.length) {
    const { fixed, failures } = applyFix(findings);
    console.log(`Re-asserted ${fixed}/${findings.length} flag(s).`);
    for (const f of failures) console.error(`::error::fix failed — ${f}`);
    // Re-scan so the reported count is the POST-fix truth, not an assumption
    // that every write landed.
    ({ findings, filesRead } = scan());
    if (failures.length) return 1;
  }

  if (asJson) {
    console.log(JSON.stringify({ filesRead, count: findings.length, findings }, null, 2));
  } else {
    console.log(`Scanned ${filesRead} review file(s).`);
    console.log(`Auto-clear vs ensemble-verdict conflicts: ${findings.length}`);
    for (const f of findings) {
      console.log(`  ${f.path}`);
      console.log(`    ${f.flag} cleared by "${f.breadcrumb}" despite ${f.rejectedBy} -> ${f.kind}`);
      if (f.reasoning) console.log(`    ensemble said: ${f.reasoning}`);
    }
    if (findings.length && !fix) {
      console.log('\nRe-assert them with: node scripts/audit-wrongshow-autoclear-conflicts.js --fix');
    }
  }

  if (strict && findings.length > 0) {
    console.error(`::error::${findings.length} review file(s) have an auto-clear breadcrumb overriding an ensemble rejection. The heuristic must never outrank the ensemble — run --fix, then re-run --strict.`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { scan, applyFix, main, CLASSES, USAGE };
