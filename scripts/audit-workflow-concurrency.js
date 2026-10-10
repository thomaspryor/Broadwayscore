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
const {
  loadWorkflows,
  queueEvictionRisks,
  QUEUE_EVICTION_BASELINE,
  QUEUE_OK_ANNOTATION,
} = require('./lib/workflow-dependency-graph.js');

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
  checkQueueEviction(files);
}

function scriptTexts(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== 'node_modules') out.push(...scriptTexts(p));
    } else if (/\.(c?js|mjs|sh)$/.test(ent.name) && !/\.test\./.test(ent.name)) {
      out.push({ file: path.relative(path.join(__dirname, '..'), p), text: fs.readFileSync(p, 'utf8') });
    }
  }
  return out;
}

// BRO-4859: a dispatched workflow on a static group with cancel-in-progress:false
// silently drops all but the newest pending dispatch.
function checkQueueEviction(files) {
  const rawByFile = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')]));
  const risks = queueEvictionRisks(loadWorkflows(WORKFLOW_DIR), rawByFile, scriptTexts(path.join(__dirname)));
  const fresh = risks.filter((r) => !QUEUE_EVICTION_BASELINE.includes(r.file));
  const known = risks.length - fresh.length;
  if (fresh.length) {
    console.error('❌ Dispatched workflow keeps only ONE pending run (BRO-4859).\n');
    console.error(
      'These workflows are dispatched by other workflows/scripts and use a static concurrency\n' +
        'group with cancel-in-progress: false. GitHub holds one pending run per group, so a\n' +
        "dispatch arriving while a run is busy evicts the previous pending one ('cancelled',\n" +
        'never started, no alert) and its inputs are lost.\n'
    );
    for (const r of fresh) console.error(`  • ${r.file}  (group: ${r.group}; dispatched by ${r.dispatchers.join(', ')})`);
    console.error('\nFix one of:');
    console.error('  1. a per-run group (add github.run_id) if runs may overlap; throttle in-job if needed');
    console.error('     (gather-reviews.yml + scripts/wait-for-gather-slot.js is the FIFO pattern)');
    console.error(`  2. if dropping all but the newest pending run is correct (a debounce),\n     add a "# ${QUEUE_OK_ANNOTATION}: <reason>" comment inside the concurrency block.`);
    process.exit(1);
  }
  console.log(`✅ Queue-eviction guard passed (${known} baselined offender(s) still to triage).`);
}

main();
