// Regression tests for the recoupment financial model (task #140).
// Locks in the fixes for the announced-recouped false-negative class:
//   1. Era deflation of estimated nuts (2025 defaults applied to 2002 shows)
//   2. Venue-size scaling (597-seat Hayes ≠ 1,100-seat play house)
//   3. NY tax credit program window (run overlaps Aug 2021 – 2027, incl.
//      COVID reopenings) + qualified-cost formula
//   4. Solo shows classify as 'special', not 'playStar'
//   5. Star-play classification requires a >=850-seat house
//   6. Closed shows measure recoupment % against cap net of SVOG (reserve
//      gates the recoup-week timing only)
// Per feedback_test_extraction_pattern.md — tests the real module via require().

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  calculateRecoupment,
  classifyShow,
  estimateWeeklyNut,
  isSoloShow,
  eraDeflator,
  venueSizeFactor,
} = require('../../scripts/lib/recoupment-model');

// --- Fixtures ---------------------------------------------------------------

// Weekly grosses: `weeks` entries of `gross` each, keyed by ISO-ish dates.
function weeklyGrosses(weeks, gross) {
  const out = {};
  for (let i = 0; i < weeks; i++) {
    out[`2023-01-${String(i + 1).padStart(2, '0')}`] = { gross };
  }
  return out;
}

describe('eraDeflator', () => {
  it('is 1 for anchor year and later', () => {
    assert.strictEqual(eraDeflator('2025-03-01'), 1);
    assert.strictEqual(eraDeflator('2026-01-01'), 1);
  });

  it('deflates older eras at 1.5%/yr', () => {
    const d2002 = eraDeflator('2002-08-15');
    assert.ok(Math.abs(d2002 - Math.pow(0.985, 23)) < 1e-9, `got ${d2002}`);
  });

  it('floors for very old shows and handles missing dates', () => {
    assert.strictEqual(eraDeflator('1950-01-01'), 0.5);
    assert.strictEqual(eraDeflator(null), 1);
  });
});

describe('venueSizeFactor', () => {
  it('scales a play at the Hayes down (clamped at 0.65)', () => {
    assert.strictEqual(venueSizeFactor({ venue: 'Helen Hayes Theater' }, 'play'), 0.65);
  });

  it('scales a musical at a giant house up (clamped at 1.2)', () => {
    assert.strictEqual(venueSizeFactor({ venue: 'Broadway Theatre' }, 'musical'), 1.2);
  });

  it('is 1 for unknown venues', () => {
    assert.strictEqual(venueSizeFactor({ venue: 'Some Regional Barn' }, 'play'), 1);
    assert.strictEqual(venueSizeFactor({}, 'play'), 1);
  });
});

describe('classifyShow', () => {
  it('classifies solo shows as special regardless of type label', () => {
    assert.ok(isSoloShow({ title: 'Just for Us' }));
    assert.strictEqual(classifyShow({ title: 'Just for Us', type: 'play' }), 'special');
  });

  it('short-run play at a small house is play, not playStar', () => {
    const show = {
      title: 'What the Constitution Means to Me', type: 'play',
      venue: 'Helen Hayes Theater',
      openingDate: '2019-03-31', closingDate: '2019-08-24',
    };
    assert.strictEqual(classifyShow(show), 'play');
  });

  it('short-run play at a large house is playStar', () => {
    const show = {
      title: 'Our Town', type: 'play', venue: 'Ethel Barrymore Theatre',
      openingDate: '2024-10-10', closingDate: '2025-01-19',
    };
    assert.strictEqual(classifyShow(show), 'playStar');
  });

  it('Great Comet counts as spectacle-scale', () => {
    const show = { title: 'Natasha, Pierre & The Great Comet of 1812', type: 'musical' };
    assert.strictEqual(classifyShow(show), 'musicalSpectacle');
  });
});

describe('estimateWeeklyNut era + venue adjustment', () => {
  it('era-deflates an estimated musical nut for a 2002 show', () => {
    const nut2002 = estimateWeeklyNut({ title: 'X', type: 'musical', openingDate: '2002-08-15' });
    const nut2025 = estimateWeeklyNut({ title: 'X', type: 'musical', openingDate: '2025-08-15' });
    assert.ok(nut2002 < nut2025, `${nut2002} should be < ${nut2025}`);
    assert.strictEqual(nut2025, 750000);
  });

  it('eraAdjust:false skips deflation (lifetime model path)', () => {
    const nut = estimateWeeklyNut(
      { title: 'X', type: 'musical', openingDate: '1996-11-14' }, {}, { eraAdjust: false }
    );
    assert.strictEqual(nut, 750000);
  });
});

describe('calculateRecoupment tax credit window', () => {
  const baseShow = {
    slug: 'test-show', title: 'Test Show', type: 'play',
    venue: 'Ethel Barrymore Theatre',
  };
  const commercial = { capitalization: 8000000, weeklyRunningCost: 500000 };
  const grosses = weeklyGrosses(40, 900000);

  it('grants no credit to shows closed before the program (Aug 2021)', () => {
    const result = calculateRecoupment(
      { ...baseShow, openingDate: '2019-03-01', closingDate: '2019-09-01' },
      commercial, null, weeklyGrosses(24, 900000)
    );
    assert.strictEqual(result.taxCreditAmount, 0);
  });

  it('grants the capped credit to shows in the program window', () => {
    const result = calculateRecoupment(
      { ...baseShow, openingDate: '2022-10-01', closingDate: '2023-07-01' },
      commercial, null, grosses
    );
    // 25% × ($8M cap + 500K × min(weeks,52)) far exceeds the $3M cap
    assert.strictEqual(result.taxCreditAmount, 3000000);
  });

  it('grants the credit to COVID-reopening shows that opened pre-2021', () => {
    const result = calculateRecoupment(
      { ...baseShow, openingDate: '2017-03-12', closingDate: '2022-10-02' },
      commercial, null, weeklyGrosses(200, 800000)
    );
    assert.ok(result.taxCreditAmount > 0, 'reopening show should qualify');
  });
});

describe('closed-show recoupment percentage denominator', () => {
  it('measures closed shows against cap net of SVOG, without reserve', () => {
    const show = {
      slug: 'closed-show', title: 'Closed Show', type: 'play',
      venue: 'Ethel Barrymore Theatre',
      openingDate: '2022-10-01', closingDate: '2023-07-01',
    };
    const commercial = { capitalization: 8000000, weeklyRunningCost: 500000 };
    const result = calculateRecoupment(show, commercial, null, weeklyGrosses(40, 900000));
    const expectedPct = (result.central.cumulativeProfit / 8000000) * 100;
    assert.ok(
      Math.abs(result.central.recoupmentPct - expectedPct) < 0.1,
      `pct ${result.central.recoupmentPct} should ≈ profit/cap ${expectedPct.toFixed(1)} (no reserve in denominator)`
    );
  });
});
