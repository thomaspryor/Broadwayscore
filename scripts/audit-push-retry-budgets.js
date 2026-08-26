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
const { auditWorkflowText, countRawCallSites } = require('./lib/audit-push-retry-budgets.js');

const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const topArg = args.find((a) => a.startsWith('--top='));
  const topN = topArg ? parseInt(topArg.split('=')[1], 10) : 15;

  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

  let allResults = [];
  let filesWithPushCalls = 0;
  // Completeness cross-check (ship-check adversarial review finding, card
  // #1910): parseWorkflow never throws on a YAML shape it can't handle — it
  // silently returns fewer/no steps, which would make the structured audit
  // quietly under-count real push-with-retry.sh call sites with no error
  // signal. Compare against a coarse whole-file raw count per file and warn
  // on any file where the structured parse found FEWER calls than the raw
  // scan — that's the "audit silently skipped a real caller" failure mode.
  const underParsedFiles = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
    const results = auditWorkflowText(text, file);
    if (results.length > 0) filesWithPushCalls++;
    const rawCount = countRawCallSites(text);
    if (results.length < rawCount) underParsedFiles.push({ file, parsed: results.length, raw: rawCount });
    allResults = allResults.concat(results);
  }

  const flagged = allResults.filter((r) => r.flags.length > 0);
  const ranked = [...flagged].sort((a, b) => b.contentionScore - a.contentionScore);
  const mixedBundles = flagged.filter((r) => r.mixedSafetyBundle);

  if (jsonOut) {
    console.log(JSON.stringify({ totalFiles: files.length, filesWithPushCalls, totalCalls: allResults.length, flaggedCount: flagged.length, mixedSafetyBundleCount: mixedBundles.length, underParsedFiles, ranked }, null, 2));
    return;
  }

  console.log(`Scanned ${files.length} workflow files, ${filesWithPushCalls} with push-with-retry.sh calls (${allResults.length} total call sites).`);
  console.log(`${flagged.length} flagged (retries-undersized-vs-deadline and/or job-timeout-margin-undersized and/or mixed-safety-bundle).\n`);

  if (underParsedFiles.length > 0) {
    console.log(`⚠️  ${underParsedFiles.length} file(s) may have UNDER-PARSED push-with-retry.sh calls (structured parse found fewer than a raw text scan — verify by hand):`);
    for (const u of underParsedFiles) console.log(`     ${u.file}: parsed=${u.parsed} raw=${u.raw}`);
    console.log('');
  }

  // mixed-safety-bundle (BRO-2446): surfaced in its OWN section, separate from
  // the contentionScore ranking below — this is a structural "split this step"
  // fix (the BRO-2435 pattern), not a sizing tweak, so it needs a fix pass of
  // its own regardless of where contentionScore happens to rank it.
  if (mixedBundles.length > 0) {
    console.log(`🔀 ${mixedBundles.length} call site(s) bundle an apiFallbackSafe file with a disqualifying (unaudited/multi-writer) file in the SAME commit+push — this defeats the Git Data API fallback for BOTH, exactly the BRO-2435 failure shape:\n`);
    for (const r of mixedBundles) {
      console.log(`  ${r.file} :: ${r.job} / "${r.step}"`);
      console.log(`      apiFallbackSafe file(s) losing their fallback: ${r.mixedSafetyBundleSafeFiles.join(', ')}`);
      console.log(`      bundled with disqualifying file(s):            ${r.mixedSafetyBundleDisqualifyingFiles.join(', ')}`);
      console.log('      fix: split into separate git-add-existing.sh + push-with-retry.sh calls (see opening-night-broadcast.yml\'s "Commit orphan-rescore-requeue state" step for the reference pattern)\n');
    }
  }

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
  // Advisory-only (card #1918 CI wiring) means "never fails the gate" — that
  // promise only holds on the happy path. Same guard as
  // scripts/audit-push-core-data-audit-gap.js: an unreadable workflow file or
  // an unexpected parsed-shape edge case would otherwise crash main() with a
  // nonzero exit, silently turning this into an accidental hard gate on
  // lint-workflows (main's CI signal).
  try {
    main();
  } catch (err) {
    console.log(`ℹ️  push-retry budget audit crashed (advisory, not failing CI): ${err.message}`);
  }
}

module.exports = { main };
