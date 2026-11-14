// BRO-2801: requires the real proposer and the real audit (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { proposeForWorkflow, verifyProposal, searchStep, callShapes, MIN_RECOMMENDED_FUNDABLE } = require('./push-retry-remediation.js');
const audit = require('./audit-push-retry-budgets.js');

const wf = ({ retries = '', env = '', jobTimeout = 30, cron = "'0 3 * * *'", run = null, extraStep = '' }) => `name: Fixture
on:
  schedule:
    - cron: ${cron}
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: ${jobTimeout}
    steps:
      - name: Commit state
${env}        run: |
          git add data/audit/x.json
          ${run || `bash scripts/lib/push-with-retry.sh${retries ? ` ${retries}` : ''} main`}
${extraStep}`;

test('deadline-cannot-fund (default 7/240): recommended keeps margin and re-audits clean; threshold is reported separately', () => {
  const [row] = proposeForWorkflow(wf({}), 'a.yml');
  assert.equal(row.status, 'proposal');
  assert.ok(row.flags.includes('deadline-cannot-fund-retries'));
  assert.deepEqual(verifyProposal(row), []);
  assert.ok(row.fundableAtOwnTimeout >= MIN_RECOMMENDED_FUNDABLE);
  assert.ok(row.proposed.deadlineSec >= 240 && row.proposed.maxRetries >= 7, 'never shrinks');
  assert.ok(row.thresholdOnly.deadlineSec <= row.proposed.deadlineSec);
});

test('BRO-2714: remediation sizes jobs with the shared Checkout and script budget model', () => {
  const text = wf({ jobTimeout: 10, extraStep: `      - uses: actions/checkout@v5
      - run: node audit.js --time-budget-min=9
` });
  const [row] = proposeForWorkflow(text, 'budget.yml');
  assert.equal(row.status, 'proposal');
  const requiredSec = (row.proposed.deadlineSec + audit.CHECKOUT_ESTIMATE_SEC + 540) / (1 - audit.MARGIN_THRESHOLD);
  assert.equal(row.proposed.jobTimeoutMinutes, Math.ceil(requiredSec / 300) * 5);
});

test('BRO-2714: an estimate-only warning also gets a remediation proposal', () => {
  const text = wf({ jobTimeout: 20, retries: '21', env: `        env:
          PUSH_DEADLINE_SEC: 600
`, extraStep: `      - uses: actions/checkout@v5
      - run: node audit.js --time-budget-min=9
` });
  const [result] = audit.auditWorkflowText(text, 'budget.yml');
  assert.deepEqual(result.flags, []);
  assert.ok(result.advisoryFlags.includes('job-timeout-margin-estimated-undersized'));
  const [row] = proposeForWorkflow(text, 'budget.yml');
  assert.equal(row.status, 'proposal');
  assert.ok(row.proposed.jobTimeoutMinutes > 20);
});

test('retries-undersized only (7 retries, 900s deadline): deadline is kept, retries raised', () => {
  const env = "        env:\n          PUSH_DEADLINE_SEC: 900\n          PUSH_API_FALLBACK_AFTER_ATTEMPTS: 3\n";
  const [row] = proposeForWorkflow(wf({ env, jobTimeout: 60 }), 'b.yml');
  assert.equal(row.status, 'proposal');
  assert.equal(row.proposed.deadlineSec, 900);
  assert.ok(row.proposed.maxRetries > 7);
  assert.deepEqual(verifyProposal(row), []);
});

test('a short job timeout is raised and flagged as fallout of the proposal', () => {
  const [row] = proposeForWorkflow(wf({ jobTimeout: 5 }), 'c.yml');
  assert.equal(row.status, 'proposal');
  assert.ok(row.proposed.jobTimeoutMinutes > 5);
  assert.ok(row.cautions.some((c) => /raises job timeout-minutes 5→/.test(c)));
  // the raised job timeout clears the margin flag under the audit's own math
  const ev = audit.evaluateStep({ maxRetries: row.proposed.maxRetries, deadlineSec: row.proposed.deadlineSec, jobTimeoutMinutes: row.proposed.jobTimeoutMinutes, fallbackAfterAttemptsOverride: row.proposed.fallbackAfterOverride });
  assert.ok(!ev.flags.includes('job-timeout-margin-undersized'));
});

