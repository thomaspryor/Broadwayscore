/**
 * BRO-7369: earlier-production audience input. require()s the real modules.
 * Run: node --test tests/unit/review-forecast-v2-earlier-audience.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const RF = require('../../scripts/lib/review-forecast.js');
const EA = require('../../scripts/lib/review-forecast-v2-earlier-audience.js');

const target = { id: 'T', openingDate: '2015-03-12', previewsStartDate: '2015-02-20' };

test('cutoff is the day before the first preview, never later than opening minus the lag', () => {
  assert.equal(EA.earlierCutoff(target), '2015-02-19');
  assert.equal(EA.earlierCutoff({ id: 'X', openingDate: '2015-03-12', previewsStartDate: '2015-03-11' }), `2015-03-${String(12 - RF.LAG_DAYS).padStart(2, '0')}`);
  assert.equal(EA.earlierCutoff({ id: 'Y', openingDate: '2015-03-22' }), '2015-03-01', 'no preview date: opening minus 21 days');
});

test('parseMembers reads dated ratings from JSON-LD and ignores the rest', () => {
  const html = '{"datePublished":"2014-05-01T10:00:00Z","reviewRating":{"@type":"Rating","ratingValue":90}},{"datePublished":"2014-04-02T00:00:00Z","reviewRating":{"ratingValue":70.5}} junk';
  assert.deepEqual(EA.parseMembers(html), [{ date: '2014-05-01', rating: 90 }, { date: '2014-04-02', rating: 70.5 }]);
  assert.deepEqual(EA.parseMembers(''), []);
});

test('pageName reads NYC and London Show Score titles (London pages were once rejected as a title mismatch)', () => {
  assert.equal(EA.pageName('<title>Show Score | Operation Mincemeat (West End) London Reviews and Tickets</title>'), 'Operation Mincemeat');
  assert.equal(EA.pageName('<title>Show Score | Hadestown NYC Reviews and Tickets</title>'), 'Hadestown');
  assert.equal(EA.pageName('<title>Something else</title>'), null);
});

test('summarize keeps only ratings on or before the cutoff; pool is n-weighted', () => {
  const s = EA.summarize([{ date: '2015-01-01', rating: 80 }, { date: '2015-02-19', rating: 60 }, { date: '2015-02-20', rating: 10 }], '2015-02-19');
  assert.equal(s.n, 2); assert.equal(s.mean, 70); assert.equal(s.newest, '2015-02-19'); assert.equal(s.shareLe60, 0.5);
  assert.deepEqual(EA.summarize([{ date: '2016-01-01', rating: 50 }], '2015-02-19'), { n: 0 });
  const p = EA.pool([{ n: 10, mean: 90, shareLe60: 0, newest: '2015-01-01' }, { n: 30, mean: 70, shareLe60: 0.2, newest: '2015-02-01' }, { n: 0 }]);
  assert.equal(p.n, 40); assert.equal(p.mean, 75); assert.equal(p.newest, '2015-02-01');
  assert.equal(EA.pool([{ n: 0 }]), null);
});

test('features shrink toward 85 and are zero when absent', () => {
  const none = EA.buildEarlierAudienceFeatures(target, { earlierAudience: {} });
  assert.deepEqual(none.x, { eaScore: 0, eaHas: 0 }); assert.equal(none.has.earlierAudience, false);
  const f = EA.buildEarlierAudienceFeatures(target, { earlierAudience: { T: { n: 90, mean: 91.5, newest: '2015-01-01' } } });
  assert.equal(f.has.earlierAudience, true); assert.equal(f.x.eaHas, 1);
  assert.ok(Math.abs(f.x.eaScore - ((90 * 91.5 + 850) / 100 - 85)) < 1e-9);
});

test('leakage guard: red on a late or undated rating, green on a valid one', () => {
  const ok = EA.buildEarlierAudienceFeatures(target, { earlierAudience: { T: { n: 5, mean: 80, newest: '2015-02-19' } } });
  assert.equal(EA.assertNoLeakageEarlierAudience(target, ok.provenance), true);
  for (const d of ['2015-02-20', '2015-03-01', '2016-01-01', null, 'junk']) {
    const f = EA.buildEarlierAudienceFeatures(target, { earlierAudience: { T: { n: 5, mean: 80, newest: d } } });
    assert.throws(() => EA.assertNoLeakageEarlierAudience(target, f.provenance), /LEAKAGE\(earlier-audience\)/, `${d} must throw`);
  }
});

test('--help prints usage and writes nothing (backtest and sweep)', () => {
  const out = 'data/audit/review-forecast-inputs-v2.json';
  const before = fs.readFileSync(out, 'utf8');
  for (const s of ['scripts/backtest-review-forecast-v2.mjs', 'scripts/review-forecast-v2-earlier-audience-sweep.js']) {
    const r = spawnSync('node', [s, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, s); assert.ok(r.stdout.length > 50, s);
  }
  assert.equal(fs.readFileSync(out, 'utf8'), before);
});
