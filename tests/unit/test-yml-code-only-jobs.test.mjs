/**
 * BRO-4434 — main's Test Suite color means "the code is healthy".
 *
 * Fifty-odd sessions "fixed the root cause" of a red main and it was red
 * again within a day, because test.yml mixed code checks with checks on
 * OUTSIDE state: production data rewritten by bots every half hour, the npm
 * advisory feed, dated allowlist expiries, a data file's age. BRO-3425 moved
 * the corpus audits out (data-validation is non-blocking; live-data tests
 * run in check-corpus-drift.yml); BRO-4434 moved the last two (the npm
 * advisory gate → audit-dependencies.yml, awards.json freshness → a
 * check-corpus-drift.js AUDITS entry). This test is what stops the class
 * from creeping back:
 *
 *  (a) test-summary's `needs:` is EXACTLY the documented code-only set. A new
 *      blocking job is added here WITH a one-line "why it is code-only".
 *  (b) every other job in test.yml is in that set, except the documented
 *      non-blocking exception (the task #1690 blind spot, now a test).
 *  (c) the two departed jobs stay gone.
 *  (d) the replacement audit workflow exists, is scheduled, runs the audit
 *      with --alert and a warning window, and persists the alert ledger.
 *
 * Parsed with js-yaml like tests/unit/check-discovery-source-blind.test.mjs
 * and update-show-status-publish-gate.test.mjs — not grepped.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { isScheduledWorkflow } = require('../../scripts/lib/cron-coverage.js');

const ROOT = join(import.meta.dirname, '..', '..');
const readWorkflow = (file) => readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8');
const TEST_YML_TEXT = readWorkflow('test.yml');
const TEST_YML = yaml.load(TEST_YML_TEXT);

/**
 * The blocking set. Each entry says why a failure here means CODE broke, not
 * that the world moved. Adding a job means adding a line here — on purpose.
 */
const CODE_ONLY_JOBS = {
  'lint-workflows': 'actionlint + the static workflow/script audits; reads only the repo',
  'design-tokens-lint': 'brand-tokens ↔ tailwind sync; reads only the repo',
  'typescript-check': 'tsc + next lint; reads only the repo',
  'unit-tests': 'manifest-driven unit tests; live-data assertions were moved to check-corpus-drift.yml (BRO-3425)',
  'data-safety-guards': 'catastrophe guards that mean real trouble when red (copyrighted text in the public repo, public show JSONs stripped, archives missing, text-quality floor) — deliberately blocking (BRO-3425)',
  'e2e-tests': 'builds and exercises the site; red means the build or a page broke',
  'visual-regression': 'snapshot diffs of our own pages (schedule/dispatch-only, but a CODE check)',
};

/** Jobs that legitimately run in test.yml WITHOUT deciding main's color. */
const NON_BLOCKING_EXCEPTIONS = {
  'data-validation': 'BRO-3425: corpus-state audits, continue-on-error, routed to the daily digest; never in needs',
};

/** The jobs BRO-4434 removed. Their replacements: audit-dependencies.yml and check-corpus-drift.js AUDITS "awards-freshness". */
const DEPARTED_JOBS = ['dependency-audit', 'awards-data-freshness'];

const needsOf = (job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);

describe('test.yml: main\'s color is decided by code-only jobs (BRO-4434)', () => {
  test('(a) test-summary.needs is exactly the documented code-only set', () => {
    const summary = TEST_YML.jobs['test-summary'];
    assert.ok(summary, 'test-summary job must exist');
    assert.deepEqual(
      [...needsOf(summary)].sort(),
      Object.keys(CODE_ONLY_JOBS).sort(),
      'needs drifted from CODE_ONLY_JOBS — a new blocking job needs a one-line "why it is code-only" in this test',
    );
  });

  test('(b) every other job is either in needs or a documented non-blocking exception (the #1690 blind spot)', () => {
    const needs = new Set(needsOf(TEST_YML.jobs['test-summary']));
    const unaccounted = Object.keys(TEST_YML.jobs)
      .filter((id) => id !== 'test-summary' && !needs.has(id) && !(id in NON_BLOCKING_EXCEPTIONS));
    assert.deepEqual(unaccounted, [], 'a job that can fail on push but is not in needs makes main red without the pager seeing it');
  });

  test('(b\') the non-blocking exception really is non-blocking', () => {
    for (const id of Object.keys(NON_BLOCKING_EXCEPTIONS)) {
      const job = TEST_YML.jobs[id];
      assert.ok(job, `${id} listed as an exception but missing from test.yml — prune NON_BLOCKING_EXCEPTIONS`);
      assert.equal(job['continue-on-error'], true, `${id} must be continue-on-error to stay out of needs`);
    }
  });

  test('(c) the outside-state jobs BRO-4434 removed stay gone', () => {
    for (const id of DEPARTED_JOBS) {
      assert.equal(TEST_YML.jobs[id], undefined, `${id} is back in test.yml — it belongs in its own daily card-filing workflow`);
    }
  });

  test('(c\') no job in test.yml is gated to schedule/workflow_dispatch unless it is in the code-only set', () => {
    // An outside-state check tends to arrive as a schedule-only job "so it
    // never blocks PRs" — and then reds the daily run instead. Only
    // visual-regression (a code check) is allowed that shape.
    for (const [id, job] of Object.entries(TEST_YML.jobs)) {
      const cond = String(job.if || '');
      if (/github\.event_name\s*==\s*'schedule'/.test(cond)) {
        assert.ok(id in CODE_ONLY_JOBS, `${id} is schedule-gated but not a documented code-only job`);
      }
    }
  });
});

describe('the replacement: audit-dependencies.yml (BRO-4434)', () => {
  const text = readWorkflow('audit-dependencies.yml');
  const wf = yaml.load(text);

  test('is a scheduled workflow with a manual dispatch', () => {
    assert.equal(isScheduledWorkflow(text), true);
    const on = wf.on || wf[true]; // js-yaml parses a bare `on:` key as boolean true (YAML 1.1)
    assert.ok(on && on.workflow_dispatch !== undefined, 'workflow_dispatch must exist so the card path can be exercised by hand');
  });

  test('runs audit-dependencies.js with --alert and a warning window, and persists the alert ledger in the same job', () => {
    const jobs = Object.values(wf.jobs);
    assert.equal(jobs.length, 1);
    const runs = jobs[0].steps.map((s) => s.run || '').join('\n');
    assert.match(runs, /node scripts\/audit-dependencies\.js [^\n]*--warn-days=/);
    assert.match(runs, /ALERT_FLAG="--alert"/);
    assert.match(runs, /data\/audit\/alert-ledger\.json/);
    assert.match(runs, /data\/audit\/alert-router-attempts\.jsonl/);
    assert.match(runs, /push-with-retry\.sh/);
  });

  test('its own health is watched by check-cron-health.yml (a dead or daily-red cron must not be silent)', () => {
    const cron = readWorkflow('check-cron-health.yml');
    assert.match(cron, /"audit-dependencies\.yml\|\d+\|/);
  });
});
