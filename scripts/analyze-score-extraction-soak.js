#!/usr/bin/env node
/**
 * Analyze Score Extraction Soak Period
 *
 * Pulls logs from recent "Collect Review Texts" workflow runs,
 * extracts SCORE DIFF entries, and produces a summary report.
 *
 * If the LLM extractor is consistently better (>90% of disagreements
 * favor LLM), outputs SOAK_RESULT=pass for the workflow to proceed
 * with Phase 2c/4b cleanup.
 *
 * Usage:
 *   node scripts/analyze-score-extraction-soak.js [--days=3]
 *
 * Requires: gh CLI authenticated
 */

const { execSync } = require('child_process');

const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '--days=3').split('=')[1]);

const stats = {
  runsAnalyzed: 0,
  totalReviewsCollected: 0,
  scoreDiffs: {
    regexOnlyFound: [],    // regex found, LLM null — potential LLM miss
    llmOnlyFound: [],      // LLM found, regex null — LLM improvement
    bothDisagree: [],      // both found different values
  },
  llmErrors: 0,
};

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || '';
  }
}

console.log(`\n=== Score Extraction Soak Analysis (past ${DAYS} days) ===\n`);

// Get completed collection runs from the past N days
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
const runsJson = run(`gh run list --workflow=collect-review-texts.yml --limit=50 --json databaseId,status,conclusion,createdAt -q '[.[] | select(.conclusion == "success" and .createdAt >= "${since}")]'`);

let runs;
try {
  runs = JSON.parse(runsJson || '[]');
} catch {
  runs = [];
}

console.log(`Found ${runs.length} successful collection runs since ${since.split('T')[0]}\n`);

if (runs.length === 0) {
  console.log('No completed runs found. Need more soak time.');
  console.log('SOAK_RESULT=insufficient_data');
  process.exit(0);
}

// Analyze each run's logs
for (const r of runs) {
  process.stdout.write(`  Analyzing run ${r.databaseId}...`);
  const log = run(`gh run view ${r.databaseId} --log 2>&1`);

  stats.runsAnalyzed++;

  // Count SCORE DIFF entries
  for (const line of log.split('\n')) {
    if (line.includes('SCORE DIFF')) {
      const regexOnlyMatch = line.match(/regex found "([^"]+)" but LLM returned null \[([^\]]+)\]/);
      const llmOnlyMatch = line.match(/LLM found "([^"]+)" \((\d+)\) but regex returned null \[([^\]]+)\]/);
      const bothMatch = line.match(/regex="([^"]+)" vs LLM="([^"]+)" \((\d+)\) \[([^\]]+)\]/);

      if (regexOnlyMatch) {
        stats.scoreDiffs.regexOnlyFound.push({
          score: regexOnlyMatch[1],
          outlet: regexOnlyMatch[2],
          run: r.databaseId
        });
      } else if (llmOnlyMatch) {
        stats.scoreDiffs.llmOnlyFound.push({
          score: llmOnlyMatch[1],
          normalized: parseInt(llmOnlyMatch[2]),
          outlet: llmOnlyMatch[3],
          run: r.databaseId
        });
      } else if (bothMatch) {
        stats.scoreDiffs.bothDisagree.push({
          regex: bothMatch[1],
          llm: bothMatch[2],
          llmNormalized: parseInt(bothMatch[3]),
          outlet: bothMatch[4],
          run: r.databaseId
        });
      }
    }

    if (line.includes('LLM score extraction failed')) {
      stats.llmErrors++;
    }

    // Count collected reviews (rough — look for "Extracted score:" or "Updated review")
    if (line.includes('Extracted score:') || line.includes('Updated review file')) {
      stats.totalReviewsCollected++;
    }
  }

  console.log(' done');
}

// Print report
const { regexOnlyFound, llmOnlyFound, bothDisagree } = stats.scoreDiffs;
const totalDiffs = regexOnlyFound.length + llmOnlyFound.length + bothDisagree.length;

console.log('\n' + '='.repeat(60));
console.log('SOAK PERIOD REPORT');
console.log('='.repeat(60));
console.log(`Runs analyzed: ${stats.runsAnalyzed}`);
console.log(`LLM extraction errors: ${stats.llmErrors}`);
console.log(`\nDisagreements: ${totalDiffs} total`);
console.log(`  Regex found, LLM missed: ${regexOnlyFound.length}`);
console.log(`  LLM found, regex missed: ${llmOnlyFound.length}`);
console.log(`  Both found, values differ: ${bothDisagree.length}`);

if (regexOnlyFound.length > 0) {
  console.log('\n--- Regex found but LLM missed (potential LLM gaps): ---');
  for (const d of regexOnlyFound.slice(0, 20)) {
    console.log(`  ${d.outlet}: "${d.score}"`);
  }
  if (regexOnlyFound.length > 20) console.log(`  ... and ${regexOnlyFound.length - 20} more`);
}

if (llmOnlyFound.length > 0) {
  console.log('\n--- LLM found but regex missed (LLM improvements): ---');
  for (const d of llmOnlyFound.slice(0, 20)) {
    console.log(`  ${d.outlet}: "${d.score}" (${d.normalized})`);
  }
  if (llmOnlyFound.length > 20) console.log(`  ... and ${llmOnlyFound.length - 20} more`);
}

if (bothDisagree.length > 0) {
  console.log('\n--- Both found, different values: ---');
  for (const d of bothDisagree.slice(0, 20)) {
    console.log(`  ${d.outlet}: regex="${d.regex}" vs LLM="${d.llm}" (${d.llmNormalized})`);
  }
  if (bothDisagree.length > 20) console.log(`  ... and ${bothDisagree.length - 20} more`);
}

// Decision
console.log('\n' + '='.repeat(60));
console.log('DECISION');
console.log('='.repeat(60));

if (totalDiffs === 0 && stats.runsAnalyzed >= 3) {
  console.log('No disagreements found. LLM and regex agree on everything.');
  console.log('Safe to remove regex path.');
  console.log('\nSOAK_RESULT=pass');
} else if (totalDiffs === 0 && stats.runsAnalyzed < 3) {
  console.log(`Only ${stats.runsAnalyzed} runs analyzed — need at least 3 for confidence.`);
  console.log('\nSOAK_RESULT=insufficient_data');
} else {
  const llmWins = llmOnlyFound.length;
  const regexWins = regexOnlyFound.length;
  const total = llmWins + regexWins + bothDisagree.length;
  const llmWinRate = total > 0 ? ((llmWins / total) * 100).toFixed(1) : 0;
  const regexWinRate = total > 0 ? ((regexWins / total) * 100).toFixed(1) : 0;

  console.log(`LLM found scores regex missed: ${llmWins} (${llmWinRate}%)`);
  console.log(`Regex found scores LLM missed: ${regexWins} (${regexWinRate}%)`);
  console.log(`Both disagree: ${bothDisagree.length}`);

  if (regexWins === 0 || (llmWins / (llmWins + regexWins)) >= 0.9) {
    console.log('\nLLM is consistently better. Safe to remove regex path.');
    console.log('\nSOAK_RESULT=pass');
  } else {
    console.log('\nRegex found some scores LLM missed. Review before removing.');
    console.log('\nSOAK_RESULT=review_needed');
  }
}
