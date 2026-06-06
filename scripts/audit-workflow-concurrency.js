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
 *   github.run_number / github.run_attempt / head_commit.id), then
 *   cancel-in-progress must NOT be the literal `true`. Allowed:
 *     - `false`
 *     - a conditional expression, e.g. ${{ github.ref != 'refs/heads/main' }}
 *     - literal `true` IFF the concurrency block carries an explicit
 *       `# concurrency-cancel-ok: <reason>` annotation (for idempotent jobs
 *       like search-engine pings where latest-wins is correct).
 *
 * Per-run groups (run_id/sha/etc.) are exempt: they never collapse commits, so
 * cancel-in-progress is a no-op there regardless of value.
 *
 * No external deps (js-yaml is NOT installed in test.yml's lint-workflows job —
 * it runs setup-node but no `npm ci`). Parsed with an indentation-aware reader,
 * same approach as scripts/audit-cron-health-coverage.js.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const MEMORY_REF = 'memory/feedback_test_yml_cancel_in_progress.md';
const PER_RUN_TOKENS = ['github.run_id', 'github.run_number', 'github.sha', 'github.run_attempt', 'head_commit.id'];
const ANNOTATION = 'concurrency-cancel-ok';

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;
const stripComment = (s) => s.replace(/\s+#.*$/, '').trim();

// Lines (excluding blanks/comments) strictly more indented than the header at startIdx.
function childLines(lines, startIdx) {
  const headerIndent = indentOf(lines[startIdx]);
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= headerIndent) break;
    out.push(line);
  }
  return out;
}

function triggersOnMainPush(raw) {
  const lines = raw.split('\n');
  // Top-level `on:` (indent 0). Accept `on:` and `'on':`.
  const onIdx = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l) && indentOf(l) === 0);
  if (onIdx === -1) return false;
  const onChildIdxs = [];
  const onIndent = indentOf(lines[onIdx]);
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '' || lines[i].trim().startsWith('#')) continue;
    if (indentOf(lines[i]) <= onIndent) break;
    onChildIdxs.push(i);
  }
  // `push:` directly under `on:`.
  const pushIdx = onChildIdxs.find((i) => /^\s*push\s*:/.test(lines[i]));
  if (pushIdx === undefined) return false;
  const pushKids = childLines(lines, pushIdx);
  // Find the `branches:` entry inside the push block and check it lists main.
  for (let j = 0; j < pushKids.length; j++) {
    const t = stripComment(pushKids[j]);
    const inline = t.match(/^branches\s*:\s*(.+)$/);
    if (inline) {
      // e.g. branches: [main]  or  branches: [main, release]
      return /\bmain\b/.test(inline[1]);
    }
    if (/^branches\s*:\s*$/.test(t)) {
      // list form: subsequent `- main` items, more indented than this branches: line
      const absIdx = lines.indexOf(pushKids[j]);
      for (const item of childLines(lines, absIdx)) {
        if (/^\s*-\s*['"]?main['"]?\s*$/.test(stripComment(item))) return true;
      }
      return false;
    }
  }
  return false;
}

function readConcurrency(raw) {
  const lines = raw.split('\n');
  const cIdx = lines.findIndex((l) => /^concurrency\s*:/.test(l) && indentOf(l) === 0);
  if (cIdx === -1) return null;
  const kids = childLines(lines, cIdx);
  let group = '';
  let cancelRaw = null;
  // blockText must include comment lines so the `# concurrency-cancel-ok:` annotation
  // is visible — childLines() strips comments, so rebuild the raw indented slice here.
  const blockRaw = [lines[cIdx]];
  for (let i = cIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { blockRaw.push(lines[i]); continue; }
    if (indentOf(lines[i]) <= 0 && !lines[i].trim().startsWith('#')) break;
    blockRaw.push(lines[i]);
  }
  const blockText = blockRaw.join('\n');
  for (const k of kids) {
    const g = k.match(/^\s*group\s*:\s*(.+)$/);
    if (g) group = g[1].trim();
    const c = stripComment(k).match(/^cancel-in-progress\s*:\s*(.+)$/);
    if (c) cancelRaw = c[1].trim();
  }
  return { group, cancelRaw, blockText };
}

function main() {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  const violations = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    if (!triggersOnMainPush(raw)) continue;

    const c = readConcurrency(raw);
    if (!c) continue; // no concurrency block → nothing cancels

    // Only the literal `true` is a problem. `false` and a `${{ ... }}` expression pass.
    if (c.cancelRaw !== 'true') continue;

    const isPerRun = PER_RUN_TOKENS.some((t) => c.group.includes(t));
    if (isPerRun) continue; // unique per run → never collapses commits

    // Explicit opt-out annotation inside the concurrency block.
    if (c.blockText.includes(ANNOTATION)) continue;

    violations.push({ file, group: c.group });
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
