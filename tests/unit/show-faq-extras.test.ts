// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * Show-page FAQ: audience and cheap-ticket answers (BRO-6851). Calls the real
 * exported functions (CLAUDE.md rule 15). The visible FAQ and its FAQPage
 * JSON-LD come from the same getShowFAQs call, so both are covered here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getShowFAQs, generateShowFAQSchema, describeDiscountTickets } from '../../src/lib/seo';
import type { ComputedShow } from '../../src/lib/engine';
import type { AudienceBuzzData, ShowLotteryRush } from '../../src/lib/data-types';

const show = (over: Record<string, unknown> = {}) => ({
  id: 'x-2025', slug: 'x-2025', title: 'Example Show', category: 'broadway', status: 'open',
  venue: 'Shubert Theatre', type: 'musical', openingDate: '2025-04-01',
  criticScore: { score: 80, reviewCount: 30, tier1Count: 5, tier2Count: 5, reviews: [] },
  ...over,
}) as unknown as ComputedShow;

const audience = {
  title: 'Example Show', designation: 'Liking', combinedScore: 85,
  sources: {
    showScore: { score: 86, reviewCount: 1200 },
    mezzanine: { score: 84, reviewCount: 300 },
    reddit: { score: 90, reviewCount: 50, suppressed: true },
  },
} as unknown as AudienceBuzzData;

const lr: ShowLotteryRush = {
  lottery: { type: 'digital', platform: 'TodayTix', url: '', price: 49, time: '', instructions: '' },
  rush: null,
  studentRush: { type: 'student', price: 29.5, time: '', instructions: '' },
  standingRoom: { price: 40, time: '', instructions: '' },
};

test('audience answer gives the grade and counts only visible sources', () => {
  const a = getShowFAQs(show(), null, null, { audience }).find(f => /audiences think/.test(f.question));
  assert.ok(a);
  assert.match(a!.answer, /audience grade of A- \(Liking It\)/);
  assert.match(a!.answer, /1,500 audience reviews/); // suppressed reddit excluded
});

test('a grade on fewer than 15 reviews carries the same small-sample caveat as the card', () => {
  const small = { ...audience, sources: { mezzanine: { score: 84, reviewCount: 12 } } } as unknown as AudienceBuzzData;
  const a = getShowFAQs(show(), null, null, { audience: small }).find(f => /audiences think/.test(f.question));
  assert.match(a!.answer, /12 audience reviews\. That is a small sample/);
  const big = getShowFAQs(show(), null, null, { audience }).find(f => /audiences think/.test(f.question));
  assert.doesNotMatch(big!.answer, /small sample/);
});

test('no audience answer when the page hides the audience tile (null passed)', () => {
  assert.ok(!getShowFAQs(show(), null, null, { audience: null }).some(f => /audiences/.test(f.question)));
  assert.ok(!getShowFAQs(show()).some(f => /audiences/.test(f.question)));
});

test('cheap-ticket answer lists each priced option and the cheapest', () => {
  const t = getShowFAQs(show(), null, null, { lotteryRush: lr }).find(f => /cheap tickets/.test(f.question));
  assert.ok(t);
  assert.match(t!.answer, /digital lottery \(TodayTix\) for \$49/);
  assert.match(t!.answer, /student rush for \$29\.50/);
  assert.match(t!.answer, /standing room for \$40/);
  assert.match(t!.answer, /cheapest way in is \$29\.50/);
});

test('cheap-ticket answer is skipped for closed and upcoming shows', () => {
  for (const status of ['closed', 'upcoming', 'announced']) {
    assert.ok(!getShowFAQs(show({ status }), null, null, { lotteryRush: lr }).some(f => /cheap tickets/.test(f.question)), status);
  }
});

