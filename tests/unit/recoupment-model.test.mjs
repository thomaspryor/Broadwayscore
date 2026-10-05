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
//   7. BRO-4623: no SVOG for Disney shows or Wicked; notes saying the NY tax
//      credit was NOT received zero it out (All Out); the notes parser never
//      returns NaN
// Per feedback_test_extraction_pattern.md — tests the real module via require().

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  calculateRecoupment,
  calculateLifetimeRecoupment,
  classifyShow,
  estimateWeeklyNut,
  isSoloShow,
  eraDeflator,
  venueSizeFactor,
  KNOWN_SVOG,
  parseSvogFromNotes,
  parseTaxCreditFromNotes,
  NO_TAX_CREDIT_FROM_NOTES_WARNING,
  TAX_CREDIT_MAX,
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

// BRO-4666: /biz shows an uncited weekly cost as an estimate, so the model
// must not grade it "High confidence".
describe('calculateRecoupment data quality', () => {
  const show = {
    slug: 'test-show', title: 'Test Show', type: 'play', venue: 'Ethel Barrymore Theatre',
    openingDate: '2022-10-01', closingDate: '2023-07-01',
  };
  const base = { capitalization: 8000000, weeklyRunningCost: 500000, costMethodology: 'trade-reported' };
  const quality = (commercial, allTime = null) =>
    calculateRecoupment(show, commercial, allTime, weeklyGrosses(40, 900000)).dataQuality;

  it('is high only for a reported cost that names its source', () => {
    assert.strictEqual(quality({ ...base, weeklyRunningCostSource: 'Forbes (Nov 17, 2025)' }), 'high');
  });

  it('is medium for a reported method with no citation, or a flagged estimate', () => {
    assert.strictEqual(quality(base), 'medium');
    assert.strictEqual(quality({ ...base, weeklyRunningCostSource: 'SEC filings (GPT Deep Research)' }), 'medium');
    assert.strictEqual(quality({ ...base, weeklyRunningCostSource: 'Forbes', isEstimate: { weeklyRunningCost: true } }), 'medium');
  });

  it('keeps the old medium and low grades for estimates', () => {
    assert.strictEqual(quality({ ...base, costMethodology: 'reddit-standard' }, { gross: 1 }), 'medium');
    assert.strictEqual(quality({ ...base, costMethodology: 'reddit-standard' }), 'low');
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

// --- BRO-4623 ----------------------------------------------------------------

// Verbatim from commercial.json all-out.notes (2026-10-04).
const ALL_OUT_NOTES = 'Sequel to All In: Comedy About Love which recouped its $4.8M in just 10 weeks. ' +
  'Same format: rotating celebrity comedians with live band. Hit $2M+ weekly gross (record for a play). ' +
  'Very lean $200-300K weekly costs with 4-performer format. LIMITED RUN through March 8, 2026 - did NOT ' +
  'receive NY tax credit (missed application deadline by 2 months). Stars include Sarah Silverman, Ray ' +
  'Romano, Jason Mantzoukas. [Auto-designated Fizzle: closed without known recoupment data]';

// The SVOG sentence as it appears in the-lion-king and aladdin notes.
const DISNEY_SVOG_NOTE = 'NOT eligible for SVOG (Disney is a publicly traded company, per Variety Mar 2021).';

describe('KNOWN_SVOG (BRO-4623)', () => {
  it('does not credit Disney shows or Wicked with a grant they never received', () => {
    for (const slug of ['wicked', 'the-lion-king', 'aladdin']) {
      assert.strictEqual(KNOWN_SVOG[slug], undefined, `${slug} must not be in KNOWN_SVOG`);
    }
  });

  it('keeps the cited grants', () => {
    assert.strictEqual(KNOWN_SVOG.hamilton, 10000000);
    assert.strictEqual(KNOWN_SVOG['moulin-rouge'], 9900000);
  });

  it('"NOT eligible for SVOG" notes parse to no grant', () => {
    assert.strictEqual(parseSvogFromNotes(DISNEY_SVOG_NOTE), 0);
  });
});

describe('parseTaxCreditFromNotes (BRO-4623)', () => {
  it('All Out: "did NOT receive NY tax credit" is an explicit 0, not the default', () => {
    assert.strictEqual(parseTaxCreditFromNotes(ALL_OUT_NOTES), 0);
  });

  it('other "not received" phrasings are 0', () => {
    for (const text of [
      'No NY tax credit.',
      'no New York State theatre tax credit',
      'Never qualified for the tax credit.',
      'Not eligible for the state tax credit.',
      'Ineligible for the NY tax credit (opened before the program).',
      'The tax credit was not received.',
      "Didn't get the NY tax credit.",
    ]) {
      assert.strictEqual(parseTaxCreditFromNotes(text), 0, text);
    }
  });

  it('a negation about something else does not zero the credit', () => {
    assert.strictEqual(parseTaxCreditFromNotes('Did not get SVOG but got a tax credit: $3M'), 3000000);
    assert.strictEqual(parseTaxCreditFromNotes(DISNEY_SVOG_NOTE + ' Received $3M NY theater tax credit (2022-2023 fiscal year).'), null);
  });

  it('stated amounts still parse', () => {
    assert.strictEqual(parseTaxCreditFromNotes('tax credit: $3M'), 3000000);
    assert.strictEqual(parseTaxCreditFromNotes('Tax credit $2.5 million'), 2500000);
    assert.strictEqual(parseTaxCreditFromNotes('credit: 750,000'), 750000);
  });

  it('never returns NaN (trailing "." used to parse as NaN)', () => {
    for (const text of ['Eligible for $3M NY state tax credit.', 'tax credit.', 'credit, pending']) {
      const out = parseTaxCreditFromNotes(text);
      assert.ok(out === null, `${JSON.stringify(text)} -> ${out}`);
    }
  });

  it('empty or missing notes are null (use the default calculation)', () => {
    assert.strictEqual(parseTaxCreditFromNotes(''), null);
    assert.strictEqual(parseTaxCreditFromNotes(null), null);
    assert.strictEqual(parseTaxCreditFromNotes(undefined), null);
  });
});

describe('model honors "tax credit not received" notes (BRO-4623)', () => {
  const show = {
    slug: 'test-show', title: 'Test Show', type: 'play',
    venue: 'Ethel Barrymore Theatre',
    openingDate: '2022-10-01', closingDate: '2023-07-01',
  };
  const base = { capitalization: 8000000, weeklyRunningCost: 500000 };

  it('weekly model: in-window show with All Out notes gets no credit and says why', () => {
    const result = calculateRecoupment(show, { ...base, notes: ALL_OUT_NOTES }, null, weeklyGrosses(40, 900000));
    assert.strictEqual(result.taxCreditAmount, 0);
    assert.ok(result.warnings.includes(NO_TAX_CREDIT_FROM_NOTES_WARNING), result.warnings.join(' | '));
    assert.ok(!result.warnings.some((w) => /program window/.test(w)), 'not the program-window warning');
  });

  it('weekly model: notes that used to parse as NaN still get the default credit', () => {
    const result = calculateRecoupment(
      show, { ...base, notes: 'Eligible for $3M NY state tax credit.' }, null, weeklyGrosses(40, 900000)
    );
    assert.strictEqual(result.taxCreditAmount, 3000000);
  });

  it('weekly model: the credit changes the result (0 credit -> lower recoupment)', () => {
    const withCredit = calculateRecoupment(show, base, null, weeklyGrosses(40, 900000));
    const without = calculateRecoupment(show, { ...base, notes: ALL_OUT_NOTES }, null, weeklyGrosses(40, 900000));
    assert.ok(without.recoupmentPctCentral < withCredit.recoupmentPctCentral,
      `${without.recoupmentPctCentral} should be < ${withCredit.recoupmentPctCentral}`);
  });

  it('lifetime model: explicit "not received" zeroes the credit; otherwise unchanged', () => {
    const longRunner = { slug: 'long-runner', title: 'Long Runner', type: 'musical', openingDate: '2012-03-01' };
    const comm = { capitalization: 12000000, weeklyRunningCost: 700000 };
    const allTime = { gross: 900000000 };
    const plain = calculateLifetimeRecoupment(longRunner, comm, allTime);
    assert.strictEqual(plain.taxCreditAmount, TAX_CREDIT_MAX);
    const zeroed = calculateLifetimeRecoupment(longRunner, { ...comm, notes: 'Did not receive the NY tax credit.' }, allTime);
    assert.strictEqual(zeroed.taxCreditAmount, 0);
    assert.ok(zeroed.warnings.includes(NO_TAX_CREDIT_FROM_NOTES_WARNING));
  });

  it('lifetime model: aladdin gets no SVOG (Disney notes, no KNOWN_SVOG entry)', () => {
    const aladdin = { slug: 'aladdin', title: 'Aladdin', type: 'musical', openingDate: '2014-03-20' };
    const result = calculateLifetimeRecoupment(
      aladdin, { capitalization: 16000000, weeklyRunningCost: 850000, notes: DISNEY_SVOG_NOTE }, { gross: 600000000 }
    );
    assert.strictEqual(result.svogGrant, 0);
  });
});