test('two push steps in one job: job timeout covers both proposed budgets', () => {
  const extra = `      - name: Commit other
        run: |
          bash scripts/lib/push-with-retry.sh main
`;
  const rows = proposeForWorkflow(wf({ jobTimeout: 10, extraStep: extra }), 'd.yml');
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.status, 'proposal');
  const minutes = rows[0].proposed.jobTimeoutMinutes;
  assert.equal(minutes, rows[1].proposed.jobTimeoutMinutes);
  const budgets = rows.map((r) => Math.max(r.proposed.deadlineSec, audit.computeBackoffSum(r.proposed.maxRetries)));
  assert.ok(minutes * 60 * (1 - audit.MARGIN_THRESHOLD) >= budgets[0] + budgets[1]);
});

test('step GIT_NET_TIMEOUT_SEC override feeds the margin, with a caution that the audit models 90s', () => {
  const env = "        env:\n          GIT_NET_TIMEOUT_SEC: '30'\n          PUSH_DEADLINE_SEC: 600\n";
  const [row] = proposeForWorkflow(wf({ env }), 'e.yml');
  assert.equal(row.gitNetTimeoutSec, 30);
  assert.ok(row.cautions.some((c) => /GIT_NET_TIMEOUT_SEC=30/.test(c)));
});

test('soft-fail (same line or \\ continuation), commented deadline and quoted call are review-by-hand, not proposals', () => {
  const same = proposeForWorkflow(wf({ run: "bash scripts/lib/push-with-retry.sh main || echo '::warning::x'" }), 'f.yml')[0];
  assert.equal(same.status, 'review-by-hand');
  const cont = proposeForWorkflow(wf({ run: "bash scripts/lib/push-with-retry.sh \\\n            main || echo '::warning::x'" }), 'g.yml')[0];
  assert.equal(cont.status, 'review-by-hand');
  assert.match(cont.reason, /soft-fail/);
  const env = "        env:\n          # fail fast on purpose: 15-min cron\n          PUSH_DEADLINE_SEC: '120'\n";
  const commented = proposeForWorkflow(wf({ env }), 'h.yml')[0];
  assert.equal(commented.status, 'review-by-hand');
  assert.match(commented.reason, /comment/);
  assert.deepEqual(callShapes('PUSH_CMD="bash scripts/lib/push-with-retry.sh 7 main"\n'), [{ quoted: true, softFailContinuation: false }]);
});

test('cron shorter than the needed job timeout names the concurrency behaviour', () => {
  const text = wf({ cron: "'*/10 * * * *'", jobTimeout: 5 }).replace('jobs:', 'concurrency:\n  group: x\n  cancel-in-progress: false\njobs:');
  const [row] = proposeForWorkflow(text, 'i.yml');
  assert.ok(row.cautions.some((c) => /10-min cron.*cancel-in-progress: false/.test(c)), row.cautions.join('\n'));
});

test('searchStep never lowers a configured knob', () => {
  const { recommended } = searchStep({ retries: [25], deadlineSec: 1200, fallbackOverride: 3, fallbackDisabled: false, gitNetSec: 90 });
  assert.ok(recommended.maxRetries >= 25 && recommended.deadlineSec >= 1200);
});

// The real repo: every proposal the tool emits must re-audit clean.
test('every proposal on the real .github/workflows re-audits clean under the audit\'s own evaluateStep', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.github', 'workflows');
  let proposals = 0;
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    for (const row of proposeForWorkflow(fs.readFileSync(path.join(dir, f), 'utf8'), f)) {
      if (row.status !== 'proposal') continue;
      proposals++;
      assert.deepEqual(verifyProposal(row), [], `${f} :: ${row.step}`);
    }
  }
  assert.ok(proposals > 0);
});
