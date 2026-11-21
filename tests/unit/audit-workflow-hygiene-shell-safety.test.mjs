// BRO-5046 / BRO-4730 / BRO-4621: hygiene rules (s) pipefail, (t) masked push,
// (u) string-input interpolation. Calls the real rule functions and sweeps the
// real workflows, so a new occurrence anywhere fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  splitWorkflowSteps, findNodeTeeWithoutPipefail, findMaskedPushFailures,
  declaredInputTypes, findStringInputInterpolation, maskedPushHandler, findCompositeShellHazards,
} = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const WF = path.resolve(import.meta.dirname, '../../.github/workflows');
const wf = (body) => `name: t\non:\n  workflow_dispatch:\n    inputs:\n      who:\n        type: string\n      mode:\n        type: choice\n      dry:\n        type: boolean\njobs:\n  j:\n    runs-on: ubuntu-latest\n    needs:\n      - a\n    steps:\n${body}`;

test('splitWorkflowSteps ignores list items outside steps:', () => {
  const raw = wf('      - name: A\n        run: echo a\n      - name: B\n        run: echo b\n');
  assert.deepEqual(splitWorkflowSteps(raw).map((s) => s.name), ['A', 'B']);
});

test('(s) flags node|tee without pipefail, accepts shell: bash / PIPESTATUS / pipefail', () => {
  const bad = wf('      - name: A\n        run: node x.js 2>&1 | tee out.txt\n');
  assert.equal(findNodeTeeWithoutPipefail(bad).length, 1);
  assert.equal(findNodeTeeWithoutPipefail(wf('      - name: A\n        shell: bash\n        run: node x.js | tee o\n')).length, 0);
  assert.equal(findNodeTeeWithoutPipefail(wf('      - name: A\n        run: |\n          set -o pipefail\n          node x.js | tee o\n')).length, 0);
  assert.equal(findNodeTeeWithoutPipefail(wf('      - name: A\n        run: |\n          node x.js | tee o\n          echo ${PIPESTATUS[0]}\n')).length, 0);
  // a `\\` continuation before the tee is still one pipeline (found by the ship-check review)
  assert.equal(findNodeTeeWithoutPipefail(wf('      - name: A\n        run: |\n          node x.js \\\n            --a 2>&1 | tee o\n')).length, 1);
  assert.equal(findNodeTeeWithoutPipefail(wf('      - name: A\n        run: |\n          npx tsx x.ts | tee o\n')).length, 1);
  // a comment mentioning pipefail is not a pipefail
  assert.equal(findNodeTeeWithoutPipefail(wf('      - name: A\n        run: |\n          # pipefail makes this work\n          node x.js | tee o\n')).length, 1);
});

test('(t) masked push detector flags echo/true/: and joins continuations, accepts re-raise', () => {
  assert.ok(maskedPushHandler('bash scripts/lib/push-with-retry.sh 5 main || echo "w"'));
  assert.equal(maskedPushHandler('bash scripts/lib/push-with-retry.sh || { echo w; exit 1; }'), null);
  const cont = wf('      - name: P\n        run: |\n          bash scripts/lib/push-with-retry.sh \\\n            || echo "w"\n');
  assert.equal(findMaskedPushFailures(cont).length, 1);
  assert.equal(findMaskedPushFailures(wf('      - name: P\n        run: bash scripts/lib/push-with-retry.sh\n')).length, 0);
});

test('(u) only string inputs inside run: are flagged', () => {
  const raw = wf(
    '      - name: A\n        if: inputs.who == \'x\'\n        env:\n          W: ${{ inputs.who }}\n        run: |\n          echo "${{ inputs.who }}" ${{ inputs.mode }} ${{ inputs.dry }}\n',
  );
  assert.deepEqual(declaredInputTypes(raw), { who: 'string', mode: 'choice', dry: 'boolean' });
  const hits = findStringInputInterpolation(raw);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].input, 'who');
});

test('real workflows: no unpiped node|tee and no masked push-with-retry.sh (rules s, t)', () => {
  const bad = [];
  for (const f of fs.readdirSync(WF).filter((x) => x.endsWith('.yml'))) {
    const raw = fs.readFileSync(path.join(WF, f), 'utf8');
    for (const h of findNodeTeeWithoutPipefail(raw)) bad.push(`${f}:${h.lineNum} pipefail "${h.name}"`);
    for (const h of findMaskedPushFailures(raw)) bad.push(`${f}:${h.lineNum} masked push "${h.name}"`);
  }
  assert.deepEqual(bad, []);
});

test('real workflows: no string-input interpolation inside run: (rule u)', () => {
  const bad = [];
  for (const f of fs.readdirSync(WF).filter((x) => x.endsWith('.yml'))) {
    const raw = fs.readFileSync(path.join(WF, f), 'utf8');
    for (const h of findStringInputInterpolation(raw)) bad.push(`${f}:${h.lineNum} inputs.${h.input} in "${h.name}"`);
  }
  assert.deepEqual(bad, []);
});

test('CLI exits non-zero for each of rules s, t, u (rules are wired into the total)', () => {
  const cli = path.resolve(import.meta.dirname, '../../scripts/audit-workflow-hygiene.js');
  const cases = {
    s: '      - name: A\n        run: node x.js | tee o\n',
    t: '      - name: A\n        run: bash scripts/lib/push-with-retry.sh || echo w\n',
    u: '      - name: A\n        run: echo "${{ inputs.who }}"\n',
  };
  for (const [rule, body] of Object.entries(cases)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyg-'));
    fs.writeFileSync(path.join(dir, 'a.yml'), wf(body));
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `inert-${i}.yml`), '# hygiene-notify-ok: inert fixture\n# hygiene-permissions-ok: inert fixture (BRO-6398 rule aa)\nname: inert\non: workflow_dispatch\njobs: {}\n');
    const r = spawnSync('node', [cli], { env: { ...process.env, HYGIENE_WORKFLOW_DIR: dir }, encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.notEqual(r.status, 0, `rule (${rule}) must fail the CLI`);
    assert.match(r.stderr, new RegExp(`\\(${rule}\\)`));
  }
});

test('composite actions: masked push and raw input interpolation are flagged, env-routed values are not', () => {
  const bad = 'runs:\n  using: composite\n  steps:\n    - name: C\n      shell: bash\n      run: |\n        bash scripts/lib/push-with-retry.sh 5 main || echo w\n        echo "${{ inputs.who }}"\n';
  const kinds = findCompositeShellHazards(bad).map((h) => h.kind).sort();
  assert.deepEqual(kinds, ['masked-push', 'string-input']);
  const good = 'runs:\n  using: composite\n  steps:\n    - name: C\n      shell: bash\n      env:\n        W: ${{ inputs.who }}\n      run: |\n        bash scripts/lib/push-with-retry.sh 5 main\n        echo "$W"\n';
  assert.deepEqual(findCompositeShellHazards(good), []);
});

test('real composite actions have no hazards', () => {
  const dir = path.resolve(import.meta.dirname, '../../.github/actions');
  const bad = [];
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'action.yml');
    if (!fs.existsSync(f)) continue;
    for (const h of findCompositeShellHazards(fs.readFileSync(f, 'utf8'))) bad.push(`${d}:${h.lineNum} ${h.kind} ${h.detail}`);
  }
  assert.deepEqual(bad, []);
});
