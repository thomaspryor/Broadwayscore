// Rule (k): a scoring step's batch poll budget must be SMALLER than the
// `timeout-minutes:` box around it.
//
// Regression origin (2026-08-29..31): opening-night-poller.yml's "Score reviews
// inline" step had `timeout-minutes: 10` while scripts/llm-scoring/index.ts
// resolved a 20-minute poll budget for it. index.ts drains an in-flight vendor
// batch at the start of EVERY invocation, so on any run with a batch in flight
// the drain could never reach its own clean "still in flight" return — Actions
// killed the step at 10 minutes, the step's $GITHUB_OUTPUT counters were never
// written, and the pipeline gate read the missing counters as
// "score: all 1 failed", paging the owner on runs whose gather, collect,
// rebuild and deploy had all succeeded.
//
// Per CLAUDE.md §15 this requires the REAL rule function rather than restating
// its logic, so a change to the production code fails this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findShortBatchPollTimeoutSteps,
  BATCH_MODE_POLL_MINUTES,
  INLINE_POLL_MINUTES,
} = require('../../scripts/audit-workflow-hygiene.js');

const wf = (body) => `name: t\njobs:\n  j:\n    steps:\n${body}`;

test('flags the exact 2026-08-29 regression: 20min budget inside a 10min step', () => {
  const hits = findShortBatchPollTimeoutSteps(
    wf(
      '      - name: Score reviews inline\n' +
        '        run: |\n' +
        '          npx ts-node scripts/llm-scoring/index.ts --show="$S" --ensemble --batch --batch-poll-minutes=20\n' +
        '        timeout-minutes: 10\n'
    )
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].budgetMin, 20);
  assert.equal(hits[0].timeoutMin, 10);
  assert.equal(hits[0].explicit, true);
});

test('accepts a budget that fits inside the step timeout', () => {
  const hits = findShortBatchPollTimeoutSteps(
    wf(
      '      - name: Score reviews inline\n' +
        '        run: |\n' +
        '          npx ts-node scripts/llm-scoring/index.ts --ensemble --batch --batch-poll-minutes=5\n' +
        '        timeout-minutes: 10\n'
    )
  );
  assert.equal(hits.length, 0);
});

// The bypass the devil's-advocate reviewer called out: if a deleted flag simply
// skipped the check, the likeliest future edit would silently disarm the guard.
// Absence must fall back to the same mode-aware default index.ts uses.
test('a MISSING flag falls back to the mode default, it does not skip the check', () => {
  const batch = findShortBatchPollTimeoutSteps(
    wf(
      '      - name: Score\n' +
        '        run: npx ts-node scripts/llm-scoring/index.ts --ensemble --batch\n' +
        '        timeout-minutes: 10\n'
    )
  );
  assert.equal(batch.length, 1, '--batch with no flag must resolve to the batch-mode default');
  assert.equal(batch[0].budgetMin, BATCH_MODE_POLL_MINUTES);
  assert.equal(batch[0].explicit, false);

  const inline = findShortBatchPollTimeoutSteps(
    wf(
      '      - name: Score\n' +
        '        run: npx ts-node scripts/llm-scoring/index.ts --show=x --ensemble\n' +
        '        timeout-minutes: 10\n'
    )
  );
  assert.equal(inline.length, 0, 'inline callers default to 0 and are always safe');
});

test('ignores steps that do not run the scorer, and commented-out invocations', () => {
  assert.equal(
    findShortBatchPollTimeoutSteps(
      wf('      - name: Something else\n        run: npm ci\n        timeout-minutes: 1\n')
    ).length,
    0
  );
  assert.equal(
    findShortBatchPollTimeoutSteps(
      wf(
        '      - name: Score\n' +
          '        run: |\n' +
          '          # npx ts-node scripts/llm-scoring/index.ts --batch --batch-poll-minutes=20\n' +
          '          echo noop\n' +
          '        timeout-minutes: 10\n'
      )
    ).length,
    0,
    'a commented-out invocation is not a real one'
  );
});

// The constants are duplicated into the JS gate because it cannot import a TS
// module. Assert they still match index.ts so the two cannot drift apart —
// drift would make the gate check a budget the scorer no longer uses.
test('gate constants still match scripts/llm-scoring/index.ts', () => {
  const src = readFileSync(new URL('../../scripts/llm-scoring/index.ts', import.meta.url), 'utf8');
  const batch = src.match(/const BATCH_MODE_POLL_MINUTES = (\d+);/);
  const inline = src.match(/const INLINE_POLL_MINUTES = (\d+);/);
  assert.ok(batch && inline, 'index.ts must declare both poll-budget constants');
  assert.equal(Number(batch[1]), BATCH_MODE_POLL_MINUTES);
  assert.equal(Number(inline[1]), INLINE_POLL_MINUTES);
});

// The real workflow, so the production config itself is under the guard.
test('opening-night-poller.yml satisfies the rule', () => {
  const raw = readFileSync(
    new URL('../../.github/workflows/opening-night-poller.yml', import.meta.url),
    'utf8'
  );
  assert.deepEqual(findShortBatchPollTimeoutSteps(raw), []);
});
