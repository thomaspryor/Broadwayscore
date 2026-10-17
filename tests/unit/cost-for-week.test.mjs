// BRO-4989: the cost index, costForWeek(), Near Cost, and the backtest stop.
// Tests the real modules via require() (CLAUDE.md §15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { costForWeek, weeklyCostStatus, costIndexAt, carry } = require('../../scripts/lib/cost-for-week');
const { anchorErrors } = require('../../scripts/lib/cost-history');
const { backtest, loadSeries, MAX_MEDIAN_ERROR } = require('../../scripts/lib/cost-index-backtest');

const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/broadway-cost-index.json'), 'utf8'));
const trade = (asOf, amount, extra = {}) => ({ asOf, amount, kind: 'running-cost', sourceType: 'trade', sourceUrl: 'https://x.test/' + asOf, ...extra });

describe('Broadway cost index data', () => {
  it('every point has a source, a known basis and a valid date', () => {
    for (const p of INDEX.points) {
      assert.match(p.sourceUrl, /^https?:\/\//, `${p.effectiveDate} needs a sourceUrl`);
      assert.ok(['sourced', 'derived', 'interpolated', 'extrapolated', 'scheduled'].includes(p.basis), `${p.effectiveDate} basis ${p.basis}`);
      assert.ok(Number.isFinite(Date.parse(p.effectiveDate)));
      assert.ok(p.note && p.note.length > 5, `${p.effectiveDate} needs a note saying where the number comes from`);
    }
  });

  it('never falls and is in date order', () => {
    for (let i = 1; i < INDEX.points.length; i++) {
      assert.ok(INDEX.points[i].effectiveDate > INDEX.points[i - 1].effectiveDate);
      assert.ok(INDEX.points[i].value >= INDEX.points[i - 1].value, `falls at ${INDEX.points[i].effectiveDate}`);
    }
  });

  it('is 1.0 at its base date and covers 2001 to now', () => {
    assert.strictEqual(Math.round(costIndexAt(INDEX._meta.baseDate) * 1000) / 1000, 1);
    assert.ok(INDEX.points[0].effectiveDate <= '2001-01-01');
    assert.ok(INDEX.points.at(-1).effectiveDate >= new Date().toISOString().slice(0, 10).replace(/^\d{4}/, (y) => String(+y - 1)));
  });

  it('carries a figure between years by the index ratio', () => {
    const v = carry(800_000, '2008-03-15', '2023-11-06');
    assert.ok(v > 1_250_000 && v < 1_400_000, `got ${v}`);
    assert.strictEqual(Math.round(carry(500_000, '2020-01-01', '2020-01-01')), 500_000);
  });
});

describe('costForWeek', () => {
  it('returns the anchor at its own date with the source tier as range', () => {
    const r = costForWeek({ costHistory: [trade('2024-01-07', 900_000)] }, '2024-01-07');
    assert.strictEqual(r.cost, 900_000);
    assert.strictEqual(r.halfWidth, 0.1);
    assert.strictEqual(r.quality, 'high');
    assert.ok(r.breakEven > r.cost);
  });

  it('interpolates between anchors and carries beyond them', () => {
    const rec = { costHistory: [trade('2022-01-02', 800_000), trade('2024-01-07', 1_000_000)] };
    const mid = costForWeek(rec, '2023-01-01');
    assert.strictEqual(mid.basis, 'interpolated');
    assert.ok(mid.cost > 800_000 && mid.cost < 1_000_000);
    const later = costForWeek(rec, '2026-01-04');
    assert.strictEqual(later.basis, 'carried-forward');
    assert.ok(later.cost > 1_000_000, 'carried up by the index');
  });

  it('widens the range with distance and with a weaker source', () => {
    const near = costForWeek({ costHistory: [trade('2024-01-07', 900_000)] }, '2024-06-02');
    const far = costForWeek({ costHistory: [trade('2014-01-05', 900_000)] }, '2024-06-02');
    assert.ok(far.halfWidth > near.halfWidth);
    const est = costForWeek({ costHistory: [{ ...trade('2024-01-07', 900_000), sourceType: 'industry-estimate' }] }, '2024-01-07');
    assert.ok(est.halfWidth > near.halfWidth);
  });

  it('prefers a strong earlier report over a fresh rough estimate (Back to the Future case)', () => {
    const rec = { costHistory: [
      { asOf: '2023-08-03', amount: 980_000, kind: 'break-even', sourceType: 'trade', sourceUrl: 'https://x.test/bj' },
      { asOf: '2025-01-05', amount: 825_000, kind: 'running-cost', sourceType: 'industry-estimate' },
    ] };
    const r = costForWeek(rec, '2025-01-05');
    assert.strictEqual(r.anchors[0].sourceType, 'trade');
  });

  it('falls back to the legacy weeklyRunningCost, then to the category estimate', () => {
    const legacy = costForWeek({ weeklyRunningCost: 700_000, costMethodology: 'industry-estimate' }, '2025-07-06');
    assert.ok(Math.abs(legacy.cost / 700_000 - 1) < 0.002, `got ${legacy.cost}`);
    const none = costForWeek({}, '2025-07-06', { fallbackCost: 600_000 });
    assert.strictEqual(none.quality, 'estimated');
    assert.strictEqual(costForWeek({}, '2025-07-06'), null);
  });
});

describe('Near Cost', () => {
  it('a gross whose multiple range includes 1.0 is near-cost, never below-cost', () => {
    const cw = costForWeek({ costHistory: [{ ...trade('2025-01-05', 1_000_000), sourceType: 'industry-estimate' }] }, '2025-01-05');
    const s = weeklyCostStatus(cw.breakEven * 0.9, cw);
    assert.ok(s.multipleLow < 1 && s.multipleHigh > 1);
    assert.strictEqual(s.status, 'near-cost');
  });

  it('is below-cost only when the whole range is under 1.0', () => {
    const cw = costForWeek({ costHistory: [trade('2025-01-05', 1_000_000)] }, '2025-01-05');
    assert.strictEqual(weeklyCostStatus(cw.breakEven * 0.5, cw).status, 'below-cost');
    assert.strictEqual(weeklyCostStatus(cw.breakEven * 1.5, cw).status, 'above-cost');
  });
});

describe('backtest hard stop (owner: stop if median error over ~15%)', () => {
  it('the researched series pass', () => {
    const res = backtest(loadSeries());
    assert.ok(res.pairs.length >= 3, 'needs real pairs');
    assert.ok(res.medianAbsError <= MAX_MEDIAN_ERROR, `median ${res.medianAbsError}`);
    assert.ok(res.bounds.every((b) => b.ok));
  });

  it('every seed anchor is a valid anchor', () => {
    const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cost-anchor-seeds.json'), 'utf8'));
    for (const [slug, list] of Object.entries({ ...seeds.anchors, ...seeds.uncatalogued })) {
      for (const a of list) assert.deepStrictEqual(anchorErrors(a), [], `${slug} ${a.asOf}`);
    }
  });
});

describe('one cost function (no new direct weeklyRunningCost math)', () => {
  it('no file outside the baseline reads weeklyRunningCost', () => {
    const baseline = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/weekly-running-cost-readers.json'), 'utf8')).files);
    let out = '';
    try {
      out = execFileSync('grep', ['-rl', '--include=*.js', '--include=*.ts', '--include=*.tsx', '--include=*.mjs', 'weeklyRunningCost', 'scripts', 'src'], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) { out = e.stdout || ''; }
    const extra = out.trim().split('\n').filter(Boolean).filter((f) => !baseline.has(f));
    assert.deepStrictEqual(extra, [], `New direct readers of weeklyRunningCost; use costForWeek() from scripts/lib/cost-for-week.js: ${extra.join(', ')}`);
  });
});
