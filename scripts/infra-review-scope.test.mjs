// BRO-2380 (task #1856): the 'concurrency' critical rule in
// scripts/lib/infra-review-scope.js must cover the .github/actions composite
// actions that push to shared repos. Task #1850 edited three of them without
// infra-plan-review-gate.sh firing.
//
// Run: node --test scripts/infra-review-scope.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { classifyPath } = require('./lib/infra-review-scope.js');
const actionsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'actions');

test('push-* composite actions are critical concurrency paths', () => {
  for (const name of ['push-core-data', 'push-review-texts', 'push-aggregator-archive']) {
    const c = classifyPath(`.github/actions/${name}/action.yml`);
    assert.equal(c.inScope, true, name);
    assert.equal(c.rule, 'concurrency', name);
    assert.equal(c.tier, 'critical', name);
  }
});

test('drift guard: every existing composite action that pushes is gated', () => {
  const pushers = fs.readdirSync(actionsDir).filter((d) => {
    const f = path.join(actionsDir, d, 'action.yml');
    return fs.existsSync(f) && /git push|push-with-retry/.test(fs.readFileSync(f, 'utf8'));
  });
  assert.ok(pushers.length >= 4, `expected several pushing actions, found ${pushers.length}`);
  for (const d of pushers) {
    const c = classifyPath(`.github/actions/${d}/action.yml`);
    assert.equal(c.tier, 'critical', `.github/actions/${d}/action.yml pushes but is not in the concurrency gate; add it to the rule in infra-review-scope.js`);
  }
});
