// BRO-7117: step-timeout-headroom flags opening-night steps near their timeout cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const h = require('./step-timeout-headroom.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const YAML = `name: X
on:
  workflow_dispatch:
jobs:
  poll:
    runs-on: ubuntu-latest
    timeout-minutes: 152
    steps:
      - uses: actions/checkout@v4
      - name: Rebuild reviews.json locally (for readiness check)
        id: readiness_rebuild
        run: node scripts/rebuild-all-reviews.js
        # a comment
        continue-on-error: true
        timeout-minutes: 10
      - name: "Quoted step"
        timeout-minutes: \${{ inputs.t }}
      - name: Uncapped step
        run: echo hi
  express:
    name: Opening Night Express — \${{ inputs.show_id }}
    steps:
      - timeout-minutes: 3
        name: Cap first
`;

const t = (min) => new Date(Date.UTC(2026, 10, 21, 18, 0) + min * 60000).toISOString();
const run = (runId, jobName, jobMin, steps) => ({
  runId, url: `https://x/${runId}`,
  jobs: [{ name: jobName, started_at: t(0), completed_at: t(jobMin), steps: steps.map(([name, d, conclusion = 'success']) => ({ name, started_at: t(0), completed_at: t(d), conclusion })) }],
});

test('parseWorkflowCaps reads job and step caps, default job cap, expression caps as unknown', () => {
  const caps = h.parseWorkflowCaps(YAML);
  assert.equal(caps.length, 2);
  const poll = caps[0];
  assert.equal(poll.timeoutMin, 152);
  assert.deepEqual(poll.steps.map((s) => [s.name, s.timeoutMin]), [
    [null, null],
    ['Rebuild reviews.json locally (for readiness check)', 10],
    ['Quoted step', null],
    ['Uncapped step', null],
  ]);
  assert.equal(caps[1].timeoutMin, h.DEFAULT_JOB_TIMEOUT_MIN);
  assert.deepEqual(caps[1].steps, [{ name: 'Cap first', timeoutMin: 3 }]);
});

// The Nov 21 2026 shape (BRO-8010/8012): readiness rebuild creeping toward its
// 10-min cap in green runs before it timed out and paged.
test('flags a step whose slowest green run used >= 80% of its cap, worst run named', () => {
  const caps = h.parseWorkflowCaps(YAML);
  const runs = [
    run(1, 'poll', 40, [['Rebuild reviews.json locally (for readiness check)', 7.1]]),
    run(2, 'poll', 45, [['Rebuild reviews.json locally (for readiness check)', 8.6]]),
    run(3, 'poll', 30, [['Rebuild reviews.json locally (for readiness check)', 2, 'skipped']]),
  ];
  const near = h.nearCap(h.measure(caps, runs));
  assert.equal(near.length, 1);
  assert.equal(near[0].step, 'Rebuild reviews.json locally (for readiness check)');
  assert.equal(near[0].worstRun.runId, 2);
  assert.equal(near[0].samples, 2, 'skipped steps are not samples');
  assert.match(h.rowText('opening-night-poller.yml', near[0]), /took 8\.6 of its 10 min cap \(86%\)/);
});

test('quiet below the threshold; job-level cap checked too', () => {
  const caps = h.parseWorkflowCaps(YAML);
  assert.deepEqual(h.nearCap(h.measure(caps, [run(1, 'poll', 60, [['Rebuild reviews.json locally (for readiness check)', 5]])])), []);
  const job = h.nearCap(h.measure(caps, [run(1, 'poll', 140, [])]));
  assert.equal(job.length, 1);
  assert.equal(job[0].kind, 'job');
});

test('job names with ${{ }} expressions and matrix suffixes match', () => {
  const caps = h.parseWorkflowCaps(YAML);
  assert.equal(h.matchJob(caps, 'Opening Night Express — wanted-2026').key, 'express');
  assert.equal(h.matchJob(caps, 'poll (broadway)').key, 'poll');
  assert.equal(h.matchJob(caps, 'something else'), null);
  const near = h.nearCap(h.measure(caps, [run(9, 'Opening Night Express — wanted-2026', 10, [['Cap first', 2.9]])]));
  assert.equal(near[0].step, 'Cap first');
});

test('alert: one card while near cap, resolve when clean, nothing when input missing', () => {
  const caps = h.parseWorkflowCaps(YAML);
  const near = h.nearCap(h.measure(caps, [run(2, 'poll', 45, [['Rebuild reviews.json locally (for readiness check)', 8.6]])]));
  const [route] = h.decideHeadroomAlerts({ warnRatio: 0.8, findings: near.map((n) => ({ workflow: 'opening-night-poller.yml', ...n })) });
  assert.equal(route.action, 'route');
  assert.equal(route.alert.conditionKey, h.ALERT_KEY);
  assert.match(route.alert.title, /1 step near its timeout cap/);
  assert.match(route.alert.hint, /Do NOT dispatch opening-night-poller\.yml/);
  assert.equal(h.decideHeadroomAlerts({ warnRatio: 0.8, findings: [] })[0].action, 'resolve');
  assert.deepEqual(h.decideHeadroomAlerts({ inputMissing: true, findings: [] }), []);
});

test('every capped step in the real opening-night workflows parses with a name', () => {
  for (const wf of ['opening-night-poller.yml', 'opening-night-express.yml', 'opening-night-reviews.yml']) {
    const caps = h.parseWorkflowCaps(fs.readFileSync(path.join(ROOT, '.github/workflows', wf), 'utf8'));
    assert.ok(caps.length >= 1, `${wf}: no jobs parsed`);
    for (const j of caps) {
      for (const s of j.steps) if (s.timeoutMin !== null) assert.ok(s.name, `${wf} job ${j.key}: a capped step has no name, its timings would never match`);
    }
  }
  const poll = h.parseWorkflowCaps(fs.readFileSync(path.join(ROOT, '.github/workflows/opening-night-poller.yml'), 'utf8')).find((j) => j.key === 'poll');
  assert.ok(poll.steps.some((s) => s.name === 'Rebuild reviews.json locally (for readiness check)' && s.timeoutMin), 'the BRO-8010 step must stay measurable');
});
