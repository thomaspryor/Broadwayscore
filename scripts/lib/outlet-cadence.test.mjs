import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { medianGapDays, marketPulseDate, classifyOutletCadence, buildCadenceReport } =
  require('./outlet-cadence.js');

describe('medianGapDays', () => {
  test('needs >=2 dates to compute a gap', () => {
    assert.equal(medianGapDays([]), null);
    assert.equal(medianGapDays(['2026-01-01']), null);
  });
  test('two dates -> single gap', () => {
    assert.equal(medianGapDays(['2026-01-01', '2026-01-11']), 10);
  });
  test('even gap count -> average of middle two', () => {
    // dates -> gaps [5, 10] -> average 7.5
    assert.equal(medianGapDays(['2026-01-01', '2026-01-06', '2026-01-16']), 7.5);
  });
  test('odd gap count -> middle value', () => {
    // dates -> gaps [5, 10, 20] -> middle 10
    assert.equal(medianGapDays(['2026-01-01', '2026-01-06', '2026-01-16', '2026-02-05']), 10);
  });
});

describe('marketPulseDate', () => {
  test('returns the latest date among tier-1 dates', () => {
    assert.equal(marketPulseDate(['2026-01-01', '2026-03-15', '2026-02-01']), '2026-03-15');
  });
  test('empty input -> null', () => {
    assert.equal(marketPulseDate([]), null);
  });
});

describe('classifyOutletCadence', () => {
  test('no history -> unknown', () => {
    const r = classifyOutletCadence({ outletDates: [], marketPulseIso: '2026-07-01', nowMs: Date.now() });
    assert.equal(r.status, 'unknown');
    assert.equal(r.reason, 'no-history');
  });

  test('single review -> unknown (insufficient history), not a false red', () => {
    const r = classifyOutletCadence({
      outletDates: ['2020-01-01'], marketPulseIso: '2026-07-01', nowMs: Date.now(),
    });
    assert.equal(r.status, 'unknown');
    assert.equal(r.reason, 'insufficient-history');
  });

  test('silence measured against market pulse, not wall-clock now -- healthy cadence during a lull stays green', () => {
    // Outlet reviews every ~5 days historically; its last review is only 10
    // days behind the market pulse even though "now" is 90 days past the pulse
    // (a market-wide lull, e.g. summer with no new Broadway openings).
    const outletDates = ['2026-01-01', '2026-01-06', '2026-01-11', '2026-04-16'];
    const r = classifyOutletCadence({
      outletDates, marketPulseIso: '2026-04-26', nowMs: Date.parse('2026-07-22'),
    });
    assert.equal(r.status, 'green');
    assert.equal(r.silentDays, 10);
  });

  test('an outlet trailing FAR behind the market pulse is red even if the market itself is quiet', () => {
    const outletDates = ['2025-01-01', '2025-01-06', '2025-01-11', '2025-04-28'];
    const r = classifyOutletCadence({
      outletDates, marketPulseIso: '2026-05-06', nowMs: Date.parse('2026-07-22'),
    });
    assert.equal(r.status, 'red');
    assert.ok(r.silentDays > r.thresholdDays);
  });

  test('45-day seasonal floor protects a naturally low-cadence outlet (e.g. LA Times on Broadway) from flapping', () => {
    // Median gap ~20 days -> 2x = 40, which is BELOW the 45d floor, so the
    // floor is what actually gates it, not the multiplier.
    const outletDates = ['2026-01-01', '2026-01-21', '2026-02-10'];
    const r = classifyOutletCadence({
      outletDates, marketPulseIso: '2026-03-15', nowMs: Date.parse('2026-03-15'),
    });
    assert.equal(r.thresholdDays, 45);
    assert.equal(r.status, 'green'); // 33 days silent < 45 floor
  });

  test('falls back to nowMs when no market pulse is available', () => {
    const r = classifyOutletCadence({
      outletDates: ['2026-01-01', '2026-01-11'], marketPulseIso: null, nowMs: Date.parse('2026-01-30'),
    });
    assert.equal(r.silentDays, 19);
  });
});

