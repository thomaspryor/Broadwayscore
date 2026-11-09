// The go-live-now skill's cancel lists must agree with the press-night planner (BRO-7198), which holds the reasons.
// The first version of the skill called Critics' Take, a running demo build and "Land retry on cancel" safe to cancel;
// each has side effects (a partial Critics' Take file, a stale demo alias, a lost re-run of tonight's fix).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const planner = require('./press-night-priority.js');
const skill = readFileSync(path.join(root, '.claude/skills/go-live-now/skill.md'), 'utf8');

function section(startLabel, endLabel) {
  const a = skill.indexOf(startLabel);
  assert.ok(a >= 0, `skill has a "${startLabel}" list`);
  const b = skill.indexOf(endLabel, a + startLabel.length);
  return skill.slice(a, b < 0 ? undefined : b);
}
const ymls = (text) => new Set([...text.matchAll(/`([a-z0-9-]+\.yml)`/g)].map((m) => `.github/workflows/${m[1]}`));

const safe = ymls(section('Safe to cancel', 'Never cancel'));
const never = ymls(section('Never cancel', '## 3.'));
const plannerSafe = new Set(Object.keys({
  ...planner.AUTO_SAFE, ...planner.AUTO_QUEUED_ONLY, ...planner.AUTO_OTHER_SHOW,
  ...planner.MANUAL_MAIN_PUSH, ...planner.MANUAL_OTHER_SHOW, ...planner.MANUAL_SAFE,
  [planner.LANE_LIVE]: 'shadow runs for other shows',
}));
const CRITICS_TAKE = '.github/workflows/update-critic-consensus.yml';

test('every workflow the skill calls safe to cancel is on a planner safe list and never on its never list', () => {
  assert.ok(safe.size >= 8, `parsed ${safe.size} safe workflows`);
  for (const wf of safe) {
    if (wf === '.github/workflows/land.yml') continue; // other sessions' queued landings, a person's call (planner never automates it)
    assert.ok(plannerSafe.has(wf), `${wf} is called safe by the skill but is on no planner safe list`);
    assert.ok(!planner.NEVER.has(wf), `${wf} is called safe by the skill but the planner never cancels it`);
  }
});

test("the skill's never list covers the planner's never list, Critics' Take included", () => {
  for (const wf of planner.NEVER) {
    if (wf === '.github/workflows/land.yml') continue; // listed with its condition (past the landing mutex)
    assert.ok(never.has(wf), `${wf} is never cancelled by the planner but missing from the skill's never list`);
  }
  assert.ok(never.has(CRITICS_TAKE), "Critics' Take publishes a partial file when cancelled");
  assert.ok(!safe.has(CRITICS_TAKE));
  assert.ok(!safe.has('.github/workflows/land-retry-cancelled.yml'));
});

test('no workflow is on both of the skill lists', () => {
  // land.yml is on both with opposite conditions (queued vs past the landing mutex).
  const both = [...safe].filter((wf) => never.has(wf) && wf !== '.github/workflows/land.yml');
  assert.deepEqual(both, []);
});

test('scoring and watchdog are called safe only while queued, matching the planner', () => {
  const block = section('Safe to cancel', 'Never cancel');
  const line = block.slice(block.indexOf('`llm-ensemble-score.yml`'), block.indexOf('`test.yml`'));
  assert.match(line, /queued/);
});
