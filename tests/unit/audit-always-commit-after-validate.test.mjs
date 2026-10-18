// BRO-5293: an `if: always()` commit step after a failed validate-data.js step
// published data the validator rejected (BRO-3511 fixed generate-theater-tips.yml).
// require()s the real lib (CLAUDE.md §15), never a copy of the logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  findAlwaysCommitAfterValidate, auditWorkflowDir, protectedStaged, parseJobs,
} = require('../../scripts/lib/always-commit-after-validate.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

const wf = (commitStep, validateExtra = '') => [
  'name: t',
  'on: workflow_dispatch',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - name: Validate data',
  '        id: validate',
  validateExtra,
  '        run: node scripts/validate-data.js',
  '',
  ...commitStep,
].filter((l) => l !== null).join('\n');

const OFFENDER = [
  '      - name: Commit and push',
  '        if: always()',
  '        run: |',
  '          git add data/show-schedules.json data/audit/',
  '          git commit -m x',
  '          bash scripts/lib/push-with-retry.sh',
];

test('synthetic always() commit of a protected file after validate is flagged', () => {
  const hits = findAlwaysCommitAfterValidate(wf(OFFENDER));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].job, 'build');
  assert.equal(hits[0].commitStep, 'Commit and push');
  assert.equal(hits[0].validateStep, 'Validate data');
  assert.deepEqual(hits[0].staged, ['data/show-schedules.json']);
});

test('failure() and !cancelled() count as running after a failed validate', () => {
  for (const cond of ['failure()', '${{ !cancelled() }}']) {
    const step = OFFENDER.map((l) => l.replace('always()', cond));
    assert.equal(findAlwaysCommitAfterValidate(wf(step)).length, 1, cond);
  }
});

test('a default-if commit after a hard validate is not flagged', () => {
  const step = OFFENDER.filter((l) => !/if: always/.test(l));
  assert.equal(findAlwaysCommitAfterValidate(wf(step)).length, 0);
});

test('a default-if commit after a continue-on-error validate IS flagged', () => {
  const step = OFFENDER.filter((l) => !/if: always/.test(l));
  const hits = findAlwaysCommitAfterValidate(wf(step, '        continue-on-error: true'));
  assert.equal(hits.length, 1);
  assert.match(hits[0].reason, /soft/);
});

test('# always-commit-ok annotation exempts the step (inside or directly above)', () => {
  const inside = [...OFFENDER.slice(0, 2), '        # always-commit-ok: partial scrape progress is wanted', ...OFFENDER.slice(2)];
  assert.equal(findAlwaysCommitAfterValidate(wf(inside)).length, 0);
  const above = ['      # always-commit-ok: progress', ...OFFENDER];
  assert.equal(findAlwaysCommitAfterValidate(wf(above)).length, 0);
  const noReason = ['      # always-commit-ok:', ...OFFENDER];
  assert.equal(findAlwaysCommitAfterValidate(wf(noReason)).length, 1, 'empty reason is not an exemption');
});

test('outcome reference (steps.<id>.outcome or VALIDATE_OUTCOME env) passes', () => {
  const viaIf = OFFENDER.map((l) => l.replace('always()', "always() && steps.validate.outcome == 'success'"));
  assert.equal(findAlwaysCommitAfterValidate(wf(viaIf)).length, 0);
  const viaEnv = [...OFFENDER.slice(0, 2), '        env:', '          VALIDATE_OUTCOME: ${{ steps.validate.outcome }}', ...OFFENDER.slice(2)];
  assert.equal(findAlwaysCommitAfterValidate(wf(viaEnv)).length, 0);
});

test('commits of only non-protected data (ledgers, audit) are not flagged', () => {
  const step = OFFENDER.map((l) => l.replace('data/show-schedules.json data/audit/', 'data/audit/scraper-spend.jsonl'));
  assert.equal(findAlwaysCommitAfterValidate(wf(step)).length, 0);
});

test('push-review-texts action after validate is flagged; push-core-data (sentinel-guarded) is not', () => {
  const rt = ['      - name: Push review-texts', '        if: always()', '        uses: ./.github/actions/push-review-texts'];
  assert.equal(findAlwaysCommitAfterValidate(wf(rt)).length, 1);
  const core = ['      - name: Push core', '        if: always()', '        uses: ./.github/actions/push-core-data'];
  assert.equal(findAlwaysCommitAfterValidate(wf(core)).length, 0);
});

test('protectedStaged recognises whole-tree and stage-data-changes.sh adds', () => {
  assert.deepEqual(protectedStaged('git add -A'), ['-A (whole tree)']);
  assert.deepEqual(protectedStaged('bash scripts/lib/stage-data-changes.sh'), ['data/ (stage-data-changes.sh)']);
  assert.deepEqual(protectedStaged('bash scripts/lib/stage-data-changes.sh data/audit/'), []);
  assert.deepEqual(protectedStaged('git add data/cast/foo.json 2>/dev/null || true'), ['data/cast/foo.json']);
});

test('generate-theater-tips.yml (BRO-3511 fixed shape) is NOT flagged', () => {
  const text = fs.readFileSync(path.join(WF_DIR, 'generate-theater-tips.yml'), 'utf8');
  const steps = parseJobs(text).flatMap((j) => j.steps.map((s) => s.name));
  assert.ok(steps.includes('Validate data') && steps.includes('Commit and push if changed'), 'parser sees the steps');
  assert.deepEqual(findAlwaysCommitAfterValidate(text), []);
  // Same commit step with the outcome guard stripped IS flagged: the guard is what passes it.
  const stripped = text.replace(/^.*(?:MERGE|VALIDATE)_OUTCOME.*$\n/gm, '');
  assert.equal(findAlwaysCommitAfterValidate(stripped).length, 1);
});

test('runs over the real .github/workflows without throwing', () => {
  const hits = auditWorkflowDir(WF_DIR);
  assert.ok(Array.isArray(hits));
  assert.ok(!hits.some((h) => h.file === 'generate-theater-tips.yml'));
  for (const h of hits) {
    assert.ok(h.file && h.job && h.commitStep && h.validateStep && h.staged.length, JSON.stringify(h));
  }
});
