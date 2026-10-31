// BRO-3447: scripts/audit-run-budget-coverage.js only checked SCHEDULED
// workflows, so gather-reviews.yml (workflow_dispatch-only, but dispatched by
// half a dozen other workflows; a 55-min job running gather-reviews.js with
// no --time-budget-min) was never flagged before it burned ~35K credits in
// cancelled runs. These tests require() the real audit (CLAUDE.md §15) and
// run collectFindings() against small fixture corpora on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  collectFindings,
  buildDispatchGraph,
  extractDispatchTargets,
  getWorkflowName,
  isFlagGatedBudgetScript,
  invocationPassesBudget,
  invocationTextAt,
  budgetCarryingVars,
  findingKey,
  partitionByBaseline,
} = require('../../scripts/audit-run-budget-coverage.js');

// Workflow A: dispatch-only, one 55-min job with BD creds running a script.
const workflowA = (invocation) => `name: Worker A
on:
  workflow_dispatch:
    inputs:
      shows:
        type: string
jobs:
  work:
    runs-on: ubuntu-latest
    timeout-minutes: 55
    steps:
      - uses: actions/checkout@v4
      - name: Run worker
        env:
          BRIGHTDATA_TOKEN: \${{ secrets.BRIGHTDATA_TOKEN }}
        run: |
          ${invocation}
`;

// Workflow B: scheduled, dispatches A.
const workflowB = (dispatchLine) => `name: Caller B
on:
  schedule:
    - cron: '0 * * * *'
jobs:
  kick:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Dispatch A
        env:
          GH_TOKEN: \${{ github.token }}
        run: ${dispatchLine}
`;

// A script with an unbounded network loop and no run-budget at all.
const UNBUDGETED_SCRIPT = `const { fetchPage } = require('./lib/scraper');
async function main() {
  for (const show of shows) {
    await fetchPage(show.url);
  }
}
main();
`;

// A script whose budget is ONLY enabled by --time-budget-min= (gather-reviews.js shape).
const FLAG_GATED_SCRIPT = `const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));
async function main() {
  for (const show of shows) {
    if (timeBudget.exceeded()) break;
    await fetchPage(show.url);
  }
}
main();
`;

function makeCorpus(workflows, scripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-dispatch-'));
  const workflowDir = path.join(root, 'workflows');
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(workflowDir);
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(workflowDir, `inert-${i}.yml`), 'jobs: {}\n');
  fs.mkdirSync(path.join(scriptsDir, 'lib'), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) fs.writeFileSync(path.join(workflowDir, name), body);
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(scriptsDir, name), body);
  return { workflowDir, scriptsDir };
}

const allFindings = (r) => [...r.warnings, ...r.threadingWarnings, ...r.flagWarnings];

test('dispatch-only A (55-min job, unbudgeted script) IS flagged when workflow B dispatches it', () => {
  const corpus = makeCorpus(
    {
      'a.yml': workflowA('node scripts/worker.js --shows="${{ inputs.shows }}"'),
      'b.yml': workflowB('gh workflow run a.yml -f shows=all'),
    },
    { 'worker.js': UNBUDGETED_SCRIPT },
  );
  const r = collectFindings(corpus);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].file, 'a.yml');
  assert.equal(r.warnings[0].kind, 'missing-run-budget');
  assert.equal(r.warnings[0].timeoutMinutes, 55);
  assert.equal(r.warnings[0].script, 'worker.js');
  assert.equal(r.warnings[0].trigger, 'dispatched by b.yml');
});

test('the same A with NO caller is not flagged (dispatch-only, nothing automated feeds it)', () => {
  const corpus = makeCorpus(
    { 'a.yml': workflowA('node scripts/worker.js --shows="${{ inputs.shows }}"') },
    { 'worker.js': UNBUDGETED_SCRIPT },
  );
  assert.deepEqual(allFindings(collectFindings(corpus)), []);
});

test('A re-dispatching itself does not count as a caller', () => {
  const selfCalling = workflowA('node scripts/worker.js\n          gh workflow run a.yml -f shows=rest');
  const corpus = makeCorpus({ 'a.yml': selfCalling }, { 'worker.js': UNBUDGETED_SCRIPT });
  assert.deepEqual(allFindings(collectFindings(corpus)), []);
});

test('github-script workflow_id and display-name dispatches both create edges', () => {
  const corpus = makeCorpus(
    {
      'a.yml': workflowA('node scripts/worker.js'),
      'b.yml': workflowB(`echo hi
      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: 'a.yml', ref: 'main' });`),
    },
    { 'worker.js': UNBUDGETED_SCRIPT },
  );
  assert.equal(collectFindings(corpus).warnings.length, 1);

  const byName = makeCorpus(
    { 'a.yml': workflowA('node scripts/worker.js'), 'b.yml': workflowB('gh workflow run "Worker A"') },
    { 'worker.js': UNBUDGETED_SCRIPT },
  );
  assert.equal(collectFindings(byName).warnings.length, 1);
});

test('a commented-out dispatch line does not create an edge', () => {
  const b = workflowB('echo noop').replace('    steps:', '    # re-run with: gh workflow run a.yml\n    steps:');
  const corpus = makeCorpus({ 'a.yml': workflowA('node scripts/worker.js'), 'b.yml': b }, { 'worker.js': UNBUDGETED_SCRIPT });
  assert.deepEqual(allFindings(collectFindings(corpus)), []);
});

