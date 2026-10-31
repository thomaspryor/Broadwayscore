// BRO-2937: runs the REAL "Copy core data to data/" step from
// .github/actions/checkout-core-data/action.yml against a fake private clone
// and proves the canary fails the step when any single core file is missing
// (it used to check only shows.json + reviews.json). The step's hardcoded
// /tmp/core-data-checkout and /tmp/core-data-snapshot are rewritten to temp
// dirs so a CI runner's real checkout is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTION = path.join(ROOT, '.github/actions/checkout-core-data/action.yml');
const { getShippedCoreFiles } = require(path.join(ROOT, 'scripts/lib/tracked-and-ignored-guard.js'));

// The `run: |` body of the named step, de-indented. No YAML dependency: the
// action is plain block-scalar YAML and this keeps the test self-contained.
function stepScript(yml, stepName) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(at >= 0, `step "${stepName}" not found in ${ACTION}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  assert.ok(runAt > at, `step "${stepName}" has no run: | block`);
  const body = [];
  let indent = null;
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.match(/^ */)[0].length;
    if (indent === null) indent = ind;
    if (ind < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

function runCopyStep(t, { drop = null, corrupt = null } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-core-data-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const checkout = path.join(tmp, 'core-data-checkout');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(checkout);
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(repo, 'scripts'));
  for (const f of getShippedCoreFiles()) {
    if (f === drop) continue;
    // shows/reviews must hold rows: an emptied one is itself a canary failure.
    const body = f === 'shows.json' ? '{"shows":[{"id":"a"}]}' : f === 'reviews.json' ? '{"reviews":[{"id":"r"}]}' : '{}';
    fs.writeFileSync(path.join(checkout, f), f === corrupt ? '{"truncated": ' : body);
  }
  fs.writeFileSync(path.join(checkout, 'untracked-extra.json'), '[]');

  const script = stepScript(fs.readFileSync(ACTION, 'utf8'), 'Copy core data to data/')
    .split('/tmp/core-data-checkout').join(checkout)
    .split('/tmp/core-data-snapshot').join(path.join(tmp, 'core-data-snapshot'));
  assert.ok(script.includes('core-data-files.js'), 'copy step no longer uses core-data-files.js');
  const env = { ...process.env, GITHUB_WORKSPACE: repo };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  // GitHub runs composite `shell: bash` steps as bash --noprofile --norc -eo pipefail.
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: repo, env, encoding: 'utf8' });
  return { ...r, repo };
}

test('a complete core-data checkout passes the canary and copies every file', (t) => {
  const r = runCopyStep(t);
  assert.equal(r.status, 0, r.stderr);
  for (const f of getShippedCoreFiles()) assert.ok(fs.existsSync(path.join(r.repo, 'data', f)), `${f} not copied`);
  assert.ok(fs.existsSync(path.join(r.repo, 'data', 'untracked-extra.json')));
});

for (const drop of ['opening-night-sent.json', 'subscribers.json', 'critic-consensus.json', 'shows.json']) {
  test(`a checkout missing ${drop} fails at the canary and names the file`, (t) => {
    const r = runCopyStep(t, { drop });
    assert.equal(r.status, 1, `expected the step to fail; stderr:\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(`::error::Core data checkout FAILED: ${drop.replace('.', '\\.')} is required core data but missing`));
  });
}

test('every CORE_FILES name, dropped alone, fails the step', (t) => {
  for (const drop of getShippedCoreFiles()) {
    const r = runCopyStep(t, { drop });
    assert.equal(r.status, 1, `dropping ${drop} did not fail the canary`);
  }
});

test('a truncated core file fails at the canary', (t) => {
  const r = runCopyStep(t, { corrupt: 'opening-night-sent.json' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /data\/opening-night-sent\.json is not valid JSON/);
});