describe('buildCadenceReport on real corpus data (if available)', () => {
  const reviewsPath = path.join(__dirname, '..', '..', 'data', 'reviews.json');
  const outletsPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
  const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
  const hasData = fs.existsSync(reviewsPath) && fs.existsSync(outletsPath) && fs.existsSync(showsPath);

  // Structural checks only -- NEVER assert a specific outlet's current live
  // status here. Outlet health legitimately changes over time (e.g. #280
  // repaired newsday collection, flipping it from red to green), so pinning
  // a live outlet's status turns every future fix into a broken build.
  // The actual red/green classification behavior is locked down below with
  // a frozen synthetic fixture instead.
  test('produces well-formed rows across the live corpus', { skip: !hasData }, () => {
    const reviews = Object.values(JSON.parse(fs.readFileSync(reviewsPath, 'utf8')).reviews);
    const outlets = JSON.parse(fs.readFileSync(outletsPath, 'utf8')).outlets;
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
    const showCat = {};
    for (const s of shows) showCat[s.id] = s.category;
    const marketOf = (showId) => {
      const cat = showCat[showId];
      if (cat === 'west-end' || cat === 'off-west-end') return 'west-end';
      if (cat === 'off-broadway') return 'off-broadway';
      if (cat === 'broadway') return 'broadway';
      return null;
    };
    const report = buildCadenceReport(reviews, outlets, { marketOf, nowMs: Date.now() });
    assert.ok(report.length, 'report has rows');
    const validStatuses = new Set(['red', 'green', 'unknown']);
    for (const row of report) {
      assert.ok(validStatuses.has(row.status), `status "${row.status}" is a known enum value`);
      assert.ok(row.outletId, 'row has outletId');
      assert.ok(row.market, 'row has market');
      assert.ok(row.tier <= 2, 'row is within the maxTier ceiling');
      assert.ok(row.reviewCount >= 1, 'row has at least one scored review');
    }
    // Sanity: classification is actually discriminating, not degenerate
    // (e.g. everything unknown because marketOf silently returned null).
    assert.ok(report.some((r) => r.status === 'green' || r.status === 'red'),
      'at least one row reaches a classified (non-unknown) status');
  });
});

describe('buildCadenceReport S4-T1 acceptance criterion (frozen fixture)', () => {
  // Synthetic data, not the live corpus -- this is what pins the actual
  // red/green classification behavior the S4-T1 story asked for, without
  // being sensitive to real-world outlet health changing over time.
  const outlets = {
    nytimes: { tier: 1 },
    newsday: { tier: 2 },
    broadwaynews: { tier: 2 },
  };
  const marketOf = () => 'broadway';
  const nowMs = Date.parse('2026-07-22');

  function reviewsFor(outletId, dates) {
    return dates.map((publishDate, i) => ({
      outletId,
      publishDate,
      showId: 'fixture-show',
      assignedScore: 80 + i,
    }));
  }

  test('an outlet on a healthy cadence near the market pulse is green', () => {
    const reviews = [
      ...reviewsFor('nytimes', ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22']),
    ];
    const report = buildCadenceReport(reviews, outlets, { marketOf, nowMs });
    const nyt = report.filter((r) => r.outletId === 'nytimes');
    assert.ok(nyt.length, 'nytimes has cadence rows');
    assert.ok(nyt.every((r) => r.status === 'green'), 'nytimes is green');
  });

  test('outlets trailing far behind the market pulse are red', () => {
    const reviews = [
      ...reviewsFor('nytimes', ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22']),
      ...reviewsFor('newsday', ['2025-01-01', '2025-01-08', '2025-01-15', '2025-01-22']),
      ...reviewsFor('broadwaynews', ['2025-02-01', '2025-02-08', '2025-02-15', '2025-02-22']),
    ];
    const report = buildCadenceReport(reviews, outlets, { marketOf, nowMs });
    const newsday = report.filter((r) => r.outletId === 'newsday');
    const broadwaynews = report.filter((r) => r.outletId === 'broadwaynews');
    assert.ok(newsday.length, 'newsday has cadence rows');
    assert.ok(newsday.every((r) => r.status === 'red'), 'newsday is red');
    assert.ok(broadwaynews.length, 'broadwaynews has cadence rows');
    assert.ok(broadwaynews.every((r) => r.status === 'red'), 'broadwaynews is red');
  });
});
