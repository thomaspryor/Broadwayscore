// BRO-5129: explainExclusion (the mirror) vs rebuild-all-reviews.js alignment.
//   1. opts.rebuildExclusions defers to the rebuild's own list, only for the
//      cross-file / score-state passes a per-file mirror cannot see;
//   2. the census compares alignedRule when present, census counts keep `rule`;
//   3. a duplicateOf copy whose reference the rebuild excludes for a non-content
//      reason is recovered, as the rebuild's refExcluded branch does.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { explainExclusion, rebuildOnlyPassExclusion } = require('../../scripts/lib/review-guards');
const { compareToRebuildExclusions, buildCensus } = require('../../scripts/lib/exclusion-rule-census');
const { wholeShowSkippedIds } = require('../../scripts/exclusion-rule-census');

const TEXT = 'The production is a triumph of staging and nerve. '.repeat(30);
const review = (extra = {}) => ({
  outletId: 'variety', outlet: 'Variety', criticName: 'Frank Rizzo',
  url: 'https://variety.com/2022/legit/reviews/x-1/', fullText: TEXT,
  contentTier: 'complete', llmScore: { score: 80, confidence: 'high' }, assignedScore: 80, ...extra,
});

describe('rebuildOnlyPassExclusion', () => {
  test('returns the rebuild reason only for whitelisted passes', () => {
    const list = { 'a.json': 'skippedDuplicateText', 'b.json': 'skippedCrossMarket', 'c.json': 'skippedNoScore' };
    assert.equal(rebuildOnlyPassExclusion('/x/show/a.json', list), 'skippedDuplicateText');
    assert.equal(rebuildOnlyPassExclusion('/x/show/b.json', list), null, 'per-file rule is never delegated');
    assert.equal(rebuildOnlyPassExclusion('/x/show/c.json', list), 'skippedNoScore');
    assert.equal(rebuildOnlyPassExclusion('/x/show/d.json', list), null);
    assert.equal(rebuildOnlyPassExclusion('/x/show/toString', list), null, 'no prototype keys');
    assert.equal(rebuildOnlyPassExclusion(undefined, list), null);
  });

  test('explainExclusion: own verdict wins, rebuild list fills only an "included"', () => {
    const fp = '/nonexistent/show/a.json';
    const data = review();
    assert.equal(explainExclusion(data, undefined, fp), null);
    assert.equal(explainExclusion(data, undefined, fp, { rebuildExclusions: { 'a.json': 'skippedUnknownCriticDedup' } }), 'skippedUnknownCriticDedup');
    assert.equal(explainExclusion(data, undefined, fp, { rebuildExclusions: { 'a.json': 'skippedInvalidUrl' } }), null);
    const flagged = review({ wrongShow: true });
    const own = explainExclusion(flagged, undefined, fp);
    assert.ok(own);
    assert.equal(explainExclusion(flagged, undefined, fp, { rebuildExclusions: { 'a.json': 'skippedDuplicateText' } }), own);
  });
});

describe('census comparison uses alignedRule', () => {
  test('alignedRule closes a dedup disagreement, census counts stay on rule', () => {
    const records = [
      { showId: 's', file: 'a.json', rule: null, alignedRule: 'skippedDuplicateText' },
      { showId: 's', file: 'b.json', rule: null, alignedRule: null },
      { showId: 's', file: 'c.json', rule: null },
    ];
    const lists = { s: { 'a.json': 'skippedDuplicateText', 'c.json': 'skippedCrossMarket' } };
    const cmp = compareToRebuildExclusions(records, { rebuildExcludedByShow: lists });
    assert.equal(cmp.agreeExcluded, 1);
    assert.equal(cmp.rebuildOnly, 1);
    assert.deepEqual(cmp.rebuildOnlyByReason, { skippedCrossMarket: 1 });
    assert.equal(buildCensus(records).totalExcluded, 0);
  });

  test('wholeShowSkippedIds: upcoming and Broadway previews shows, not open ones', () => {
    const byId = {
      up: { id: 'up', status: 'upcoming', category: 'west-end' },
      pv: { id: 'pv', status: 'previews', category: 'broadway' },
      we: { id: 'we', status: 'previews', category: 'west-end' },
      op: { id: 'op', status: 'open' },
    };
    assert.deepEqual([...wholeShowSkippedIds(byId, ['up', 'pv', 'we', 'op', 'missing'])].sort(), ['pv', 'up']);
  });
});

describe('duplicateOf: census path recovers a copy whose reference the rebuild excludes', () => {
  function pair(refExtra, dupExtra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5129-'));
    fs.writeFileSync(path.join(dir, 'variety--peter-marks.json'), JSON.stringify(review({ criticName: 'Peter Marks', ...refExtra })));
    const dupPath = path.join(dir, 'variety--frank-rizzo.json');
    const dup = review({ duplicateOf: 'variety--peter-marks.json', ...dupExtra });
    fs.writeFileSync(dupPath, JSON.stringify(dup));
    return { dup, dupPath, dir };
  }
  // The census path: any rebuildExclusions map (even empty) turns the alignment on.
  const census = (dup, dupPath) => explainExclusion(dup, undefined, dupPath, { rebuildExclusions: {} });

  test('reference includable: copy excluded on both paths', () => {
    const { dup, dupPath } = pair({});
    assert.equal(explainExclusion(dup, undefined, dupPath), 'duplicateOf');
    assert.equal(census(dup, dupPath), 'duplicateOf');
  });

  test('reference excluded for wrongAttribution: default unchanged (excluded), census path recovers', () => {
    const { dup, dupPath } = pair({ wrongAttribution: true });
    assert.equal(explainExclusion(dup, undefined, dupPath), 'duplicateOf', 'default behaviour must not change');
    assert.equal(explainExclusion(dup, undefined, dupPath, { forScoring: true }), 'duplicateOf', 'scorer path unchanged');
    assert.equal(census(dup, dupPath), null);
  });

  test('reference excluded for wrong content the copy shares: copy inherits it', () => {
    const { dup, dupPath } = pair({ wrongShow: true });
    assert.equal(explainExclusion(dup, undefined, dupPath), 'duplicateOf');
    assert.equal(census(dup, dupPath), 'duplicateOf');
  });

  test('inheritance cleared by a human: census path recovers', () => {
    const { dup, dupPath } = pair({ wrongShow: true }, { duplicateOfFlagInheritanceCleared: true });
    assert.equal(census(dup, dupPath), null);
  });

  test('reference is itself a copy (crossOutletDuplicate / personalRepost): never recovered, no double count', () => {
    for (const [expected, refExtra] of [
      ['crossOutletDuplicate', { crossOutletDuplicate: true }],
      ['personalRepost', { url: 'https://showriz.com/2026/x-review/', title: 'My Variety Review: X' }],
    ]) {
      const { dup, dupPath, dir } = pair(refExtra);
      const refPath = path.join(dir, 'variety--peter-marks.json');
      assert.equal(explainExclusion(JSON.parse(fs.readFileSync(refPath, 'utf8')), undefined, refPath), expected, 'fixture must trigger the copy rule');
      assert.equal(census(dup, dupPath), 'duplicateOf', `${expected} reference must not release its copy`);
      assert.equal(explainExclusion(dup, undefined, dupPath), 'duplicateOf');
    }
  });
});
