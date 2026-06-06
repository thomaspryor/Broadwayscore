#!/usr/bin/env node
/**
 * Guard: no push-to-main workflow may silently cancel main commits.
 *
 * Background (the bug this prevents from recurring):
 *   A workflow that triggers on `push: branches: [main]` with a concurrency
 *   `group` keyed only on `github.ref`/`github.workflow` (so EVERY main commit
 *   shares one group) plus `cancel-in-progress: true` will kill the prior run
 *   each time a new commit lands. On a busy trunk that means most commits never
 *   complete validation — and the cancelled-mid-setup runs emit misleading
 *   failures (jsdom, missing shows.json) that send sessions chasing phantom
 *   bugs. test.yml had this for months; it was re-diagnosed almost every day.
 *   Full writeup: memory/feedback_test_yml_cancel_in_progress.md.
 *
 * Rule:
 *   For each workflow triggered on push to main, if its concurrency group
 *   COLLAPSES multiple commits (does not include github.run_id / github.sha /
 *   github.run_number / github.event.head_commit.id), then cancel-in-progress
 *   must NOT be the literal `true`. Allowed:
 *     - `false`
 *     - a conditional expression, e.g. ${{ github.ref != 'refs/heads/main' }}
 *     - literal `true` IFF the concurrency block carries an explicit
 *       `# concurrency-cancel-ok: <reason>` annotation (for idempotent jobs
 *       like search-engine pings where latest-wins is correct).
 *
 * Per-run groups (run_id/sha/etc.) are exempt: they never collapse commits, so
 * cancel-in-progress is a no-op there regardless of value.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const MEMORY_REF = 'memory/feedback_test_yml_cancel_in_progress.md';
// Tokens that make a concurrency group unique per run/commit (so it never collapses commits).
const PER_RUN_TOKENS = ['github.run_id', 'github.run_number', 'github.sha', 'head_commit.id', 'github.run_attempt'];
const ANNOTATION = 'concurrency-cancel-ok';

function triggersOnMainPush(doc) {
  const on = doc && doc.on;
  if (!on || typeof on !== 'object') return false;
  const push = on.push;
  if (!push || typeof push !== 'object') return false;
  const branches = push.branches;
  if (!branches) return false;
  return JSON.stringify(branches).includes('main');
}

function main() {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  const violations = [];

  for (const file of files) {
    const full = path.join(WORKFLOW_DIR, file);
    const raw = fs.readFileSync(full, 'utf8');
    let doc;
    try {
      doc = yaml.load(raw);
    } catch (e) {
      // Don't fail the whole guard on a parse error here — actionlint owns YAML validity.
      continue;
    }
    if (!triggersOnMainPush(doc)) continue;

    const c = doc.concurrency;
    if (!c || typeof c !== 'object') continue; // no concurrency block → nothing to cancel
    const cip = c['cancel-in-progress'];

    // Only the literal boolean `true` is a problem. js-yaml parses an expression
    // string (`${{ ... }}`) as a string, and `false` as boolean false — both pass.
    if (cip !== true) continue;

    const group = String(c.group || '');
    const isPerRun = PER_RUN_TOKENS.some((t) => group.includes(t));
    if (isPerRun) continue; // unique per run → never collapses commits

    // Allow an explicit opt-out annotation in the concurrency block.
    if (raw.includes(ANNOTATION)) continue;

    violations.push({ file, group });
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
