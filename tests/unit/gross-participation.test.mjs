// BRO-5029: sourced-only star gross-participation deals (opts.sourcedStarDeals,
// shadow). require()s the real helper, model and display guard (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { sourcedGrossParticipation, weeklyParticipationCost, starDealUnknown } = require('../../scripts/lib/gross-participation');
const { calculateRecoupment, calculateLifetimeRecoupment, classifyShow, KNOWN_STAR_DEALS } = require('../../scripts/lib/recoupment-model');
const { modelDisplayGuard } = require('../../scripts/lib/model-display-guard');

const WEEK = 7 * 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const weeksFrom = (base, n) => new Date(base.getTime() + n * WEEK);
const now = new Date();
const first = weeksFrom(now, -60);
const weekly = {};
for (let i = 0; i < 59; i++) weekly[iso(weeksFrom(first, i + 0.5))] = { gross: 1_400_000, performances: 8 };
const musical = { slug: 'x', title: 'X', type: 'musical', previewsStartDate: iso(first), openingDate: iso(weeksFrom(first, 4)) };
const comm = { capitalization: 20_000_000, weeklyRunningCost: 800_000 };
const sourced = { who: 'Star', pct: 10, basis: 'grossAbove', threshold: 1_000_000, weeklyGuarantee: 50_000, asOf: '2025-01-01', sourceType: 'trade', sourceUrl: 'https://example.com/deal' };

describe('sourcedGrossParticipation', () => {
  test('keeps trade/producer/sec entries with an http source', () => {
    for (const sourceType of ['trade', 'producer', 'sec']) {
      assert.equal(sourcedGrossParticipation({ grossParticipation: [{ ...sourced, sourceType }] }).entries.length, 1);
    }
  });
  test('ignores an unsourced entry and says why', () => {
    const bad = [
      { ...sourced, sourceType: 'reddit' },
      { ...sourced, sourceType: undefined },
      { ...sourced, sourceUrl: '' },
      { ...sourced, sourceUrl: 'deadline article' },
      { ...sourced, basis: 'grossAbove', threshold: undefined },
      { ...sourced, pct: 0 },
      { ...sourced, basis: 'net' },
      { ...sourced, weeklyGuarantee: -1 },
      { ...sourced, weeklyGuarantee: NaN },
      { ...sourced, sourceUrl: 'https://example.com/deal trailing' },
    ];
    const r = sourcedGrossParticipation({ grossParticipation: bad });
    assert.equal(r.entries.length, 0);
    assert.equal(r.ignored.length, bad.length);
    assert.ok(r.ignored.every((x) => typeof x.reason === 'string' && x.reason));
  });
  test('no field is no entries', () => {
    assert.deepEqual(sourcedGrossParticipation({}), { entries: [], ignored: [] });
    assert.deepEqual(sourcedGrossParticipation(null), { entries: [], ignored: [] });
  });
});

describe('weeklyParticipationCost', () => {
  test('greater of guarantee and percentage', () => {
    assert.equal(weeklyParticipationCost([sourced], 1_200_000), 50_000); // 10% of 200K = 20K < 50K
    assert.equal(weeklyParticipationCost([sourced], 2_000_000), 100_000); // 10% of 1M
    assert.equal(weeklyParticipationCost([{ ...sourced, basis: 'gross', weeklyGuarantee: undefined }], 1_000_000), 100_000);
    assert.equal(weeklyParticipationCost([], 2_000_000), 0);
  });
  test('several stars sum', () => {
    const b = { ...sourced, pct: 5, basis: 'gross', weeklyGuarantee: 0 };
    assert.equal(weeklyParticipationCost([sourced, b], 2_000_000), 100_000 + 100_000);
  });
});

describe('starDealUnknown', () => {
  test('held only when star-driven with no sourced entry', () => {
    assert.equal(starDealUnknown({ starDriven: true, entries: [] }), true);
    assert.equal(starDealUnknown({ starDriven: true, entries: [sourced] }), false);
    assert.equal(starDealUnknown({ starDriven: false, entries: [] }), false);
  });
});

