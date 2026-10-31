/**
 * BRO-2757: the opening-night poller and Express emit stage-latency events
 * (review-first-seen, review-text-collected, scored) but only staged
 * data/audit/*.json, which never matches data/audit/stage-latency.jsonl, so
 * every event died with the runner and the monitor's coverage metric read
 * every outlet as a missed discovery. Pins the persistence wiring.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const stepsOf = (rel) => Object.values(yaml.load(read(rel)).jobs).flatMap((j) => j.steps || []);
const ACTION = './.github/actions/commit-stage-latency';

describe('commit-stage-latency composite action', () => {
  const action = yaml.load(read('.github/actions/commit-stage-latency/action.yml'));
  const run = action.runs.steps.map((s) => s.run || '').join('\n');

  test('stages exactly the .jsonl log and pushes it', () => {
    assert.match(run, /git add data\/audit\/stage-latency\.jsonl\b/);
    // Pathspec-scoped so a stranded earlier commit's staged files never ride along.
    assert.match(run, /git commit -m [^\n]*-- data\/audit\/stage-latency\.jsonl/);
    assert.match(run, /push-with-retry\.sh/);
  });

  test('a failed push is never a job failure: callers are continue-on-error, the push is not masked (BRO-4730)', () => {
    assert.doesNotMatch(run, /push-with-retry\.sh[^\n]*\|\|/);
    for (const wf of ['opening-night-poller', 'opening-night-express']) {
      const callers = stepsOf(`.github/workflows/${wf}.yml`).filter((s) => s.uses === ACTION);
      assert.ok(callers.length > 0 && callers.every((s) => s['continue-on-error'] === true), `${wf} caller must set continue-on-error: true`);
    }
  });

  test('union merge keeps concurrent appends from conflicting', () => {
    assert.match(read('.gitattributes'), /^data\/audit\/stage-latency\.jsonl\s+merge=union/m);
  });
});

for (const [wf, emitter] of [
  ['.github/workflows/opening-night-poller.yml', /collect-review-texts\.js/],
  ['.github/workflows/opening-night-express.yml', /llm-scoring\/index\.ts/],
]) {
  describe(`${wf} persists stage-latency events`, () => {
    const steps = stepsOf(wf);
    const idx = steps.findIndex((s) => s.uses === ACTION);

    test('uses the commit-stage-latency action', () => {
      assert.ok(idx >= 0, `${wf} never commits data/audit/stage-latency.jsonl`);
    });

    test('runs always() with continue-on-error, after the last emitting step', () => {
      const step = steps[idx];
      assert.match(String(step.if), /always\(\)/);
      assert.strictEqual(step['continue-on-error'], true);
      const lastEmit = steps.map((s) => String(s.run || '')).findLastIndex((r) => emitter.test(r));
      assert.ok(lastEmit >= 0 && idx > lastEmit, 'commit step must come after the emitting step');
    });
  });
}

test('poller readiness-only rebuild does not log early rebuilt events', () => {
  const step = stepsOf('.github/workflows/opening-night-poller.yml').find((s) => s.id === 'readiness_rebuild');
  assert.strictEqual(step.env && step.env.BSC_STAGE_LATENCY_MUTE, '1');
});
