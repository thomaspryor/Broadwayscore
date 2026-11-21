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

// BRO-7324: the "Pin core data revision" step, run for real against a local
// bare "private repo" (two commits on main) and a depth-1 clone of it, as the
// clone step leaves /tmp/core-data-checkout. Pinned, invalid and unfetchable
// refs: only a good pin moves HEAD; the other two warn and stay on main.
function runPinStep(t, refOf, { sparse = false } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-core-data-pin-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tmp };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k !== 'GIT_CONFIG_NOSYSTEM') delete env[k];
  const git = (...a) => execFileSync('git', a, { env, encoding: 'utf8' }).trim();
  const work = path.join(tmp, 'work');
  const bare = path.join(tmp, 'data.git');
  git('init', '-q', '-b', 'main', work);
  git('-C', work, 'config', 'user.email', 't@t'); git('-C', work, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(work, 'sub'));
  fs.writeFileSync(path.join(work, 'sub', 'x.txt'), 'x');
  fs.writeFileSync(path.join(work, 'shows.json'), '{"v":1}');
  git('-C', work, 'add', '.'); git('-C', work, 'commit', '-qm', 'one');
  const old = git('-C', work, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(work, 'shows.json'), '{"v":2}');
  git('-C', work, 'commit', '-qam', 'two');
  const tip = git('-C', work, 'rev-parse', 'HEAD');
  git('clone', '-q', '--bare', work, bare);
  // github.com serves any reachable sha; a local bare repo needs this to match.
  git('-C', bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  git('-C', bare, 'config', 'uploadpack.allowFilter', 'true');
  const checkout = path.join(tmp, 'core-data-checkout');
  git('clone', '-q', '--depth', '1', ...(sparse ? ['--filter=blob:none', '--sparse'] : []), '--branch', 'main', `file://${bare}`, checkout);
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(repo, 'scripts'));
  const script = stepScript(fs.readFileSync(ACTION, 'utf8'), 'Pin core data revision').split('/tmp/core-data-checkout').join(checkout);
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
    { cwd: repo, env: { ...env, GITHUB_WORKSPACE: repo, CORE_DATA_REF: refOf({ old, tip }) }, encoding: 'utf8' });
  return { ...r, old, tip, head: git('-C', checkout, 'rev-parse', 'HEAD'), checkout };
}

test('pin step: a valid older sha is fetched and checked out (detached)', (t) => {
  const r = runPinStep(t, ({ old }) => old);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.head, r.old);
  assert.equal(fs.readFileSync(path.join(r.checkout, 'shows.json'), 'utf8'), '{"v":1}');
});

test('pin step: sparse clone pins and keeps its sparse cone', (t) => {
  const r = runPinStep(t, ({ old }) => old, { sparse: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.head, r.old);
  assert.ok(fs.existsSync(path.join(r.checkout, 'shows.json')));
  assert.ok(!fs.existsSync(path.join(r.checkout, 'sub')), 'sparse cone still excludes subdirectories');
});

test('pin step: a malformed ref warns and stays on main', (t) => {
  const r = runPinStep(t, () => 'main; rm -rf /');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.head, r.tip);
  assert.match(r.stdout, /::warning::checkout-core-data: ref .* is not a 40-hex sha/);
});

test('pin step: an unfetchable sha warns and stays on main', (t) => {
  const r = runPinStep(t, () => 'f'.repeat(40));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.head, r.tip);
  assert.match(r.stdout, /::warning::checkout-core-data: could not fetch\/checkout pinned ffffffffff/);
});

test('pin step: action skips it entirely when ref is empty (default)', () => {
  const yml = fs.readFileSync(ACTION, 'utf8');
  assert.match(yml, /\n  ref:\n(?:    [^\n]*\n)*    default: ''\n/);
  assert.match(yml, /- name: Pin core data revision\n      if: inputs\.ref != ''\n/);
});
