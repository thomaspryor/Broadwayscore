#!/usr/bin/env node
// scripts/audit-push-retry-budgets.js — CLI wrapper for scripts/lib/audit-
// push-retry-budgets.js (card #1910, 2026-08-26). Scans every workflow under
// .github/workflows/*.yml for push-with-retry.sh invocations, flags the two
// undersizing patterns behind task #1842 and card #1891 (retries exhausting
// long before the deadline; the job-timeout-margin squeeze #1891's
// adversarial follow-up caught on rebuild-reviews.yml), and ranks flagged
// steps by a contention score so a fix pass targets real collision risk
// first instead of blanket-raising all ~150 call sites.
//
// Usage:
//   node scripts/audit-push-retry-budgets.js            # full report
//   node scripts/audit-push-retry-budgets.js --json      # machine-readable
//   node scripts/audit-push-retry-budgets.js --top=10    # limit ranked list (default 15)
'use strict';

const fs = require('fs');
const path = require('path');
const { auditWorkflowText } = require('./lib/audit-push-retry-budgets.js');

const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const topArg = args.find((a) => a.startsWith('--top='));
  const topN = topArg ? parseInt(topArg.split('=')[1], 10) : 15;

  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

  let allResults = [];
  let filesWithPushCalls = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
    const results = auditWorkflowText(text, file);
    if (results.length > 0) filesWithPushCalls++;
    allResults = allResults.concat(results);
  }

  const flagged = allResults.filter((r) => r.flags.length > 0);
  const ranked = [...flagged].sort((a, b) => b.contentionScore - a.contentionScore);

  if (jsonOut) {
    console.log(JSON.stringify({ totalFiles: files.length, filesWithPushCalls, totalCalls: allResults.length, flaggedCount: flagged.length, ranked }, null, 2));
    return;
  }

  console.log(`Scanned ${files.length} workflow files, ${filesWithPushCalls} with push-with-retry.sh calls (${allResults.length} total call sites).`);
  console.log(`${flagged.length} flagged (retries-undersized-vs-deadline and/or job-timeout-margin-undersized).\n`);

  console.log(`Top ${Math.min(topN, ranked.length)} by contention score (managed-file writes + cron frequency + severity):\n`);
  for (const r of ranked.slice(0, topN)) {
    const flagStr = r.flags.join(', ');
    console.log(`  [score ${r.contentionScore}] ${r.file} :: ${r.job} / "${r.step}"`);
    console.log(`      retries=${r.maxRetries} deadline=${r.deadlineSec}s backoffSum=${r.backoffSum}s ratio=${r.retryDeadlineRatio.toFixed(2)}`);
    console.log(`      jobTimeout=${r.jobTimeoutSec}s stepBudget=${r.stepBudgetSec}s otherSteps=${r.otherStepsBudgetSec}s margin=${r.marginSec}s (${(r.marginRatio * 100).toFixed(1)}%)`);
    console.log(`      managedFile=${r.touchesManagedFile}${r.touchesManagedFile ? ` (apiFallbackSafe=${r.apiFallbackSafe})` : ''} cronInterval=${r.cronIntervalMinutes ?? 'n/a'}min softFail=${r.softFail} flags=[${flagStr}]\n`);
  }

  if (ranked.length > topN) {
    console.log(`... ${ranked.length - topN} more flagged call sites not shown (--top=N to widen, --json for the full list).`);
  }

  const retryOnlyCount = flagged.filter((r) => r.flags.length === 1 && r.flags[0] === 'retries-undersized-vs-deadline').length;
  console.log(`\n${retryOnlyCount} of ${flagged.length} flagged sites are retries-undersized-vs-deadline ONLY (the shared-default 7/240s shape) — most are low contentionScore and not worth individually fixing; see card #1910's scope note on prioritizing by actual contention over blanket-raising every call site.`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
