/**
 * BRO-5047 (owner decision 2026-10-11): catch-up scoring waits for the
 * half-price batch runs; opening-night scoring stays immediate.
 *
 * Unit tests require the real functions (CLAUDE.md rule 15). The wiring tests
 * read the workflow and index.ts so a refactor that drops a piece fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const { urgentScoringShowIds, isPlainBacklogDispatch } = require(path.join(REPO, 'scripts/lib/scoring-lane.js'));
const { countScoringQueues } = require(path.join(REPO, 'scripts/lib/scoring-queue-counts.js'));

const NOW = new Date('2026-10-11T12:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);

test('isPlainBacklogDispatch: only a bare workflow_dispatch is catch-up', () => {
  const plain = { eventName: 'workflow_dispatch', showId: '', rescoreReason: '', forceRun: 'false', sync: 'false', vars: {} };
  assert.strictEqual(isPlainBacklogDispatch(plain), true);
  assert.strictEqual(isPlainBacklogDispatch({ ...plain, eventName: 'schedule' }), false, 'crons are the batch runs themselves');
  assert.strictEqual(isPlainBacklogDispatch({ ...plain, showId: 'hamilton-2015' }), false, 'a named show is urgent');
  assert.strictEqual(isPlainBacklogDispatch({ ...plain, rescoreReason: 'orphan-x' }), false);
  assert.strictEqual(isPlainBacklogDispatch({ ...plain, forceRun: 'true' }), false, 'action flags (needs_rescore, outdated...) keep today\'s behavior');
  assert.strictEqual(isPlainBacklogDispatch({ ...plain, sync: 'true' }), false, 'human escape hatch');
  assert.strictEqual(isPlainBacklogDispatch({ ...plain, vars: { DISABLE_BACKLOG_BATCH: '1' } }), false, 'kill switch');
  assert.strictEqual(isPlainBacklogDispatch({ ...plain, vars: { DISABLE_BATCH_SCORING: '1' } }), false, 'no batch lane to wait for');
  assert.strictEqual(isPlainBacklogDispatch({}), false);
});

test('urgentScoringShowIds: opening-window shows in, old and far-future shows out', () => {
  const shows = [
    { id: 'opened-2d', category: 'broadway', status: 'open', openingDate: day(-2) },
    { id: 'opens-in-2d', category: 'broadway', status: 'previews', openingDate: day(2) },
    { id: 'opened-60d', category: 'broadway', status: 'open', openingDate: day(-60) },
    { id: 'opens-in-30d', category: 'broadway', status: 'previews', openingDate: day(30) },
    { id: 'ob-cold-open', category: 'off-broadway', status: 'open', openingDate: null, previewsStartDate: day(-3) },
    { id: 'no-date-but-reviews', category: 'broadway', status: 'open', openingDate: null },
  ];
  const evidence = { 'no-date-but-reviews': { latest: day(-1), items: [{}] } };
  const ids = urgentScoringShowIds(shows, { now: NOW, evidence });
  for (const id of ['opened-2d', 'opens-in-2d', 'ob-cold-open', 'no-date-but-reviews']) assert.ok(ids.has(id), `${id} must be urgent`);
  for (const id of ['opened-60d', 'opens-in-30d']) assert.ok(!ids.has(id), `${id} is catch-up`);
  assert.strictEqual(urgentScoringShowIds(null, { now: NOW }).size, 0);
});

test('countScoringQueues onlyShowIds counts only those show directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-'));
  for (const s of ['a', 'b']) {
    fs.mkdirSync(path.join(dir, s));
    fs.writeFileSync(path.join(dir, s, 'x.json'), JSON.stringify({ showId: s, outletId: 'x', fullText: 'word '.repeat(400) }));
  }
  const all = countScoringQueues(dir, {});
  const onlyA = countScoringQueues(dir, { onlyShowIds: new Set(['a']) });
  assert.strictEqual(all.scanned, 2);
  assert.strictEqual(onlyA.scanned, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('workflow: four batch runs, catch-up dispatches gated to urgent work, once-a-day extras stay daily', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github/workflows/llm-ensemble-score.yml'), 'utf8');
  for (const c of ["'30 4 * * *'", "'30 10 * * *'", "'30 16 * * *'", "'30 22 * * *'"]) assert.ok(yml.includes(`- cron: ${c}`), `missing cron ${c}`);
  assert.match(yml, /node scripts\/lib\/scoring-lane\.js\)/, 'check-needed must ask scoring-lane.js');
  assert.match(yml, /count-scoring-queue\.js --github-output --require-shows --urgent-only/);
  assert.match(yml, /only_urgent \}\} *" == "true" \]; then\s+ARGS="\$ARGS --only-urgent"/);
  assert.match(yml, /Drain needsRescore backlog[\s\S]{0,80}if: github\.event\.schedule == '30 4 \* \* \*'/);
  assert.match(yml, /Snapshot progress-watch state\s+if: always\(\) && github\.event\.schedule == '30 4 \* \* \*'/);
  assert.match(yml, /github\.event\.schedule \}\}" == "30 4 \* \* \*" \] && \[ "\$DOW" == "7" \]/, 'Sunday calibration once a day');
  const chain = yml.slice(yml.indexOf('- name: Chain next batch'), yml.indexOf('- name: Chain next batch') + 1200);
  assert.ok(chain.includes('github.event.inputs.rescore_reason ||') && chain.includes("vars.DISABLE_BACKLOG_BATCH == '1'"),
    'plain chains must not re-dispatch at full price');
  // A skipped catch-up dispatch never runs "Count remaining"; every fromJSON()
  // of its output must be guarded or the expression errors and fails the run.
  const reads = yml.match(/fromJSON\(steps\.count-remaining\.outputs\.remaining\)/g) || [];
  const guarded = yml.match(/steps\.count-remaining\.outputs\.remaining != ''\s*\n\s*&& \(fromJSON\(steps\.count-remaining\.outputs\.remaining\)/g) || [];
  assert.ok(reads.length > 0 && reads.length === guarded.length, `unguarded fromJSON reads: ${reads.length - guarded.length}`);
});

test('index.ts: urgent shows never batched; held files dropped before the limit; mixed-rate cost', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/llm-scoring/index.ts'), 'utf8');
  assert.ok(src.includes("onlyUrgent: args.includes('--only-urgent')"));
  assert.ok(src.includes('if (batchMode && !urgentShowIds.has(reviewFile.showId))'));
  const held = src.indexOf('heldBeforeSlice.has(f.path)');
  const slice = src.indexOf('shardedFiles.slice(0, options.limit)');
  assert.ok(held > 0 && slice > held, 'held batch files must be removed before the limit slice');
  assert.ok(src.includes('__mixedCostBreakdown(usageForCost, syncUsageInBatchRun'));
  // Manifests store repo-relative paths; selection uses absolute ones. Both
  // hold checks must resolve first or nothing is ever held (found in testing).
  assert.ok(src.includes('followUp.holdPaths.map(manifestAbsPath)'));
  assert.ok(src.includes('.map((m: any) => manifestAbsPath(m.filePath))'));
});
