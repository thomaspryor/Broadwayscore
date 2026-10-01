// Every pending session plan in data/pending-fixes must be applicable by
// execute-approved-fix.js: a planId, a plan.actions array, and no more actions
// than its cap. BRO-4492: a 41-action plan landed and was refused only at apply
// time. Reads the directory (not git ls-files) so an uncommitted plan is checked
// too. Scoped to session-written bro-* plans: the feedback pipeline commits its
// numbered plans straight to main, and gating those here would turn main red
// with no code change (the BRO-3425 live-data trap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAX_PLAN_ACTIONS } = require('../../scripts/lib/pending-fix-limits.js');
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data/pending-fixes');

test('pending bro-* plans are applicable by execute-approved-fix', () => {
  const files = fs.readdirSync(dir).filter(f => /^bro-.*\.json$/.test(f));
  assert.ok(files.length > 0, 'expected bro-* plans in data/pending-fixes');
  const bad = [];
  for (const f of files) {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (plan.status !== 'pending') continue;
    if (!plan.planId) bad.push(`${f}: missing planId`);
    const actions = plan.plan && plan.plan.actions;
    if (!Array.isArray(actions)) { bad.push(`${f}: plan.actions is not an array`); continue; }
    if (actions.length > MAX_PLAN_ACTIONS) bad.push(`${f}: ${actions.length} actions (max ${MAX_PLAN_ACTIONS}); split it into ${path.basename(f, '.json')}-b.json`);
  }
  assert.deepEqual(bad, []);
});
