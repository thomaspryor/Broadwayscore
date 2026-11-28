// BRO-8089: junk is settled where a stub is written, and open-stub growth alerts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { intakeVerdict } = require('../../scripts/lib/pending-intake.js');
const { evaluateOpenGrowth, countOpenByEra } = require('../../scripts/lib/pending-drain-state.js');

const show = { id: 'henry-iv-off-broadway-2015', title: 'Henry IV', openingDate: '2015-11-06', closingDate: '2015-12-13' };
const ctx = { byId: new Map([[show.id, show]]), heldIndex: new Map([["https://placeholder.example/x", new Set(["z"])]]) };

test('intake settles a stub dated outside the production window (show-score junk)', () => {
  const v = intakeVerdict({ url: 'http://variety.com/2014/legit/reviews/london-theater-review-henry-iv-1201325786/', publishDate: '2014-10-10', source: 'show-score' }, show.id, { ctx });
  assert.equal(v.verdict, 'junk');
});
test('intake settles an off-topic section (site-search junk)', () => {
  const v = intakeVerdict({ url: 'https://www.hollywoodreporter.com/tv/tv-reviews/rain-dogs-review-1235339861/', source: 'site-search' }, show.id, { ctx });
  assert.equal(v.verdict, 'junk');
});
test('intake lets a plausible in-window review through as a candidate', () => {
  const v = intakeVerdict({ url: 'https://www.nytimes.com/2015/11/07/theater/henry-iv-review.html', publishDate: '2015-11-07' }, show.id, { ctx });
  assert.equal(v.verdict, 'candidate');
});
test('intake fails OPEN when context cannot load', () => {
  const v = intakeVerdict({ url: 'https://x.com/a', publishDate: '1999-01-01' }, show.id, { dataDir: '/nonexistent' });
  assert.equal(v.verdict, 'candidate');
});

test('class guard: the _pending writer in gather-reviews consults the intake triage before writing', () => {
  const src = fs.readFileSync(new URL('../../scripts/gather-reviews.js', import.meta.url), 'utf8');
  const i = src.indexOf("require('./lib/pending-intake').intakeVerdict");
  const w = src.indexOf('fs.writeFileSync(pendingPath');
  assert.ok(i > 0 && w > i, 'intakeVerdict must run before the raw _pending write');
});

const row = (at, o) => ({ at, scope: 'all-pending', openByEra: { '2025-26': 0, '2015-24': 0, 'pre-2015': 0, ...o } });
test('open growth fires when an era rises >=25 week over week', () => {
  const r = evaluateOpenGrowth([row('2026-11-08T00:00:00Z', { '2025-26': 100 }), row('2026-11-15T00:00:00Z', { '2025-26': 160 })]);
  assert.equal(r.firing, true);
  assert.deepEqual(r.eras.map((e) => e.era), ['2025-26']);
});
test('open growth quiet when flat, shrinking, or comparison row is under 6 days old', () => {
  assert.equal(evaluateOpenGrowth([row('2026-11-08T00:00:00Z', { '2025-26': 100 }), row('2026-11-15T00:00:00Z', { '2025-26': 90 })]).firing, false);
  assert.equal(evaluateOpenGrowth([row('2026-11-14T00:00:00Z', { '2025-26': 10 }), row('2026-11-15T00:00:00Z', { '2025-26': 500 })]).firing, false);
});
test('countOpenByEra skips settled stubs and buckets by show-id year', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pend-'));
  for (const [sid, f, data] of [['a-2026', '1.json', {}], ['a-2026', '2.json', { promoteSkippedReason: 'x' }], ['b-2016', '3.json', {}], ['c-1990', '4.json', {}]]) {
    fs.mkdirSync(path.join(d, sid), { recursive: true });
    fs.writeFileSync(path.join(d, sid, f), JSON.stringify(data));
  }
  assert.deepEqual(countOpenByEra(d), { '2025-26': 1, '2015-24': 1, 'pre-2015': 1 });
});

// BRO-8089: the date_implausible quarantine (158 of 213 junk stubs/14d) settles at write time.
test('review-write-guard date_implausible quarantine is tagged settled at intake, kept on disk', () => {
  const { safeWriteReview, _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');
  const { _setContextForTests, _resetForTests } = require('../../scripts/lib/pending-intake.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-q-'));
  const sid = 'cyrano-de-bergerac-west-end-2026';
  const showRow = { id: sid, title: 'Cyrano de Bergerac', previewsStartDate: '2026-03-10', openingDate: '2026-03-25', closingDate: '2026-06-01' };
  _setShowsCacheForTest(new Map([[sid, showRow]]));
  _setContextForTests({ byId: new Map([[sid, showRow]]), heldIndex: new Map() });
  try {
    const target = path.join(root, sid, 'guardian--arifa-akbar.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const r = safeWriteReview(target, { publishDate: '2025-08-01', criticName: 'Arifa Akbar', url: 'https://example.com/x' });
    assert.equal(r.skipped, 'date_implausible');
    assert.ok(r.quarantinedPath, 'still reported quarantined so move-then-delete callers keep their source safe');
    const q = JSON.parse(fs.readFileSync(path.join(root, '_pending', sid, 'guardian--arifa-akbar.json'), 'utf8'));
    assert.match(q.promoteSkippedReason, /BRO-8089 intake triage/);
    assert.ok(q.promoteSkippedAt);
    const { isSettledPendingStub } = require('../../scripts/lib/pending-triage.js');
    assert.equal(isSettledPendingStub(q), true);
  } finally { _resetForTests(); }
});
