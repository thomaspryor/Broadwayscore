// BRO-6532: every dispatch of a capped bulk workflow (CAPS in
// workflow-queue-cap.js) must go through the cap, or be listed in BASELINE
// with the reason it may skip it. A new dispatch site fails this test.
// Own baseline, so it can block from day one (CLAUDE.md §19).
//
// A file passes outright when it references workflow-queue-cap or
// capped-workflow-dispatch. Otherwise each (file, workflow) pair may have at
// most BASELINE[...].count matching lines. Matches are keyed by file and
// workflow, not line number, so unrelated edits never churn the baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { CAPS, WORKFLOW_DISPLAY_NAMES: NAMES } = require('./workflow-queue-cap.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const alt = [...Object.keys(CAPS), ...Object.keys(NAMES)].map(esc).join('|');
// gh CLI (file or display name), the shell retry helper, the REST path,
// execFile arg arrays, dispatchWorkflow({ workflow: ... }) / remediation
// { workflow: ... } objects and github-script createWorkflowDispatch({ workflow_id }).
// Not visible to it: a workflow held in a constant. Today those are opening-night
// Express (express-preemption.js), single feedback requests (content-request-routing.js)
// and ingest-downstream.js, whose only dispatcher is the capped dispatchDownstream.
const DISPATCH_RE = new RegExp(
  `(?:workflow\\s+run\\s+["']?|dispatch_with_retry\\s+["']?|actions/workflows/|['"]workflow['"],\\s*['"]run['"],\\s*['"]|workflow(?:_id)?:\\s*['"])(${alt})`,
);
const USES_CAP_RE = /workflow-queue-cap|capped-workflow-dispatch/;

/** Matching dispatch lines in one file's text: [{ line, workflow }]. */
function findDispatches(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    const t = l.trim();
    if (/^(#|\/\/|\*|\/\*)/.test(t) || /^(echo|console\.|log\(|printf)/.test(t)) return;
    const m = l.match(DISPATCH_RE);
    // `actions/workflows/<wf>/runs` reads runs; it does not dispatch.
    if (m && !/^[^\s'"`]*\/runs\b/.test(l.slice(l.indexOf(m[1]) + m[1].length))) out.push({ line: i + 1, workflow: NAMES[m[1]] || m[1] });
  });
  return out;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '__fixtures__'].includes(e.name)) walk(p, out); }
    else if (/\.(js|mjs|cjs|ts|sh|yml)$/.test(e.name) && !/\.test\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const ENS = 'llm-ensemble-score.yml';
const GATHER = 'gather-reviews.yml';
const HINT = 'hint text shown to a person, not a dispatch';
const ON = 'opening-night work: exempt from the cap by design';
const BASELINE = {
  [`scripts/audit-opening-night-coverage.js|${GATHER}`]: { count: 1, reason: ON },
  [`scripts/lib/dispatch-rescore.js|${ENS}`]: { count: 1, reason: 'single targeted show_id rescore (verify-all-scored, orphan requeue, t1 silent gaps), each with its own per-show cooldown' },
  [`scripts/lib/opening-night-checks/aggregator-count-drift.check.js|${GATHER}`]: { count: 1, reason: ON },
  [`scripts/lib/opening-night-checks/t1-outlets-scored.check.js|${GATHER}`]: { count: 1, reason: ON },
  [`scripts/dispatch-orphan-rescore-requeue.js|${ENS}`]: { count: 1, reason: HINT },
  [`scripts/ingest-urls.js|${ENS}`]: { count: 1, reason: HINT },
  [`scripts/lib/health-digest-crons.js|${ENS}`]: { count: 1, reason: 'cron-health config entry, not a dispatch' },
  [`scripts/lib/t1-digest.js|${GATHER}`]: { count: 1, reason: HINT },
  [`.github/workflows/bulk-collect-review-texts.yml|${ENS}`]: { count: 1, reason: 'one plain dispatch per round; plain dispatches score urgent shows only (BRO-5047)' },
  [`.github/workflows/collect-review-texts.yml|${ENS}`]: { count: 1, reason: 'one plain dispatch per run; plain dispatches score urgent shows only (BRO-5047)' },
  [`.github/workflows/gather-reviews.yml|${ENS}`]: { count: 1, reason: 'skipped when any ensemble run is active' },
  [`.github/workflows/gather-reviews.yml|${GATHER}`]: { count: 1, reason: 'one re-dispatch of shows this run deferred; held by the 2-slot gather gate' },
  [`.github/workflows/llm-ensemble-score.yml|${ENS}`]: { count: 1, reason: 'self-chain, one successor at a time' },
  [`scripts/audit-t1-silent-gaps.js|${ENS}`]: { count: 1, reason: HINT },
  [`scripts/backfill-gather-all.sh|${GATHER}`]: { count: 1, reason: 'retired Mac backfill; one batch at a time, waits for each run to finish' },
  [`scripts/backfill-gather-batch.sh|${GATHER}`]: { count: 1, reason: 'retired Mac backfill; gather-reviews.yml skips its no_sb_serp dispatches (BRO-4146)' },
  [`.github/workflows/discover-historical-shows.yml|${GATHER}`]: { count: 1, reason: 'one dispatch per discovery run' },
  [`.github/workflows/poll-loureviews.yml|${ENS}`]: { count: 1, reason: 'one plain fast_rebuild dispatch; plain dispatches score urgent shows only (BRO-5047)' },
  [`.github/workflows/review-refresh.yml|${GATHER}`]: { count: 2, reason: 'daily; one run per 10 shows with genuinely new reviews plus one routine batch, held by the 2-slot gather gate' },
  [`.github/workflows/opening-night-broadcast.yml|${GATHER}`]: { count: 1, reason: ON },
  [`.github/workflows/opening-night-reviews.yml|${GATHER}`]: { count: 2, reason: ON },
  [`.github/workflows/rebuild-reviews.yml|${ENS}`]: { count: 1, reason: 'self-heal, only when no ensemble run is active' },
  [`.github/workflows/scrape-new-aggregators.yml|${GATHER}`]: { count: 1, reason: 'one weekly dispatch' },
  [`.github/workflows/update-show-status.yml|${GATHER}`]: { count: 2, reason: 'one dispatch each for shows that opened today (opening night)' },
};

function scanRepo() {
  const files = [...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, '.github/workflows'))];
  const uncapped = {};
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (USES_CAP_RE.test(text)) continue;
    for (const d of findDispatches(text)) {
      const key = `${path.relative(ROOT, f)}|${d.workflow}`;
      (uncapped[key] ??= []).push(d.line);
    }
  }
  return uncapped;
}