test('London shows quote pounds; options with no price are dropped', () => {
  const uk = describeDiscountTickets('X', { ...lr, lottery: { ...lr.lottery!, price: undefined as unknown as number } }, '£');
  assert.ok(uk && !/lottery/.test(uk) && /£40/.test(uk));
  assert.equal(describeDiscountTickets('X', { lottery: null, rush: null, standingRoom: null }, '$'), null);
  const one = describeDiscountTickets('X', { lottery: null, rush: null, standingRoom: { price: 30, time: '', instructions: '' } }, '£');
  assert.ok(one && !/cheapest/.test(one), 'single option does not repeat its price');
  const t = getShowFAQs(show({ category: 'west-end', venue: 'Apollo Victoria' }), null, null, { lotteryRush: lr }).find(f => /cheap/.test(f.question));
  assert.match(t!.answer, /£49/);
});

test('a rush typed digital is called digital rush, not general rush', () => {
  const t = describeDiscountTickets('X', { lottery: null, rush: { type: 'digital', platform: 'TodayTix', price: 40, time: '', instructions: '' }, standingRoom: null }, '$');
  assert.match(t!, /digital rush \(TodayTix\) for \$40/);
  assert.doesNotMatch(t!, /general/);
});

test('FAQPage JSON-LD matches the visible FAQ one to one', () => {
  const extras = { audience, lotteryRush: lr };
  const visible = getShowFAQs(show(), null, null, extras);
  const schema = generateShowFAQSchema(show(), null, null, extras)!;
  assert.deepEqual(schema.mainEntity.map(q => q.name), visible.map(f => f.question));
  assert.ok(visible.some(f => /audiences/.test(f.question)) && visible.some(f => /cheap/.test(f.question)));
});

test('lottery data loader drops options with no usable price (bare "$" on the card)', async () => {
  const { dropUnpricedOptions, getLotteryRush } = await import('../../src/lib/data-lottery');
  const out = dropUnpricedOptions({ lottery: null, rush: null, standingRoom: { price: 40, time: '', instructions: '' }, studentRush: { price: undefined as unknown as number, type: 'student', time: '', instructions: '' } });
  assert.equal(out.studentRush, null);
  assert.equal(out.standingRoom!.price, 40);
  // Real data: every option the loader returns has a positive numeric price.
  for (const id of ['the-rocky-horror-show-2026', 'hamilton-2015', 'harry-potter-2021']) {
    const lr = getLotteryRush(id) as unknown as Record<string, { price?: unknown } | null> | undefined;
    if (!lr) continue;
    for (const k of ['lottery', 'rush', 'digitalRush', 'studentRush', 'standingRoom', 'specialLottery']) {
      if (lr[k]) assert.ok(typeof lr[k]!.price === 'number' && (lr[k]!.price as number) > 0, `${id}.${k}`);
    }
  }
});

test('a lottery on "show website" reads naturally', () => {
  const t = describeDiscountTickets('X', { lottery: { type: 'general', platform: 'show website', url: '', price: 35, time: '', instructions: '' }, rush: null, standingRoom: null }, '£');
  assert.match(t!, /a lottery on the show website for £35/);
});

test('a program named for its price is not followed by the same price again (MTC $35)', () => {
  const lr = { specialLottery: { name: 'MTC $35', platform: '', url: '', price: 35, instructions: '' }, lottery: { type: 'digital', platform: 'TodayTix', price: 40 } } as unknown as Parameters<typeof describeDiscountTickets>[1];
  const out = describeDiscountTickets('Awake and Sing!', lr, '$') || '';
  assert.match(out, /a special lottery \(MTC \$35\)\./);
  assert.doesNotMatch(out, /MTC \$35\) for \$35/);
  assert.match(out, /lottery \(TodayTix\) for \$40/);
});

test('a price that is only a prefix of the number in the name is still stated ($3 vs "MTC $35")', () => {
  const lr = { specialLottery: { name: 'MTC $35', platform: '', url: '', price: 3, instructions: '' } } as unknown as Parameters<typeof describeDiscountTickets>[1];
  assert.match(describeDiscountTickets('X', lr, '$') || '', /\(MTC \$35\) for \$3\./);
});
