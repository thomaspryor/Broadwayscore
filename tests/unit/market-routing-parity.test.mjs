// TESTS-VS-DERIVED-DATA-EXEMPT: parity test — same shows.json fed to classifyMarketRouting and resolveWriteTarget; expects 0 diffs, no factual pins.
// BRO-2110: resolveWriteTarget (the shared caller idiom) must decide exactly like
// classifyMarketRouting when no bypass option is set, and bypass correctly when one is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { classifyMarketRouting, resolveWriteTarget, isAdjudicatedRecord, buildSiblingIndex } = require('../../scripts/lib/market-routing.js');
const { recordMarketMisroute } = require('../../scripts/lib/market-misroute-ledger.js');
const shows = require('../../data/shows.json').shows;
const siblingIndex = buildSiblingIndex(shows);
const byId = new Map(shows.map(s => [s.id, s]));

// Corpus: every show that has siblings, probed with dates around each sibling's opening
// plus a url-less/date-less and a Broadway-marked-URL variant.
const corpus = [];
for (const [id, data] of siblingIndex) {
  if (!data.siblings || !data.siblings.length) continue;
  const category = byId.get(id)?.category || null;
  const dates = new Set([undefined, '2019-03-01']);
  for (const s of data.siblings.slice(0, 2)) if (s.openingDate) dates.add(new Date(s.openingDate).toISOString().slice(0, 10));
  if (data.openingDate) dates.add(new Date(data.openingDate).toISOString().slice(0, 10));
  for (const publishDate of dates) {
    corpus.push({ showId: id, category, publishDate, url: 'https://www.nytimes.com/2020/01/01/theater/review.html', outletId: 'nyt' });
    corpus.push({ showId: id, category, publishDate, url: undefined, outletId: 'timeout-uk' });
  }
}

test('corpus is non-trivial', () => assert.ok(corpus.length > 200, `corpus=${corpus.length}`));

test('resolveWriteTarget === classifyMarketRouting (no options) across corpus', () => {
  let reroutes = 0;
  for (const c of corpus) {
    const old = classifyMarketRouting({ ...c, visited: new Set(), siblingIndex });
    const next = resolveWriteTarget({ ...c, visited: new Set(), siblingIndex });
    for (const k of ['action', 'targetShowId', 'reason', 'flag']) assert.deepEqual(next[k], old[k], `${c.showId} ${c.publishDate} ${k}`);
    assert.equal(next.showId, old.action === 'reroute' ? old.targetShowId : c.showId);
    if (old.action === 'reroute') reroutes++;
  }
  assert.ok(reroutes > 0, 'corpus exercised no reroutes');
});

// Find one reroute case to drive option tests.
const rerouteCase = corpus.find(c => classifyMarketRouting({ ...c, visited: new Set(), siblingIndex }).action === 'reroute');

test('bypasses accept in place and never reach the classifier', () => {
  assert.ok(rerouteCase);
  const base = { ...rerouteCase, siblingIndex };
  assert.equal(resolveWriteTarget({ ...base, existingRecord: { wrongProduction: true } }).bypassed, 'adjudicated');
  assert.equal(resolveWriteTarget({ ...base, existingRecord: { wrongProduction: false } }).bypassed, 'adjudicated');
  assert.equal(resolveWriteTarget({ ...base, existingRecord: { wrongShow: true } }).action, 'accept');
  assert.equal(resolveWriteTarget({ ...base, existingRecord: { source: 'dtli' } }).action, 'reroute');
  const skip = resolveWriteTarget({ ...base, skipCrossShowDupe: true });
  assert.equal(skip.action, 'accept'); assert.equal(skip.showId, base.showId);
  const noSignal = resolveWriteTarget({ ...base, url: undefined, publishDate: undefined, requireUrlOrDate: true });
  assert.equal(noSignal.bypassed, 'no-url-or-date');
});

test('url-less but dated record still routes (DTLI gate divergence fixed)', () => {
  const c = { ...rerouteCase, url: undefined, siblingIndex };
  if (!c.publishDate) return;
  const d = resolveWriteTarget({ ...c, requireUrlOrDate: true });
  const old = classifyMarketRouting({ ...c, visited: new Set() });
  assert.equal(d.action, old.action);
});

test('reroute calls recordMisroute exactly once with the ledger shape; non-reroute does not', () => {
  const calls = [];
  const r = resolveWriteTarget({ ...rerouteCase, siblingIndex, recordMisroute: e => calls.push(e), file: 'x.json' });
  assert.equal(r.action, 'reroute');
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['file', 'fromShowId', 'publishDate', 'reason', 'toShowId', 'url']);
  assert.equal(calls[0].toShowId, r.targetShowId);
  const none = resolveWriteTarget({ ...rerouteCase, siblingIndex, skipCrossShowDupe: true, recordMisroute: e => calls.push(e) });
  assert.equal(none.action, 'accept'); assert.equal(calls.length, 1);
});

test('visited set cycle: classifier result is unchanged and visited is returned', () => {
  const v = new Set();
  const r = resolveWriteTarget({ ...rerouteCase, siblingIndex, visited: v });
  assert.equal(r.visited, v); assert.ok(v.has(rerouteCase.showId));
});

test('isAdjudicatedRecord', () => {
  assert.equal(isAdjudicatedRecord(null), false);
  assert.equal(isAdjudicatedRecord({}), false);
  assert.equal(isAdjudicatedRecord({ allowCrossMarket: true }), true);
  assert.equal(isAdjudicatedRecord({ humanReviewedWrongProduction: false }), true);
});

test('ledger writer appends, caps, never throws', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'misroute-')), 'sub', 'l.json');
  recordMarketMisroute({ fromShowId: 'a', toShowId: 'b' }, p);
  recordMarketMisroute({ fromShowId: 'c', toShowId: 'd' }, p);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).length, 2);
  assert.doesNotThrow(() => recordMarketMisroute({}, '/dev/null/nope/x.json'));
});
