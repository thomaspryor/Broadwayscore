// BRO-3108: llm-ensemble-score.yml must dispatch its rebuild only when the
// review-texts push actually pushed. has_changes alone is true on every run
// (scoring-progress.json is always rewritten), so runs that logged "No
// review-texts changes to push" still dispatched rebuild-fast (38399219408).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/llm-ensemble-score.yml'), 'utf8'));
const action = yaml.load(fs.readFileSync(path.join(ROOT, '.github/actions/push-review-texts/action.yml'), 'utf8'));
const steps = Object.values(wf.jobs).flatMap(j => j.steps || []);

test('push-review-texts exposes a pushed output from an id-ed step', () => {
  assert.equal(action.outputs.pushed.value, '${{ steps.push.outputs.pushed }}');
  const step = action.runs.steps.find(s => s.id === 'push');
  assert.ok(step, 'composite step with id: push');
  // Every successful git push path records pushed=true before exiting.
  const pushes = (step.run.match(/if git push origin main/g) || []).length;
  const marks = (step.run.match(/echo "pushed=true" >> "\$GITHUB_OUTPUT"/g) || []).length;
  assert.ok(pushes >= 2);
  assert.equal(marks, pushes);
});

test('auto-trigger rebuild is gated on the review-texts push having pushed', () => {
  const push = steps.find(s => s.name === 'Push review-texts to private repo');
  const rebuild = steps.find(s => s.name === 'Auto-trigger rebuild for non-chain runs');
  assert.equal(push.id, 'push-review-texts');
  assert.match(rebuild.if, /steps\.push-review-texts\.outputs\.pushed == 'true'/);
  assert.ok(steps.indexOf(push) < steps.indexOf(rebuild), 'push runs before the rebuild dispatch');
});
