// node --test scripts/github-actions-audit.test.mjs  (BRO-8287)
import test from 'node:test';
import assert from 'node:assert/strict';
import { runnerClass, billableMinutes, jobCost, aggregate, projectMonthEnd, RATES } from './github-actions-audit.mjs';

const t0 = '2026-11-20T10:00:00Z';
const plus = (s) => new Date(Date.parse(t0) + s * 1000).toISOString();

test('runnerClass separates billed macOS, Linux, larger and free self-hosted runners', () => {
  assert.equal(runnerClass({ labels: ['macos-26'] }), 'macos');
  assert.equal(runnerClass({ labels: ['ubuntu-latest'] }), 'linux');
  assert.equal(runnerClass({ labels: ['ubuntu-24.04'] }), 'linux');
  assert.equal(runnerClass({ labels: ['windows-latest'] }), 'windows');
  assert.equal(runnerClass({ labels: ['ubuntu-latest-4-cores'] }), 'linux-larger');
  // The owner's Mac Studio: macOS label but self-hosted → free, must not price as macOS.
  assert.equal(runnerClass({ labels: ['self-hosted', 'macOS', 'bsc-mac'] }), 'self-hosted');
});

test('billableMinutes rounds each job up to the whole minute and ignores jobs that never ran', () => {
  assert.equal(billableMinutes({ started_at: t0, completed_at: plus(5), conclusion: 'success' }), 1);
  assert.equal(billableMinutes({ started_at: t0, completed_at: plus(61), conclusion: 'success' }), 2);
  assert.equal(billableMinutes({ started_at: t0, completed_at: plus(600), conclusion: 'skipped' }), 0);
  assert.equal(billableMinutes({ started_at: t0, completed_at: null }), 0);
});

test('jobCost: public standard runners free, private macOS ~10x Linux, self-hosted free', () => {
  const job = (labels) => ({ labels, started_at: t0, completed_at: plus(600), conclusion: 'success' });
  assert.equal(jobCost(job(['ubuntu-latest']), { isPrivate: false }), 0);
  assert.equal(jobCost(job(['ubuntu-latest']), { isPrivate: true }), 10 * RATES.linux);
  assert.equal(jobCost(job(['macos-26']), { isPrivate: true }), 10 * RATES.macos);
  assert.ok(RATES.macos / RATES.linux >= 9);
  assert.equal(jobCost(job(['self-hosted', 'macOS', 'bsc-mac']), { isPrivate: true }), 0);
  // Larger runners bill even in public repos.
  assert.equal(jobCost(job(['ubuntu-latest-4-cores']), { isPrivate: false }), 10 * RATES['linux-larger']);
});

test('aggregate groups by repo/workflow/runner and sorts by cost', () => {
  const rows = aggregate([
    { repo: 'app', isPrivate: true, workflow: 'E2E', labels: ['macos-26'], started_at: t0, completed_at: plus(3600), conclusion: 'success' },
    { repo: 'app', isPrivate: true, workflow: 'CI', labels: ['ubuntu-latest'], started_at: t0, completed_at: plus(120), conclusion: 'success' },
    { repo: 'app', isPrivate: true, workflow: 'CI', labels: ['ubuntu-latest'], started_at: t0, completed_at: plus(30), conclusion: 'success' },
    { repo: 'app', isPrivate: true, workflow: 'Beat', labels: ['self-hosted', 'macOS'], started_at: t0, completed_at: plus(30), conclusion: 'success' },
  ]);
  assert.equal(rows[0].workflow, 'E2E');
  assert.equal(rows[0].minutes, 60);
  const ci = rows.find((r) => r.workflow === 'CI');
  assert.equal(ci.jobs, 2);
  assert.equal(ci.minutes, 3);
  assert.equal(rows.find((r) => r.workflow === 'Beat').usd, 0);
});

test('projectMonthEnd: Nov 25 spend + remaining days + spike allowance', () => {
  // $150.74 on Nov 25 00:00, $6/day for 6 days to Dec 1, $10 spike → $196.74
  assert.equal(projectMonthEnd({ spentToDate: 150.74, asOf: '2026-11-25', dailyRate: 6, monthEnd: '2026-12-01', spikeUsd: 10 }), 196.74);
  assert.equal(projectMonthEnd({ spentToDate: 100, asOf: '2026-12-02', dailyRate: 6, monthEnd: '2026-12-01' }), 100);
});

test('runAsJob times a completed run as one Linux job', async () => {
  const { runAsJob } = await import('./github-actions-audit.mjs');
  const j = runAsJob({ run_started_at: t0, updated_at: plus(70), status: 'completed', conclusion: 'success' });
  assert.equal(runnerClass(j), 'linux');
  assert.equal(billableMinutes(j), 2);
  assert.equal(billableMinutes(runAsJob({ run_started_at: t0, updated_at: plus(70), status: 'in_progress' })), 0);
});