test('scanner flags every dispatch form and skips run reads, comments and echo lines', () => {
  const sample = [
    'gh workflow run gather-reviews.yml -f shows=x',
    '  dispatch_with_retry ingest-urls.yml -f show_id=x',
    "execFileSync('gh', ['workflow','run','gather-reviews.yml', '-f', 'x'])",
    "dispatchWorkflow({ workflow: 'llm-ensemble-score.yml', inputs })",
    'gh api repos/o/r/actions/workflows/ingest-urls.yml/dispatches -f ref=main',
    'gh api repos/o/r/actions/workflows/ingest-urls.yml/runs?status=queued',
    '# gh workflow run gather-reviews.yml',
    'echo "gh workflow run gather-reviews.yml"',
    'gh workflow run land.yml',
    "  workflow_id: 'gather-reviews.yml',",
    'gh workflow run "LLM Ensemble Score Reviews" -f show_id=x',
  ].join('\n');
  const found = findDispatches(sample);
  assert.deepEqual(found.map((d) => d.line), [1, 2, 3, 4, 5, 10, 11]);
  assert.equal(found[6].workflow, 'llm-ensemble-score.yml');
});

test('every bulk-workflow dispatch uses the cap or is in the reasoned baseline', () => {
  const uncapped = scanRepo();
  const problems = [];
  for (const [key, lines] of Object.entries(uncapped)) {
    const allowed = BASELINE[key]?.count ?? 0;
    if (lines.length > allowed) {
      problems.push(`${key.replace('|', ' dispatches ')} at line(s) ${lines.join(', ')} (baseline allows ${allowed})`);
    }
  }
  const total = Object.values(uncapped).reduce((n, l) => n + l.length, 0);
  console.log(`workflow-queue-cap coverage: ${total} uncapped bulk dispatch sites, all in the reasoned baseline`);
  assert.deepEqual(problems, [], 'New dispatch of a capped bulk workflow. Route it through '
    + 'scripts/capped-workflow-dispatch.js (or checkCap from scripts/lib/workflow-queue-cap.js), '
    + 'or add it to BASELINE in this file with the reason it may skip the cap.\n  ' + problems.join('\n  '));
});

test('baseline entries still exist (remove them when a site is capped or deleted)', () => {
  const uncapped = scanRepo();
  const stale = Object.keys(BASELINE).filter((k) => !uncapped[k]);
  assert.deepEqual(stale, []);
});

test('the per-show ingest downstream and the backfill go through the cap', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/lib/land-ingested-reviews.js'), 'utf8'), /checkCap/);
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/historical-backfill.yml'), 'utf8'), /capped-workflow-dispatch\.js --workflow=gather-reviews\.yml/);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/audit-show-review-gap.js'), 'utf8'), /checkCap\(\{ workflow: 'gather-reviews\.yml'/);
});
