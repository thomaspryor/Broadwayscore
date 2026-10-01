// Every tracked pending plan in data/pending-fixes must be applicable by
// execute-approved-fix.js: within its action cap and carrying a planId.
// BRO-4492: a 41-action plan landed and was refused only at apply time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAX_PLAN_ACTIONS } = require('../../scripts/lib/pending-fix-limits.js');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const tracked = execFileSync('git', ['ls-files', 'data/pending-fixes/*.json'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);

test('pending plans stay within the executor action cap', () => {
  assert.ok(tracked.length > 0, 'expected tracked plans in data/pending-fixes');
  const bad = [];
  for (const rel of tracked) {
    const plan = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    if (plan.status !== 'pending') continue;
    const n = (plan.plan && plan.plan.actions || []).length;
    if (n > MAX_PLAN_ACTIONS) bad.push(`${rel}: ${n} actions (max ${MAX_PLAN_ACTIONS}); split it into ${path.basename(rel, '.json')}-b.json`);
    if (!plan.planId) bad.push(`${rel}: missing planId`);
  }
  assert.deepEqual(bad, []);
});
