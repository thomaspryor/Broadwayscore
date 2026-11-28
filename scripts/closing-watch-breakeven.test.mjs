// LIVE-DATA-LANE: reads data/commercial.json, data/shows.json and data/grosses-history.json (bot-rewritten core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7254: break-even provenance (breakEvenSource / breakEvenQuality) and the
// Closing Watch leave-one-show-out backtest. Real functions only (CLAUDE.md
// rule 15). Data checks skip when the private data is not on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('tsx/cjs');
const { getBreakEven } = require('../src/lib/commercial-display.ts');
const {
  BREAK_EVEN_QUALITIES, displayedBreakEvenKind, breakEvenProvenance, stampBreakEvenProvenance, breakEvenProvenanceErrors,
} = require('./lib/break-even-provenance.js');
const { createCommercialWriteGuard } = require('./lib/commercial-write-guard.js');
const { commercialRecordErrors } = require('./lib/commercial-record-checks.js');
const { FEEDBACK_EDITABLE_FIELDS } = require('./lib/feedback-pipeline-fields.js');
const { runClosingWatchBacktest, loadBacktestInputs, hasBacktestData, FALSE_ALARM_WEEKS } = await import('./backtest-closing-watch.mjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const haveData = hasBacktestData(DATA);
const NAMED = ['the-lost-boys', 'schmigadoon', 'the-rocky-horror-show', 'wanted'];
const REDDIT_SRC = 'Estimate by u/someone on r/Broadway, "GROSSES ANALYSIS" (2026-10-01) https://www.reddit.com/r/Broadway/comments/x/';
const TRADE_SRC = 'Forbes (Nov 17, 2025): fixed weekly operating costs of $480,577 https://www.forbes.com/sites/x/';

const fixtures = {
  reportedModel: { weeklyRunningCost: 480_577, costMethodology: 'trade-reported', weeklyRunningCostSource: TRADE_SRC, weeklyRunningCostBasis: 'running', modelBreakeven: 587_313, modelDataQuality: 'high', modelMethod: 'weekly-model' },
  redditMarkedTrade: { weeklyRunningCost: 700_000, costMethodology: 'trade-reported', weeklyRunningCostSource: REDDIT_SRC, modelBreakeven: 855_469, modelDataQuality: 'low', modelMethod: 'weekly-model' },
  redditModel: { weeklyRunningCost: 750_000, costMethodology: 'reddit-standard', weeklyRunningCostSource: REDDIT_SRC, modelBreakeven: 916_574, modelDataQuality: 'medium', modelMethod: 'weekly-model' },
  typeDefault: { weeklyRunningCost: null, modelBreakeven: 714_971, modelDataQuality: 'medium', modelMethod: 'weekly-model', modelInputBasis: [{ input: 'weeklyRunningCost', basis: 'type-default' }] },
  lowModelOnly: { weeklyRunningCost: null, modelBreakeven: 805_342, modelDataQuality: 'low', modelMethod: 'weekly-model' },
  staleModel: { weeklyRunningCost: 560_000, costMethodology: 'reddit-standard', weeklyRunningCostSource: REDDIT_SRC, modelBreakeven: 536_585, modelDataQuality: 'medium', modelMethod: 'weekly-model' },
  nothing: { weeklyRunningCost: null },
};

test('displayedBreakEvenKind agrees with getBreakEven on fixtures', () => {
  for (const [name, rec] of Object.entries(fixtures)) {
    const kind = displayedBreakEvenKind(rec);
    const be = getBreakEven(rec);
    const expected = kind === 'model' ? rec.modelBreakeven : kind === 'cost' ? rec.weeklyRunningCost : null;
    assert.equal(be, expected, name);
  }
});

test('quality: reported only on a cited press cost; reddit or uncited figures are estimated', () => {
  assert.equal(breakEvenProvenance(fixtures.reportedModel).breakEvenQuality, 'reported');
  const wanted = breakEvenProvenance(fixtures.redditMarkedTrade);
  assert.equal(wanted.breakEvenQuality, 'estimated', 'a trade-reported label on a forum estimate is still an estimate');
  assert.match(wanted.breakEvenSource, /cited source is an estimate/);
  assert.equal(breakEvenProvenance(fixtures.redditModel).breakEvenQuality, 'estimated');
  assert.match(breakEvenProvenance(fixtures.typeDefault).breakEvenSource, /default weekly cost/);
  assert.equal(breakEvenProvenance(fixtures.typeDefault).breakEvenQuality, 'estimated');
  assert.equal(breakEvenProvenance(fixtures.lowModelOnly).breakEvenQuality, 'unavailable');
  assert.equal(breakEvenProvenance(fixtures.nothing).breakEvenQuality, 'unavailable');
  for (const rec of Object.values(fixtures)) {
    const { breakEvenSource, breakEvenQuality } = breakEvenProvenance(rec);
    assert.ok(BREAK_EVEN_QUALITIES.includes(breakEvenQuality));
    assert.doesNotMatch(breakEvenSource, /u\/|r\/Broadway|reddit|\$\d/i, 'never copies handles, forum names or figures');
  }
});

test('stampBreakEvenProvenance is idempotent', () => {
  const rec = { ...fixtures.redditModel };
  assert.equal(stampBreakEvenProvenance(rec), true);
  assert.equal(stampBreakEvenProvenance(rec), false);
  rec.weeklyRunningCostSource = TRADE_SRC;
  rec.costMethodology = 'trade-reported';
  assert.equal(stampBreakEvenProvenance(rec), true, 'a cited cost moves the stamp');
  assert.equal(rec.breakEvenQuality, 'reported');
});

test('the commercial write guard stamps provenance on every save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7254-'));
  try {
    const file = path.join(dir, 'commercial.json');
    fs.writeFileSync(file, JSON.stringify({ _meta: {}, shows: {} }));
    const { loadCommercial, saveCommercial } = createCommercialWriteGuard(file);
    const data = loadCommercial();
    data.shows.a = { designation: 'TBD', ...fixtures.reportedModel };
    data.shows.b = { designation: 'TBD', ...fixtures.redditMarkedTrade, breakEvenQuality: 'reported' };
    saveCommercial(data);
    const out = JSON.parse(fs.readFileSync(file, 'utf8')).shows;
    assert.equal(out.a.breakEvenQuality, 'reported');
    assert.equal(out.b.breakEvenQuality, 'estimated', 'a hand-set "reported" on an estimate is overwritten');
    assert.ok(out.a.breakEvenSource && out.b.breakEvenSource);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('record checks accept a stale stamp (writers validate before the guard re-stamps) and reject junk', () => {
  // A stub stamped 'unavailable' that a writer patches with a cost must not be refused (ship-check, BRO-7254).
  const stamped = { designation: 'TBD', ...fixtures.nothing };
  stampBreakEvenProvenance(stamped);
  assert.equal(stamped.breakEvenQuality, 'unavailable');
  const patched = { ...stamped, ...fixtures.redditModel };
  assert.deepEqual(breakEvenProvenanceErrors('s', patched), []);
  assert.ok(!commercialRecordErrors('s', patched).some((e) => /breakEvenQuality/.test(e)));
  const rec = { designation: 'TBD', ...fixtures.redditModel, breakEvenQuality: 'reported', breakEvenSource: 'x' };
  assert.deepEqual(breakEvenProvenanceErrors('s', rec), []);
  assert.ok(breakEvenProvenanceErrors('s', { ...rec, breakEvenQuality: 'great' }).some((e) => /invalid breakEvenQuality/.test(e)));
  assert.deepEqual(breakEvenProvenanceErrors('s', { ...fixtures.redditModel }), [], 'absent fields are fine');
  assert.ok(FEEDBACK_EDITABLE_FIELDS['commercial.json'].includes('breakEvenSource'));
  assert.ok(FEEDBACK_EDITABLE_FIELDS['commercial.json'].includes('breakEvenQuality'));
});

test('real data: displayedBreakEvenKind matches getBreakEven on every record', { skip: !haveData && 'private data not on disk' }, () => {
  const { commercial } = loadBacktestInputs(DATA);
  for (const [slug, rec] of Object.entries(commercial)) {
    const kind = displayedBreakEvenKind(rec);
    const expected = kind === 'model' ? rec.modelBreakeven : kind === 'cost' ? rec.weeklyRunningCost : null;
    assert.equal(getBreakEven(rec) ?? null, expected ?? null, slug);
  }
});

test('real data: every running Broadway show has breakEvenSource and quality once saved through the guard', { skip: !haveData && 'private data not on disk' }, () => {
  const { shows } = loadBacktestInputs(DATA);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7254-'));
  try {
    const file = path.join(dir, 'commercial.json');
    fs.copyFileSync(path.join(DATA, 'commercial.json'), file);
    const { loadCommercial, saveCommercial } = createCommercialWriteGuard(file);
    saveCommercial(loadCommercial());
    const stamped = JSON.parse(fs.readFileSync(file, 'utf8')).shows;
    const running = shows.filter((s) => ['open', 'previews'].includes(s.status) && (!s.market || s.market === 'broadway') && stamped[s.slug]);
    assert.ok(running.length >= 30, `expected the running Broadway set, got ${running.length}`);
    for (const s of running) {
      const rec = stamped[s.slug];
      assert.ok(typeof rec.breakEvenSource === 'string' && rec.breakEvenSource.length > 10, `${s.slug} breakEvenSource`);
      assert.ok(BREAK_EVEN_QUALITIES.includes(rec.breakEvenQuality), `${s.slug} breakEvenQuality`);
      assert.deepEqual(breakEvenProvenanceErrors(s.slug, rec), []);
    }
    for (const slug of NAMED) {
      assert.equal(stamped[slug].breakEvenQuality, 'estimated', `${slug}: its weekly cost is an analyst/industry estimate, not a cited press figure`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backtest: no regression from the reconstructed baseline (54/78 in window, 3 false alarms)', { skip: !haveData && 'private data not on disk' }, () => {
  const r = runClosingWatchBacktest(loadBacktestInputs(DATA));
  assert.ok(r.forecasts >= 70, `forecasts ${r.forecasts}`);
  assert.ok(r.share >= 54 / 78 - 1e-9, `in-window share ${(r.share * 100).toFixed(2)}% fell below the 69.23% baseline`);
  assert.ok(r.falseAlarms < 12, `${r.falseAlarms} shows ran ${FALSE_ALARM_WEEKS}+ weeks after their first forecast`);
});

// Card target. Not met: no sourced break-even change reaches it (see
// docs/audits/bro-7254-break-even-baseline.md); kept visible as a TODO.
test('backtest: card target of 72% in window', { skip: !haveData && 'private data not on disk', todo: 'BRO-7254 target not reached: 69.23% (54/78); break-even changes alone cannot reach it' }, () => {
  const r = runClosingWatchBacktest(loadBacktestInputs(DATA));
  assert.ok(r.share >= 0.72, `${(r.share * 100).toFixed(2)}%`);
});