test('flag-gated budget script invoked WITHOUT --time-budget-min= is flagged (gather-reviews incident shape)', () => {
  const corpus = makeCorpus(
    { 'a.yml': workflowA('node scripts/worker.js --shows="$SHOWS"'), 'b.yml': workflowB('gh workflow run a.yml') },
    { 'worker.js': FLAG_GATED_SCRIPT },
  );
  const r = collectFindings(corpus);
  assert.equal(r.warnings.length, 0, 'requires run-budget, so not a missing-run-budget finding');
  assert.equal(r.flagWarnings.length, 1);
  assert.equal(r.flagWarnings[0].kind, 'unbudgeted-invocation');
});

test('flag-gated script passing the budget (directly, or via a shell var) is NOT flagged', () => {
  for (const inv of [
    'node scripts/worker.js --shows="$SHOWS" --time-budget-min=45',
    'TB_FLAG="--time-budget-min=45"\n          ARGS="--x $TB_FLAG"\n          node scripts/worker.js $ARGS',
  ]) {
    const corpus = makeCorpus(
      { 'a.yml': workflowA(inv), 'b.yml': workflowB('gh workflow run a.yml') },
      { 'worker.js': FLAG_GATED_SCRIPT },
    );
    assert.deepEqual(allFindings(collectFindings(corpus)), [], inv);
  }
});

test('the space form --time-budget-min 45 does NOT count (parseTimeBudgetMin ignores it, BRO-3887)', () => {
  assert.equal(invocationPassesBudget('node scripts/x.js --time-budget-min 45'), false);
  assert.equal(invocationPassesBudget('node scripts/x.js --time-budget-min=45'), true);
});

test('isFlagGatedBudgetScript: bare flag parse is gated; numeric fallbacks are not', () => {
  assert.equal(isFlagGatedBudgetScript(FLAG_GATED_SCRIPT), true);
  assert.equal(isFlagGatedBudgetScript('const b = createRunBudget(parseTimeBudgetMin(args) || 20);'), false);
  assert.equal(isFlagGatedBudgetScript('const b = createRunBudget(22);'), false);
  assert.equal(isFlagGatedBudgetScript(UNBUDGETED_SCRIPT), false);
});

test('invocationTextAt follows backslash continuations', () => {
  const body = 'node scripts/x.js \\\n  --a=1 \\\n  --time-budget-min=9\necho next --time-budget-min=99';
  const inv = invocationTextAt(body, 0);
  assert.ok(inv.includes('--time-budget-min=9'));
  assert.ok(!inv.includes('echo next'));
});

test('budgetCarryingVars resolves chained assignments', () => {
  const vars = budgetCarryingVars('TB_FLAG="--time-budget-min=5"\nARGS="$ARGS $TB_FLAG"\nOTHER="--dry-run"');
  assert.deepEqual([...vars].sort(), ['ARGS', 'TB_FLAG']);
});

test('extractDispatchTargets / getWorkflowName / buildDispatchGraph basics', () => {
  assert.deepEqual(extractDispatchTargets('run: gh workflow run gather-reviews.yml -f shows=x'), ['gather-reviews.yml']);
  assert.equal(getWorkflowName('name: "Gather Reviews"\non: push\n'), 'Gather Reviews');
  const g = buildDispatchGraph([
    { file: 'a.yml', raw: 'name: A\n' },
    { file: 'b.yml', raw: 'name: B\njobs:\n  x:\n    steps:\n      - run: gh workflow run "A"\n' },
    { file: 'c.yml', raw: 'name: C\njobs:\n  x:\n    steps:\n      - run: gh workflow run "$WF"\n' },
  ]);
  assert.deepEqual([...g.keys()], ['a.yml']);
  assert.deepEqual([...g.get('a.yml')], ['b.yml']);
});

test('partitionByBaseline separates NEW findings from baselined ones', () => {
  const f1 = { kind: 'missing-run-budget', file: 'a.yml', job: 'work', script: 'worker.js' };
  const f2 = { kind: 'unbudgeted-invocation', file: 'a.yml', job: 'work', script: 'worker.js' };
  const { fresh, known } = partitionByBaseline([f1, f2], new Set([findingKey(f1)]));
  assert.deepEqual(known, [f1]);
  assert.deepEqual(fresh, [f2]);
});

test('live corpus: gather-reviews.yml is in the dispatch graph and its budgeted main job is not flagged', () => {
  const r = collectFindings();
  assert.ok((r.dispatchGraph.get('gather-reviews.yml') || new Set()).size > 0, 'gather-reviews.yml has callers');
  const mainJob = allFindings(r).filter(
    (f) => f.file === 'gather-reviews.yml' && f.script === 'gather-reviews.js' && f.kind === 'unbudgeted-invocation',
  );
  assert.deepEqual(mainJob, [], 'gather-reviews job passes --time-budget-min= on main');
});

test('live gather-reviews.yml with its --time-budget-min= flags stripped IS flagged', () => {
  const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const liveWf = path.join(repoRoot, '.github', 'workflows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-live-'));
  for (const f of fs.readdirSync(liveWf).filter((x) => /\.ya?ml$/.test(x))) {
    let body = fs.readFileSync(path.join(liveWf, f), 'utf8');
    if (f === 'gather-reviews.yml') body = body.replace(/\s--time-budget-min=\S+/g, '');
    fs.writeFileSync(path.join(root, f), body);
  }
  const r = collectFindings({ workflowDir: root });
  const hit = r.flagWarnings.find((f) => f.file === 'gather-reviews.yml' && f.script === 'gather-reviews.js');
  assert.ok(hit, 'gather-reviews.js invocation without a budget is flagged');
  assert.match(hit.trigger, /^dispatched by /);
});
