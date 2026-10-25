// BRO-2320 / BRO-2321: exclusion mirror drift monitor.
// - compareToRebuildExclusions measures how often explainExclusion() (the
//   mirror) disagrees with rebuild-all-reviews.js's real per-show exclusion
//   lists.
// - buildMirrorSummary / checkMirrorSummary are the committed counts-only
//   summary and the exit contract check-corpus-drift.js's AUDITS entry reads.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildCensus,
  compareToRebuildExclusions,
  formatMirrorReport,
  buildMirrorSummary,
  checkMirrorSummary,
} = require('../../scripts/lib/exclusion-rule-census.js');
const { AUDITS } = require('../../scripts/check-corpus-drift.js');

const CLI = new URL('../../scripts/exclusion-rule-census.js', import.meta.url).pathname;

const records = [
  { showId: 'a', file: 'x.json', rule: null },            // agree included
  { showId: 'a', file: 'y.json', rule: 'wrongProduction' }, // agree excluded
  { showId: 'a', file: 'z.json', rule: 'duplicateOf' },     // mirror-only
  { showId: 'a', file: 'w.json', rule: null },              // rebuild-only
  { showId: 'b', file: 'p.json', rule: null },              // processed, no list: agree included
  { showId: 'b', file: 'q.json', rule: 'contentTierInvalid' }, // processed, no list: mirror-only
  { showId: 'c', file: 'r.json', rule: 'wrongShow' },       // never processed: not compared
];
const rebuildExcludedByShow = {
  a: { 'y.json': 'skippedWrongProduction', 'w.json': 'skippedDuplicateText', 'gone.json': 'skippedNoScore' },
};

describe('compareToRebuildExclusions (BRO-2320)', () => {
  const cmp = compareToRebuildExclusions(records, { rebuildExcludedByShow, processedShowIds: ['a', 'b'] });

  test('classifies each compared file and skips shows the rebuild never processed', () => {
    assert.equal(cmp.comparedShows, 2);
    assert.equal(cmp.comparedFiles, 6);
    assert.equal(cmp.agreeIncluded, 2);
    assert.equal(cmp.agreeExcluded, 1);
    assert.equal(cmp.mirrorOnly, 2);
    assert.equal(cmp.rebuildOnly, 1);
    assert.equal(cmp.disagreements, 3);
    assert.equal(cmp.disagreementRate, 0.5);
  });

  test('attributes disagreements to mirror rule / rebuild statKey', () => {
    assert.deepEqual(cmp.mirrorOnlyByRule, { contentTierInvalid: 1, duplicateOf: 1 });
    assert.deepEqual(cmp.rebuildOnlyByReason, { skippedDuplicateText: 1 });
    assert.equal(cmp.rebuildEntriesUnscanned, 1);
    assert.equal(cmp.notComparedShows, 1);
    assert.equal(cmp.notComparedFiles, 1);
    assert.deepEqual(cmp.topShows[0], { showId: 'a', count: 2 });
  });

  test('report names the rate and examples', () => {
    const out = formatMirrorReport(cmp);
    assert.match(out, /3 disagreements \(50\.00%\)/);
    assert.match(out, /mirror-only duplicateOf: a\/z\.json/);
    assert.match(out, /rebuild-only skippedDuplicateText: a\/w\.json/);
  });

  test('a list keyed "__proto__" does not poison lookups', () => {
    const c = compareToRebuildExclusions([{ showId: '__proto__', file: 'f.json', rule: null }], {
      rebuildExcludedByShow: {}, processedShowIds: [],
    });
    assert.equal(c.comparedFiles, 0);
  });
});

describe('mirror summary + check (BRO-2321)', () => {
  const now = new Date('2026-10-12T05:00:00Z');
  const census1 = buildCensus(records);
  const cmp = compareToRebuildExclusions(records, { rebuildExcludedByShow, processedShowIds: ['a', 'b'] });

  test('summary is counts only (no filenames) and diffs rule counts vs previous', () => {
    const first = buildMirrorSummary(census1, cmp, null, now);
    assert.equal(first.ruleDeltas, null);
    assert.equal(first.mirror.examples, undefined);
    assert.ok(!JSON.stringify(first).includes('.json'), 'summary must not carry review filenames');
    const census2 = buildCensus([...records, { showId: 'a', file: 'n.json', rule: 'wrongProduction' }]);
    const second = buildMirrorSummary(census2, cmp, first, now);
    assert.deepEqual(second.ruleDeltas, { wrongProduction: 1 });
    assert.equal(second.previousDisagreementRate, 0.5);
  });

  test('check: ok, rule jump, rate rise, stale, missing', () => {
    const base = buildMirrorSummary(census1, cmp, null, now);
    const opts = { maxRuleDelta: 200, maxRateRise: 0.01, now: now.getTime() };
    assert.deepEqual(checkMirrorSummary(base, opts), []);
    assert.match(checkMirrorSummary({ ...base, ruleDeltas: { wrongProduction: 250 } }, opts)[0], /wrongProduction moved \+250/);
    assert.match(checkMirrorSummary({ ...base, previousDisagreementRate: 0.4 }, opts)[0], /disagreement rate rose/);
    assert.match(checkMirrorSummary(base, { ...opts, now: now.getTime() + 4 * 86400000 })[0], /stale/);
    assert.match(checkMirrorSummary(null, opts)[0], /no mirror summary/);
  });
});

describe('check-corpus-drift wiring (BRO-2321)', () => {
  const entry = AUDITS.find((a) => a.name === 'exclusion-mirror');

  test('AUDITS runs the census in --check mode', () => {
    assert.ok(entry, 'expected an exclusion-mirror AUDITS entry');
    assert.equal(entry.script, 'exclusion-rule-census.js');
    assert.ok(entry.args.includes('--check'));
  });

  function runEntry(summary) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-mirror-'));
    if (summary) fs.writeFileSync(path.join(dir, 'exclusion-mirror-summary.json'), JSON.stringify(summary));
    return spawnSync(process.execPath, [CLI, ...entry.args], {
      env: { ...process.env, EXCLUSION_CENSUS_AUDIT_DIR: dir }, encoding: 'utf8',
    });
  }

  test('the entry exits 0 on a fresh, quiet summary and 1 on drift', () => {
    const fresh = buildMirrorSummary(buildCensus(records), null, null, new Date());
    const ok = runEntry(fresh);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const jumped = runEntry({ ...fresh, ruleDeltas: { duplicateOf: 999 } });
    assert.equal(jumped.status, 1);
    assert.match(jumped.stdout, /DRIFT: rule duplicateOf moved \+999/);
    assert.equal(runEntry(null).status, 1);
  });
});
