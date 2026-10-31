// TESTS-VS-DERIVED-DATA-EXEMPT: structural — parses workflow YAML and feeds the
// real ledger merge function synthetic rows; reads no data/*.json.
/**
 * BRO-6616: the opening-night lane shadow commits its own scraper-spend ledger
 * lines to main through the shared composite, and re-committing the same lines
 * adds nothing. Pattern: require() the real merge function (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { mergeScraperSpendLedger } = require('../../scripts/lib/merge-scraper-spend-ledger.js');
const { findPushWithoutWritePermission } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const ROOT = path.resolve(import.meta.dirname, '../..');
const WF_PATH = path.join(ROOT, '.github/workflows/opening-night-lane-live.yml');
const WF_TEXT = fs.readFileSync(WF_PATH, 'utf8');
const shadow = yaml.load(WF_TEXT).jobs.shadow;
const COMPOSITE = './.github/actions/commit-scraper-spend-ledger';

const row = (n, extra = {}) => ({
  ts: `2026-10-29T23:00:0${n}.000Z`,
  provider: 'brightdata',
  script: 'opening-night-lane-shadow.js',
  workflow: 'opening-night-lane-live',
  fn: 'serp-unlocker',
  success: true,
  credits: 1,
  run_seq: n,
  ...extra,
});

describe('lane shadow job commits its spend ledger', () => {
  const steps = shadow.steps;
  const runIdx = steps.findIndex((s) => /opening-night-lane-shadow\.js/.test(s.run || ''));
  const commitIdx = steps.findIndex((s) => s.uses === COMPOSITE);

  test('a composite commit step exists after the shadow run', () => {
    assert.ok(runIdx >= 0, 'shadow run step found');
    assert.ok(commitIdx > runIdx, 'commit step comes after the run step');
  });

  test('commit step is main-only, always() and non-fatal', () => {
    const s = steps[commitIdx];
    assert.match(s.if, /always\(\)/);
    assert.match(s.if, /github\.ref == 'refs\/heads\/main'/);
    assert.strictEqual(s['continue-on-error'], true);
    assert.ok(s.with['workflow-name']);
  });

  test('artifact upload is kept (90-day copy of the run)', () => {
    assert.ok(steps.some((s) => /upload-artifact/.test(s.uses || '')));
  });

  test('job can push (contents: write) and passes the push-permission rule', () => {
    assert.strictEqual(shadow.permissions.contents, 'write');
    const offenders = findPushWithoutWritePermission(WF_TEXT, 'opening-night-lane-live.yml');
    assert.deepStrictEqual(
      (offenders || []).filter((o) => /shadow/.test(JSON.stringify(o))),
      [],
    );
  });
});

describe('ledger merge is idempotent for lane lines', () => {
  const onMain = [row(1), row(2), row(3)];

  test('re-committing lines already on main adds nothing', () => {
    const { merged, stats } = mergeScraperSpendLedger(onMain, onMain.map((r) => ({ ...r })));
    assert.strictEqual(stats.added, 0);
    assert.strictEqual(merged.length, onMain.length);
  });

  test('a shadow run on a stale base unions with concurrent main rows', () => {
    const shadowSide = [row(1), row(4)];
    const mainSide = [row(1), row(2, { script: 'gather-reviews.js' })];
    const { merged, stats } = mergeScraperSpendLedger(shadowSide, mainSide);
    assert.strictEqual(stats.added, 1);
    assert.strictEqual(merged.length, 3);
  });
});
