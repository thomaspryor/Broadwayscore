/**
 * CI jobs that run the temp-git-repo tests must turn git auto-maintenance off
 * in GLOBAL git config, not via GIT_CONFIG_COUNT env (BRO-4749).
 *
 * Tests build throwaway repos (often a bare origin.git plus a clone) and
 * fs.rmSync them in teardown. A push to a local bare remote runs receive-pack
 * in that repo, and receive-pack spawns `git maintenance run --auto --quiet
 * --detach`, which keeps writing into origin.git/objects while the rm walks
 * it: ENOTEMPTY, reported against whichever passing test owned the teardown.
 *
 * BRO-4720 set gc.auto / gc.autoDetach / maintenance.auto through job-level
 * GIT_CONFIG_COUNT env. git strips GIT_CONFIG_COUNT (it is in
 * `git rev-parse --local-env-vars`) before running the remote side of a local
 * transport, so receive-pack never saw it: run 37348719012 failed the same way
 * after BRO-4720 landed. Measured with GIT_TRACE on the CONCURRENT-WRITER
 * stress test: 25 detached maintenance spawns with the env, 0 with the same
 * keys (plus receive.autogc=false) in a global config file.
 *
 * Run: node --test tests/unit/ci-git-auto-maintenance-off.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readWorkflowJobBlocks } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(ROOT, '.github/workflows');

const REQUIRED = [
  ['gc.auto', '0'],
  ['gc.autoDetach', 'false'],
  ['maintenance.auto', 'false'],
  ['receive.autogc', 'false'],
];

// Jobs that run tests/unit + scripts/lib temp-git-repo tests.
const JOBS = [
  ['test.yml', 'unit-tests'],
  ['land.yml', 'checks'],
];

const code = (lines) => lines.filter((l) => !/^\s*#/.test(l)).join('\n');

function missingGlobalKeys(jobText) {
  return REQUIRED.filter(([k, v]) => !new RegExp(`git config --global ${k.replace('.', '\\.')} ${v}\\b`).test(jobText)).map(([k]) => k);
}

for (const [file, job] of JOBS) {
  test(`${file} ${job} disables git auto-maintenance via git config --global`, () => {
    const block = readWorkflowJobBlocks(fs.readFileSync(path.join(WF, file), 'utf8'))[job];
    assert.ok(block, `${file} has no ${job} job`);
    assert.deepEqual(missingGlobalKeys(code(block)), [], `${file} ${job} must run git config --global for each of ${REQUIRED.map(([k]) => k).join(', ')}`);
  });
}

test('no workflow sets gc/maintenance keys through GIT_CONFIG_KEY_* env (local transports strip it)', () => {
  const offenders = [];
  for (const f of fs.readdirSync(WF).filter((n) => /\.ya?ml$/.test(n))) {
    const text = code(fs.readFileSync(path.join(WF, f), 'utf8').split('\n'));
    if (/GIT_CONFIG_KEY_\d+:\s*['"]?(gc\.|maintenance\.|receive\.autogc)/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'use a `git config --global` step instead (see this file header)');
});

// A fixture that nulls global config (GIT_CONFIG_GLOBAL=/dev/null) never sees
// the CI step above, so if it makes a bare remote it must set the keys in that
// repo itself (receive-pack reads the bare repo's own config).
const NULLS_GLOBAL = /GIT_CONFIG_GLOBAL['"]?\s*[:=]\s*['"]?\/dev\/null/;
function unguardedBareFixture(text) {
  return NULLS_GLOBAL.test(text) && /--bare\b/.test(text) && !(/maintenance\.auto/.test(text) && /receive\.autogc/.test(text));
}

function walkTests(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walkTests(p, out); } else if (/\.test\.(m?js|sh|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('fixtures that null global git config and push to a bare remote turn maintenance off in that repo', () => {
  const self = fileURLToPath(import.meta.url);
  const files = ['tests', 'scripts'].flatMap((d) => walkTests(path.join(ROOT, d))).filter((f) => f !== self);
  const bad = files.filter((f) => unguardedBareFixture(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(bad, [], 'after `init --bare`, set gc.auto 0, gc.autoDetach false, maintenance.auto false, receive.autogc false in the bare repo');
});

test('the fixture checker flags a nulled-global bare repo without the keys', () => {
  assert.equal(unguardedBareFixture("GIT_CONFIG_GLOBAL: '/dev/null'\ngit init --bare o.git\n"), true);
  assert.equal(unguardedBareFixture('export GIT_CONFIG_GLOBAL=/dev/null\ngit init --bare o.git\ngit -C o.git config maintenance.auto false\ngit -C o.git config receive.autogc false\n'), false);
  assert.equal(unguardedBareFixture('git init --bare o.git\n'), false);
});

test('the checker catches a job missing a key', () => {
  assert.deepEqual(missingGlobalKeys('git config --global gc.auto 0\ngit config --global gc.autoDetach false\ngit config --global maintenance.auto false\n'), ['receive.autogc']);
});

test('git still strips GIT_CONFIG_COUNT for local transports (why env is not enough)', () => {
  const vars = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n');
  assert.ok(vars.includes('GIT_CONFIG_COUNT'), 'if git stops stripping it, this guard can be revisited');
});
