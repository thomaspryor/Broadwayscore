// BRO-4370 / BRO-4401: the rebuild's auto-register pass now parks outlets it
// refuses to register (no resolvable domain, critic name, domain collision)
// in data/audit/outlet-registry-staging.json instead of writing domain:null
// rows. audit-outlet-registry.js --strict in test.yml reads the COMMITTED
// staging file — it runs with no prior rebuild — so the push-core-data
// composite action's outlet-registry sync step must stage that file too.
//
// Two things this pins, both found by the second-opinion review of the plan:
//   1. The path string lives in scripts/lib/outlet-auto-register.js and is
//      repeated inside the YAML; a rename in one place must fail here.
//   2. `git diff --quiet -- <path>` exits 0 for an UNTRACKED file, so an
//      "unchanged → exit 0" guard placed BEFORE `git add` would silently drop
//      the staging file the first time it is ever created. The step must
//      add first and gate only on the staged diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { STAGING_RELATIVE_PATH } = require(resolve(ROOT, 'scripts/lib/outlet-auto-register.js'));

const ACTION = resolve(ROOT, '.github', 'actions', 'push-core-data', 'action.yml');
const yaml = readFileSync(ACTION, 'utf8');

function syncStepBody() {
  const start = yaml.indexOf('- name: Sync outlet-registry.json');
  assert.ok(start > 0, 'push-core-data/action.yml must still have the outlet-registry sync step');
  const rest = yaml.slice(start);
  const next = rest.indexOf('\n    - name:', 1);
  return next > 0 ? rest.slice(0, next) : rest;
}

test('the sync step names the same staging path scripts/lib/outlet-auto-register.js writes', () => {
  assert.equal(STAGING_RELATIVE_PATH, 'data/audit/outlet-registry-staging.json');
  assert.ok(
    syncStepBody().includes(STAGING_RELATIVE_PATH),
    `push-core-data's outlet-registry sync step must reference ${STAGING_RELATIVE_PATH} (the file the rebuild writes) or refused outlets never reach main`,
  );
});

test('the staging file is git-added BEFORE any diff --quiet guard (untracked files pass an unstaged quiet check)', () => {
  const body = syncStepBody();
  const addIdx = body.search(/git add -- "\$STAGING"/);
  assert.ok(addIdx > 0, 'expected `git add -- "$STAGING"` in the sync step');
  const unstagedGuard = body.search(/git diff --quiet -- [^\n]*STAGING/);
  assert.equal(unstagedGuard, -1, 'no `git diff --quiet -- ...$STAGING` (unstaged) guard may exist: it exits 0 for an untracked file and would drop the first-ever staging file');
  const stagedGate = body.search(/git diff --staged --quiet -- [^\n]*\$STAGING/);
  assert.ok(stagedGate > addIdx, 'the "nothing to commit" gate must be a --staged diff placed AFTER the git add');
});

test('the step opts into push-with-retry reconciliation (the staging file is multi-writer and registered active)', () => {
  assert.match(syncStepBody(), /PUSH_RECONCILE_MERGED_JSON:\s*'1'/);
});

test('an invalid staging file warns and is unstaged; only the registry itself can fail the step', () => {
  const body = syncStepBody();
  assert.match(body, /::warning::\$STAGING is not valid JSON/);
  assert.match(body, /git reset -q -- "\$STAGING"/);
  assert.match(body, /::error::\$REGISTRY is not valid JSON[\s\S]*exit 1/);
});
