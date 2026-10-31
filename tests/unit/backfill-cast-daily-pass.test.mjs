// BRO-5819: a new Broadway show gets ONE cast dispatch from update-show-status.yml.
// When that run died (2026-10-22, playwright install-deps timeout) nothing
// retried until the weekly Wednesday cron, so the health check's
// "Sync: cast coverage" row fired for up to a week. backfill-cast.yml now has a
// daily missing-file pass. These tests keep it cheap and non-destructive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const yaml = require('js-yaml');
const wf = yaml.load(readFileSync(path.join(root, '.github/workflows/backfill-cast.yml'), 'utf8'));
const steps = wf.jobs['backfill-cast'].steps;
const step = (name) => {
  const s = steps.find((x) => x.name === name);
  assert.ok(s, `step "${name}" missing`);
  return s;
};

const WEEKLY = '0 6 * * 3';

test('has the weekly refresh and a daily missing-file cron', () => {
  const crons = wf.on.schedule.map((s) => s.cron);
  assert.ok(crons.includes(WEEKLY), 'weekly refresh cron missing');
  assert.ok(crons.some((c) => c !== WEEKLY && /^\S+ \S+ \* \* \*$/.test(c)), 'daily cron missing');
});

test('only the weekly cron forces a re-scrape (daily pass must not --force)', () => {
  const run = step('Run cast backfill').run;
  // The force branch must key on the weekly cron literal, never on
  // event_name alone (both crons are event_name=schedule).
  const forceLine = run.split('\n').findIndex((l) => l.includes('--open-only --force'));
  assert.ok(forceLine > 0, 'weekly --force flags missing');
  const guard = run.split('\n').slice(0, forceLine).reverse().find((l) => /^\s*(if|elif) /.test(l));
  assert.ok(guard.includes(`github.event.schedule }}" = "${WEEKLY}"`), `force branch guarded by: ${guard}`);
  assert.ok(!/event_name }}" = "schedule" ]; then\s*\n\s*FLAGS="--open-only --force"/.test(run),
    'event_name==schedule must not lead to --force');
});

test('daily precheck job sits outside the concurrency group and gates on its RESULT', () => {
  const pre = wf.jobs['missing-cast-precheck'];
  assert.ok(pre, 'precheck job missing');
  assert.match(pre.if, /github\.event\.schedule != '0 6 \* \* 3'/);
  assert.equal(pre.concurrency, undefined, 'precheck must not join the backfill-cast group (would evict pending dispatches)');
  assert.equal(wf.concurrency, undefined, 'group must be job-level so the precheck stays outside it');
  const run = pre.steps.find((x) => x.id === 'count').run;
  assert.match(run, /set -o pipefail/);
  assert.match(run, /N=unknown/, 'precheck must fail closed (run) on an unreadable count');

  const job = wf.jobs['backfill-cast'];
  assert.equal(job.concurrency.group, 'backfill-cast');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  assert.equal(job.needs, 'missing-cast-precheck');
  // A skipped job's output is null, and GitHub coerces null and '0' both to 0,
  // so a bare `outputs.missing != '0'` silently skips weekly + dispatch runs.
  // The guard must short-circuit on the precheck's result first.
  assert.match(job.if, /!cancelled\(\)/);
  assert.match(job.if, /needs\.missing-cast-precheck\.result != 'success'\s*\|\|\s*needs\.missing-cast-precheck\.outputs\.missing != '0'/);
});

test('step-level gates and error suppression are gone from the backfill job', () => {
  for (const name of ['Setup Playwright', 'Run cast backfill']) {
    assert.equal(step(name).if, undefined, `${name} must not be step-gated`);
  }
  assert.equal(step('Setup Playwright')['continue-on-error'], undefined,
    'a failed playwright install must stay loud on weekly/dispatch runs; the daily pass retries it');
});
