/**
 * BRO-7268: the push E2E job must not gate main on visual-regression.spec.ts.
 *
 * That spec diffs LIVE prod against baselines only the scheduled Visual
 * Regression job refreshes, so every approved hero change (BRO-7628's
 * "Seen it?" link) kept main red until the next cron. The push E2E run skips
 * it via E2E_SKIP_PROD_VISUAL_BASELINES=1 and re-runs it in an advisory
 * (continue-on-error) step; the scheduled job still owns the baselines.
 *
 * Behavioural, not textual: `playwright test --list` is run with and without
 * the env var (no browser needed), and test.yml is parsed with js-yaml.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SPEC = 'visual-regression.spec.ts';

function listSpecs(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.RUN_UGC_TESTS;
  if (!('E2E_SKIP_PROD_VISUAL_BASELINES' in extraEnv)) delete env.E2E_SKIP_PROD_VISUAL_BASELINES;
  // --reporter=list: keep --list from overwriting a real run's html/json reports.
  return execFileSync('npx', ['playwright', 'test', '--list', '--project=chromium', '--reporter=list'], {
    cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  });
}

function listsSpec(out) {
  // Lines look like "[chromium] › visual-regression.spec.ts:35:7 › ...";
  // ugc-visual-regression.spec.ts must not count as a match.
  return out.split('\n').some((l) => new RegExp(`(^|[\\s/›])${SPEC.replace('.', '\\.')}:`).test(l));
}

// --list imports every spec; show-pages.spec.ts reads data/shows.json at load,
// so without core data (fresh clone, cloud) listing fails for unrelated reasons.
const HAS_CORE_DATA = fs.existsSync(new URL('../../data/shows.json', import.meta.url));

test('config skips visual-regression.spec.ts only when E2E_SKIP_PROD_VISUAL_BASELINES=1', { skip: !HAS_CORE_DATA && 'no data/shows.json (core data not checked out)' }, () => {
  assert.ok(listsSpec(listSpecs({})), 'spec should be listed by default (scheduled job and local runs need it)');
  assert.ok(!listsSpec(listSpecs({ E2E_SKIP_PROD_VISUAL_BASELINES: '1' })), 'spec must be skipped when the env var is 1');
});

const wf = yaml.load(fs.readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));

test('push E2E step sets the skip env var; advisory step re-runs the spec without failing the job', () => {
  const steps = wf.jobs['e2e-tests'].steps;
  const run = steps.find((s) => s.name === 'Run E2E tests');
  assert.ok(run, 'Run E2E tests step exists');
  assert.equal(String(run.env?.E2E_SKIP_PROD_VISUAL_BASELINES), '1');

  const advisory = steps.find((s) => typeof s.run === 'string' && s.run.includes(`tests/e2e/${SPEC}`));
  assert.ok(advisory, 'an advisory step still runs the visual spec on push');
  assert.equal(advisory['continue-on-error'], true, 'advisory step must not turn main red');
  assert.ok(!advisory.env?.E2E_SKIP_PROD_VISUAL_BASELINES, 'advisory step must not skip the spec it runs');
  assert.ok(steps.indexOf(advisory) > steps.indexOf(run));
});

test('scheduled Visual Regression job still runs the spec without the skip', () => {
  const steps = wf.jobs['visual-regression'].steps;
  const vr = steps.find((s) => typeof s.run === 'string' && s.run.includes(`tests/e2e/${SPEC}`));
  assert.ok(vr, 'visual-regression job runs the spec');
  assert.ok(!vr.env?.E2E_SKIP_PROD_VISUAL_BASELINES);
});

test('push paths trigger CI when the config or test.yml change', () => {
  const paths = wf.on?.push?.paths ?? wf[true]?.push?.paths;
  assert.ok(paths.includes('playwright.config.ts'));
  assert.ok(paths.includes('.github/workflows/test.yml'));
});