describe('calculateRecoupment opts.sourcedStarDeals', () => {
  const starSlug = Object.keys(KNOWN_STAR_DEALS)[0];
  const starShow = { ...musical, slug: starSlug };

  test('live (no opt) is unchanged and carries no starDealUnknown', () => {
    const live = calculateRecoupment(starShow, { ...comm, grossParticipation: [sourced] }, null, weekly);
    assert.deepEqual(live, calculateRecoupment(starShow, comm, null, weekly));
    assert.ok(!('starDealUnknown' in live));
  });

  test('an unsourced entry is ignored and the star-driven show is held', () => {
    const c = { ...comm, grossParticipation: [{ ...sourced, sourceType: 'reddit' }] };
    const r = calculateRecoupment(starShow, c, null, weekly, { sourcedStarDeals: true });
    assert.equal(r.starDealUnknown, true);
    assert.ok(r.warnings.some((w) => /grossParticipation entry ignored/.test(w)));
    assert.ok(r.warnings.some((w) => /Star deal unknown/.test(w)));
    // No guessed premium: the old unsourced deal is not charged either.
    const noDeal = calculateRecoupment({ ...musical, slug: 'no-star' }, comm, null, weekly, { sourcedStarDeals: true });
    assert.equal(r.recoupmentPctCentral, noDeal.recoupmentPctCentral);
    const live = calculateRecoupment(starShow, comm, null, weekly);
    assert.ok(r.recoupmentPctCentral > live.recoupmentPctCentral);
  });

  test('a sourced entry is charged and clears the hold', () => {
    const r = calculateRecoupment(starShow, { ...comm, grossParticipation: [sourced] }, null, weekly, { sourcedStarDeals: true });
    const none = calculateRecoupment(starShow, comm, null, weekly, { sourcedStarDeals: true });
    assert.equal(r.starDealUnknown, false);
    assert.ok(r.recoupmentPctCentral < none.recoupmentPctCentral);
  });

  test('a non-star show without an entry is not held', () => {
    const r = calculateRecoupment({ ...musical, slug: 'no-star' }, comm, null, weekly, { sourcedStarDeals: true });
    assert.equal(r.starDealUnknown, false);
  });
});

describe('star-play category and lifetime tier', () => {
  // Synthetic star play (short run, no venue): the classifier's own rule, no data file needed.
  const playOpen = weeksFrom(now, -30);
  const starPlay = { slug: 'star-play', title: 'P', type: 'play', previewsStartDate: iso(weeksFrom(playOpen, -3)), openingDate: iso(playOpen), closingDate: iso(weeksFrom(playOpen, 20)) };
  test('a playStar show off the old list is held with no sourced entry', () => {
    assert.equal(classifyShow(starPlay), 'playStar');
    assert.equal(calculateRecoupment(starPlay, comm, null, weekly, { sourcedStarDeals: true }).starDealUnknown, true);
    assert.equal(calculateRecoupment(starPlay, { ...comm, grossParticipation: [sourced] }, null, weekly, { sourcedStarDeals: true }).starDealUnknown, false);
  });
  test('lifetime tier carries the flag only under the option', () => {
    const show = { ...musical, slug: Object.keys(KNOWN_STAR_DEALS)[0], openingDate: '2010-01-01', previewsStartDate: '2009-12-01' };
    const allTime = { gross: 900_000_000 };
    const live = calculateLifetimeRecoupment(show, comm, allTime);
    assert.ok(!('starDealUnknown' in live));
    assert.equal(calculateLifetimeRecoupment(show, comm, allTime, { sourcedStarDeals: true }).starDealUnknown, true);
    const withDeal = calculateLifetimeRecoupment(show, { ...comm, grossParticipation: [sourced] }, allTime, { sourcedStarDeals: true });
    assert.equal(withDeal.starDealUnknown, false);
    assert.ok(withDeal.warnings.some((w) => /not charged on the lifetime tier/.test(w)));
  });
});

describe('modelDisplayGuard starDealUnknown', () => {
  test('too early still reads few-weeks', () => {
    assert.equal(modelDisplayGuard({ pct: [30, 40, 50], playedWeeks: 5, starDealUnknown: true }).reason, 'few-weeks');
  });
  const input = { pct: [30, 40, 50], playedWeeks: 30 };
  test('held flag hides the bar; default unchanged', () => {
    assert.equal(modelDisplayGuard(input).show, true);
    assert.deepEqual(modelDisplayGuard({ ...input, starDealUnknown: true }), { show: false, reason: 'star-deal-unknown', shown: null, belowCosts: false });
  });
});
