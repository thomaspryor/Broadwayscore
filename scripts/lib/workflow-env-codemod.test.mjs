import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { addStepSecrets } = require('./workflow-env-codemod.js');
const { parseWorkflowFile } = require('./workflow-secret-scan.js');

const WF = `name: X
on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: No env
        run: node scripts/a.js
      - name: "Has env"
        env:
          FOO: bar
          # trailing comment
        run: |
          node scripts/b.js
          # shell comment
      - run: node scripts/c.js
        name: Name second
      - name: Dup
        run: echo 1
      - name: Dup
        run: echo 2
`;

function stepEnv(raw, name) {
  const job = parseWorkflowFile(raw).jobs[0];
  return [...job.steps.find((s) => s.name.replace(/"/g, '') === name).env].sort();
}

test('adds an env block after a one-line name', () => {
  const r = addStepSecrets(WF, 'build', 'No env', ['LINEAR_API_KEY']);
  assert.equal(r.ok, true);
  assert.match(r.raw, /- name: No env\n {8}env:\n {10}LINEAR_API_KEY: \$\{\{ secrets\.LINEAR_API_KEY \}\}\n {8}run: node scripts\/a\.js/);
  assert.deepEqual(stepEnv(r.raw, 'No env'), ['LINEAR_API_KEY']);
});

test('appends to an existing env block, quoted name, run script untouched', () => {
  const r = addStepSecrets(WF, 'build', 'Has env', ['OWNER_EMAIL', 'FOO']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.added, ['OWNER_EMAIL']);
  assert.deepEqual(stepEnv(r.raw, 'Has env'), ['FOO', 'OWNER_EMAIL']);
  assert.match(r.raw, /node scripts\/b\.js\n {10}# shell comment/);
});

test('name not first: env goes after the step body', () => {
  const r = addStepSecrets(WF, 'build', 'Name second', ['RESEND_API_KEY']);
  assert.equal(r.ok, true);
  assert.deepEqual(stepEnv(r.raw, 'Name second'), ['RESEND_API_KEY']);
});

test('refuses ambiguous or missing steps', () => {
  assert.equal(addStepSecrets(WF, 'build', 'Dup', ['X']).ok, false);
  assert.equal(addStepSecrets(WF, 'build', 'Nope', ['X']).ok, false);
  assert.equal(addStepSecrets(WF, 'other', 'No env', ['X']).ok, false);
});
