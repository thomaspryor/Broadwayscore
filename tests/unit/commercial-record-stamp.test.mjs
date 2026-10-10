// BRO-5005: the commercial write guard stamps lastUpdated on content edits,
// never on a model-only re-run. require()s the real modules (§15).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { stampContentChanges } = require('../../scripts/lib/commercial-record-stamp');
const { createCommercialWriteGuard } = require('../../scripts/lib/commercial-write-guard');
const { mergeCommercialJson } = require('../../scripts/lib/merge-commercial-data');

const OLD = '2026-10-01T00:00:00.000Z';
const NOW = '2026-10-10T12:00:00.000Z';
const clone = (o) => JSON.parse(JSON.stringify(o));
const rec = () => ({
  designation: 'Fizzle', weeklyRunningCost: 900000, costMethodology: 'trade-reported',
  sources: [{ type: 'trade', url: 'https://example.com/a', date: '2026-09-01' }],
  modelRecoupmentPct: [40, 50, 60], modelBreakeven: 950000, modelCostBasis: 900000, modelLastRun: '2026-10-01',
  lastUpdated: OLD,
});

describe('stampContentChanges', () => {
  test('model-only change is not stamped', () => {
    const prev = { a: rec() };
    const next = clone(prev);
    Object.assign(next.a, { modelRecoupmentPct: [41, 51, 61], modelLastRun: '2026-10-10', modelRecoupmentPctV2: [1, 2, 3] });
    assert.deepEqual(stampContentChanges(next, prev, NOW).stamped, []);
    assert.equal(next.a.lastUpdated, OLD);
  });

  test('content change is stamped', () => {
    const prev = { a: rec() };
    const next = clone(prev);
    next.a.weeklyRunningCost = 1000000;
    assert.deepEqual(stampContentChanges(next, prev, NOW).stamped, ['a']);
    assert.equal(next.a.lastUpdated, NOW);
  });

  test('a caller stamp newer than disk is kept', () => {
    const prev = { a: rec() };
    const next = clone(prev);
    next.a.designation = 'Flop';
    next.a.lastUpdated = '2026-10-09T00:00:00.000Z';
    assert.deepEqual(stampContentChanges(next, prev, NOW).stamped, []);
    assert.equal(next.a.lastUpdated, '2026-10-09T00:00:00.000Z');
  });

  test('a stale copy older than disk is never stamped newest; it is reported', () => {
    const prev = { a: { ...rec(), weeklyRunningCost: 1000000, lastUpdated: '2026-10-05T00:00:00.000Z' } }; // another writer's fix
    const next = { a: rec() }; // caller loaded before that fix
    next.a.modelLastRun = '2026-10-10';
    const r = stampContentChanges(next, prev, NOW);
    assert.deepEqual(r.stamped, []);
    assert.deepEqual(r.staleOverwrites, ['a']);
    assert.equal(next.a.lastUpdated, OLD);
  });

  test('key order inside nested values is not a content change', () => {
    const prev = { a: rec() };
    const next = clone(prev);
    next.a.sources = [{ date: '2026-09-01', url: 'https://example.com/a', type: 'trade' }];
    assert.deepEqual(stampContentChanges(next, prev, NOW).stamped, []);
  });

  test('new records and missing previous file are left alone', () => {
    const next = { b: rec() };
    assert.deepEqual(stampContentChanges(next, {}, NOW).stamped, []);
    assert.deepEqual(stampContentChanges(next, null, NOW).stamped, []);
    assert.equal(next.b.lastUpdated, OLD);
  });
});

describe('through the write guard', () => {
  let tmp; let file;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-stamp-'));
    file = path.join(tmp, 'commercial.json');
    fs.writeFileSync(file, JSON.stringify({ _meta: {}, shows: { a: rec(), b: rec() } }, null, 2));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8')).shows;

  test('model-only save (already-normalized sources) does not stamp; cost save does', () => {
    const g = createCommercialWriteGuard(file);
    const d = g.loadCommercial();
    d.shows.a.modelRecoupmentPct = [1, 2, 3];
    d.shows.a.modelLastRun = '2026-10-10';
    d.shows.a.sources = clone(d.shows.a.sources);
    d.shows.b.weeklyRunningCost = 1000000;
    g.saveCommercial(d);
    const s = disk();
    assert.equal(s.a.lastUpdated, OLD);
    assert.notEqual(s.b.lastUpdated, OLD);
    assert.ok(Date.parse(s.b.lastUpdated) > Date.parse(OLD));
  });

  test('designation casing normalized by the guard does not stamp', () => {
    const g = createCommercialWriteGuard(file);
    const d = g.loadCommercial();
    d.shows.a.designation = 'fizzle';
    g.saveCommercial(d);
    assert.equal(disk().a.designation, 'Fizzle');
    assert.equal(disk().a.lastUpdated, OLD);
  });

  test('two concurrent loads: the stale model-only save is not stamped newest, and warns', () => {
    const g = createCommercialWriteGuard(file);
    const y = g.loadCommercial(); // model run loads first
    const x = g.loadCommercial();
    x.shows.a.weeklyRunningCost = 1000000; // cost fix saved in between
    g.saveCommercial(x);
    const fixStamp = disk().a.lastUpdated;
    assert.ok(Date.parse(fixStamp) > Date.parse(OLD));
    y.shows.a.modelRecoupmentPct = [5, 6, 7];
    y.shows.a.modelLastRun = '2026-10-10';
    const warns = [];
    const orig = console.warn;
    console.warn = (m) => warns.push(String(m));
    try { g.saveCommercial(y); } finally { console.warn = orig; }
    assert.equal(disk().a.lastUpdated, OLD, 'the stale copy keeps its old stamp');
    assert.ok(warns.some((w) => w.includes('"a" was saved from a copy older')), warns.join('\n'));
  });

  test('a stale model re-run cannot out-vote a same-day cost fix in the push merge', () => {
    const base = { _meta: {}, shows: { a: rec() } };
    // Remote: a cost fix saved through the guard (stamped).
    fs.writeFileSync(file, JSON.stringify(clone(base)));
    const g = createCommercialWriteGuard(file);
    const d = g.loadCommercial();
    d.shows.a.weeklyRunningCost = 1000000;
    g.saveCommercial(d);
    const remote = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Ours: a model re-run on the stale copy, saved through the guard (not stamped).
    const oursFile = path.join(tmp, 'ours', 'commercial.json');
    fs.mkdirSync(path.dirname(oursFile));
    fs.writeFileSync(oursFile, JSON.stringify(clone(base)));
    const g2 = createCommercialWriteGuard(oursFile);
    const o = g2.loadCommercial();
    o.shows.a.modelRecoupmentPct = [5, 6, 7];
    o.shows.a.modelLastRun = '2026-10-10';
    g2.saveCommercial(o);
    const ours = JSON.parse(fs.readFileSync(oursFile, 'utf8'));
    assert.equal(ours.shows.a.lastUpdated, OLD);

    for (const b of [undefined, base]) {
      const { merged } = mergeCommercialJson(ours, remote, b);
      assert.equal(merged.shows.a.weeklyRunningCost, 1000000, b ? 'with base' : 'no base');
      assert.ok(merged.shows.a.modelBreakeven >= merged.shows.a.weeklyRunningCost, 'break-even not below cost');
    }
  });
});
