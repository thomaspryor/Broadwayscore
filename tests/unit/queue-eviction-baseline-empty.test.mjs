// BRO-4870: the queue-eviction baseline (BRO-4859) was triaged to empty. Every
// dispatched workflow on a static one-pending-run concurrency group is now either
// a documented debounce (`# concurrency-queue-ok: <reason>`), partitioned, or was
// a false positive from a printed `gh workflow run` hint. These tests keep it so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  QUEUE_EVICTION_BASELINE,
  dispatchTargetsIn,
  queueEvictionRisks,
  loadWorkflows,
} = require(join(root, 'scripts/lib/workflow-dependency-graph.js'));

const wfDir = join(root, '.github', 'workflows');

function scriptTexts(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== 'node_modules') out.push(...scriptTexts(p));
    } else if (/\.(c?js|mjs|sh)$/.test(ent.name) && !/\.test\./.test(ent.name)) {
      out.push({ file: relative(root, p), text: readFileSync(p, 'utf8') });
    }
  }
  return out;
}

test('queue-eviction baseline is empty (BRO-5509 removed newsletter-draft.yml)', () => {
  assert.deepEqual(QUEUE_EVICTION_BASELINE, []);
});

test('no dispatched workflow in the repo can silently evict a pending run', () => {
  const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
  const raw = Object.fromEntries(files.map((f) => [f, readFileSync(join(wfDir, f), 'utf8')]));
  const risks = queueEvictionRisks(loadWorkflows(wfDir), raw, scriptTexts(join(root, 'scripts')));
  const unlisted = risks.filter((r) => !QUEUE_EVICTION_BASELINE.includes(r.file));
  assert.deepEqual(unlisted.map((r) => `${r.file} <- ${r.dispatchers.join(', ')}`), []);
});

test('printed gh workflow run hints are not dispatches', () => {
  const hints = [
    "hint: 'Run `gh workflow run \"Audit Census Recall\"`'",
    '`::error::apply it: gh workflow run apply-migration.yml -f migration=x -f confirm=APPLY`',
    'console.log(`   gh workflow run "Fetch Aggregator Pages" --field aggregator=all`);',
    "report(WARN, 'DTLI slug', `No mapping found. Run: gh workflow run scrape-dtli-show-score.yml to discover.`);",
    '//   gh workflow run outlet-listing-poller.yml -f lookback_days=365',
    ' *   gh workflow run recover-wayback-reviews.yml -f dry_run=true',
    '`  gh workflow run "Opening Night Broadcast" -f lookback_days=3 -f force_broadcast=true`',
    'echo "   gh workflow run \\"Rebuild Reviews Data\\" -f reason=x"',
    '  # gh workflow run opening-night-express.yml -f show_id=x',
  ];
  for (const h of hints) assert.deepEqual([...dispatchTargetsIn(h)], [], h);
});

test('real dispatches in command position still count', () => {
  const cases = [
    ['execSync(`gh workflow run rebuild-reviews.yml -f reason="x"`, { stdio: "pipe" });', 'rebuild-reviews.yml'],
    ['      `gh workflow run "Rebuild Reviews Data" -f reason="Manual review"`,', 'name:Rebuild Reviews Data'],
    ['          gh workflow run extract-pull-quotes.yml -f chain=true', 'extract-pull-quotes.yml'],
    ['      - run: gh workflow run foo.yml', 'foo.yml'],
    ['  if ! gh workflow run foo.yml -f a=b; then', 'foo.yml'],
    ['  OUT=$(gh workflow run foo.yml 2>&1)', 'foo.yml'],
    ['  x && gh workflow run foo.yml || echo "::warning::failed"', 'foo.yml'],
    ['  timeout 30 gh workflow run foo.yml', 'foo.yml'],
    ["  perl -e 'alarm 30; exec @ARGV' gh workflow run \"Gather Review Data\" -R \"$REPO\" \\", 'name:Gather Review Data'],
    ["spawnSync('gh', ['workflow', 'run', 'autonomous-merge.yml', '-f', 'card_id=1'])", 'autonomous-merge.yml'],
  ];
  for (const [line, want] of cases) assert.deepEqual([...dispatchTargetsIn(line)], [want], line);
});
