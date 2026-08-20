#!/usr/bin/env node
/**
 * Guard: no push-to-main workflow may silently cancel main commits.
 *
 * Decision logic lives in scripts/lib/ci-cancellation-guard.js (extracted so
 * tests/unit/ci-cancellation-logic.test.mjs can require() it directly instead
 * of re-deriving the parsing rules). This file just walks .github/workflows/
 * and reports violations.
 *
 * See scripts/lib/ci-cancellation-guard.js for the full rule writeup and
 * memory/feedback_test_yml_cancel_in_progress.md for the incident history.
 */
const fs = require('fs');
const path = require('path');
const { findConcurrencyViolation, ANNOTATION } = require('./lib/ci-cancellation-guard.js');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const MEMORY_REF = 'memory/feedback_test_yml_cancel_in_progress.md';

function main() {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  const violations = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    const violation = findConcurrencyViolation(raw);
    if (violation) violations.push({ file, group: violation.group });
  }

  if (violations.length) {
    console.error('❌ Workflow concurrency guard failed.\n');
    console.error(
      'These workflows trigger on push to main, share one concurrency group across\n' +
        'all commits, AND have cancel-in-progress: true — so each new commit cancels the\n' +
        "prior run mid-flight and most main commits never finish validating.\n"
    );
    for (const v of violations) {
      console.error(`  • ${v.file}  (group: ${v.group || '<none>'})`);
    }
    console.error('\nFix one of:');
    console.error("  1. cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}   (cancel PRs only — preferred)");
    console.error('  2. cancel-in-progress: false');
    console.error('  3. make the group unique per run (add github.run_id) if parallel runs are fine');
    console.error(
      `  4. if latest-wins cancellation on main is genuinely correct (idempotent job),\n` +
        `     add a "# ${ANNOTATION}: <reason>" comment inside the concurrency block.`
    );
    console.error(`\nWhy this matters: ${MEMORY_REF}`);
    process.exit(1);
  }

  console.log(`✅ Workflow concurrency guard passed (${files.length} workflows checked).`);
}

main();
