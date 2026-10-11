// BRO-3565: cyrano-de-bergerac-west-end-2026 carried a 1946 Broadway cast.
// The plan must be a valid cast edit; once applied, shows.json must hold the 2026 cast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { castValueProblem } = require('../../scripts/lib/feedback-pipeline-fields.js');

const ID = 'cyrano-de-bergerac-west-end-2026';
const plan = JSON.parse(fs.readFileSync(new URL('../../data/pending-fixes/bro-3565.json', import.meta.url), 'utf8'));
const edit = plan.plan.actions[0];

test('plan is a valid cast edit with the 2026 leads', () => {
  assert.equal(edit.showId, ID);
  assert.equal(edit.field, 'cast');
  assert.equal(castValueProblem(edit.newValue), null);
  const names = edit.newValue.map((m) => m.name);
  assert.ok(names.includes('Adrian Lester') && names.includes('Levi Brown'));
  assert.ok(!names.includes('Jacques Aubuchon'));
});

const dataPath = new URL('../../data/shows.json', import.meta.url);
test('shows.json cast is the 2026 cast (runs once the plan is applied)', { skip: !fs.existsSync(dataPath) }, () => {
  const show = JSON.parse(fs.readFileSync(dataPath, 'utf8')).shows.find((s) => s.id === ID);
  const names = (show.cast || []).map((m) => m.name);
  assert.ok(names.includes('Adrian Lester') && names.includes('Levi Brown'), 'cast lacks the 2026 leads');
  assert.ok(!names.includes('Jacques Aubuchon'), 'still the 1946 cast');
});
