/**
 * BRO-8262: the paid Browserbase reviews.php tier must not run when the cheap
 * fetchPage scan already returned a usable /reviews/ listing. Same page, so a
 * show missing from the cheap listing is missing from the paid render too
 * (80 poller runs 11-17..24: 223 misses, 0 paid finds, ~$31/week spent).
 *
 * Run: node --test scripts/lib/bww-rr-discover-paid-gate.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { discoverBwwRoundupUrl, isPaidCanaryCall } = require('./bww-rr-discover.js');

const LISTING = [
  'https://www.broadwayworld.com/article/Review-Roundup-Critics-Weigh-In-On-SOME-OTHER-SHOW-20261120',
];
const broadwayShow = { title: 'Seven Guitars', openingDate: '2026-11-20', category: 'broadway' };

function spyPaid(returns = []) {
  const spy = { calls: 0 };
  spy.fn = async () => { spy.calls++; return returns; };
  return spy;
}

// opts.fetchAnchors bypasses the cheap tier, so the paid tier is injected via
// opts.fetchPaidAnchors, which keeps the cheap tier running.
async function discover(show, { cheap, paidSpy, env = {}, opts = {} }) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return await discoverBwwRoundupUrl(show, {
      paidCanary: false,
      fetchSectionAnchors: async () => [],
      fetchCheapAnchors: async () => cheap,
      fetchPaidAnchors: paidSpy.fn,
      ...opts,
    });
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

describe('BRO-8262 paid reviews.php gate', () => {
  it('skips the paid tier when the cheap listing is usable but lacks the show', async () => {
    const paid = spyPaid(LISTING);
    const r = await discover(broadwayShow, { cheap: LISTING, paidSpy: paid });
    assert.strictEqual(paid.calls, 0, 'paid Browserbase fetch must not run after a usable cheap miss');
    assert.strictEqual(r.via, 'not-found');
    assert.strictEqual(r.tier, 'cheap-listing');
    assert.strictEqual(r.url, null);
  });

  it('BWW_PAID_AFTER_CHEAP_MISS other than "1" leaves the gate on', async () => {
    const paid = spyPaid(LISTING);
    const r = await discover(broadwayShow, { cheap: LISTING, paidSpy: paid, env: { BWW_PAID_AFTER_CHEAP_MISS: 'true' } });
    assert.strictEqual(paid.calls, 0);
    assert.strictEqual(r.tier, 'cheap-listing');
  });

  it('explicit skipReviewsPhp with a usable cheap listing stays section-only', async () => {
    const paid = spyPaid([]);
    const r = await discover(broadwayShow, { cheap: LISTING, paidSpy: paid, opts: { skipReviewsPhp: true } });
    assert.strictEqual(r.via, 'section-only');
    assert.strictEqual(paid.calls, 0);
  });

  it('paid-path not-found carries no tier', async () => {
    const paid = spyPaid(LISTING);
    const r = await discover(broadwayShow, { cheap: null, paidSpy: paid });
    assert.strictEqual(r.via, 'not-found');
    assert.strictEqual(r.tier, undefined);
  });

  it('canary call still runs the paid tier and uses a roundup the cheap listing missed', async () => {
    const hit = ['https://www.broadwayworld.com/article/Review-Roundup-Critics-Weigh-In-On-SEVEN-GUITARS-20261120'];
    const paid = spyPaid(hit);
    const r = await discover(broadwayShow, { cheap: LISTING, paidSpy: paid, opts: { paidCanary: true } });
    assert.strictEqual(paid.calls, 1, 'canary must spend the paid probe');
    assert.strictEqual(r.via, 'reviews.php');
    assert.strictEqual(r.url, hit[0]);
  });

  it('canary divergence is logged as a ::warning::', async () => {
    const hit = ['https://www.broadwayworld.com/article/Review-Roundup-Critics-Weigh-In-On-SEVEN-GUITARS-20261120'];
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
      await discover(broadwayShow, { cheap: LISTING, paidSpy: spyPaid(hit), opts: { paidCanary: true } });
    } finally { console.log = orig; }
    assert.ok(lines.some(l => l.startsWith('::warning::') && l.includes('DIVERGENCE') && l.includes(hit[0])), lines.join('\n'));
  });

  it('canary hash does not put any two shows in lockstep', () => {
    // A 31-multiplier rolling hash put some pairs of these ids in the same
    // canary hour every time (worst pair 21 of 200 hours, its full count).
    // Independent 10% samples share ~2 hours; deterministic sha1 worst is 9.
    const base = Date.UTC(2026, 10, 1);
    const hours = [...Array(200)].map((_, i) => new Date(base + i * 3600e3));
    const ids = [...Array(120)].map((_, n) => `show-${n}-2026`);
    const vec = ids.map(id => hours.map(h => isPaidCanaryCall({ id }, h, 10)));
    let worst = 0;
    for (let i = 0; i < vec.length; i++) {
      for (let j = i + 1; j < vec.length; j++) {
        let both = 0;
        for (let k = 0; k < hours.length; k++) if (vec[i][k] && vec[j][k]) both++;
        worst = Math.max(worst, both);
      }
    }
    assert.ok(worst < 15, `two shows shared ${worst} of 200 canary hours (lockstep)`);
  });

  it('canary samples roughly 1 in 10 show-hours and can be disabled', () => {
    let hits = 0;
    const base = Date.UTC(2026, 10, 1);
    for (let i = 0; i < 2000; i++) {
      const show = { id: `show-${i % 50}` };
      if (isPaidCanaryCall(show, new Date(base + i * 3600e3), 10)) hits++;
    }
    assert.ok(hits > 120 && hits < 280, `expected ~200 canary calls of 2000, got ${hits}`);
    assert.strictEqual(isPaidCanaryCall({ id: 'x' }, new Date(base), 0), false);
  });

  it('an empty cheap listing still reaches the paid tier (parser-drift guard)', async () => {
    const hit = ['https://www.broadwayworld.com/article/Review-Roundup-Critics-Weigh-In-On-SEVEN-GUITARS-20261120'];
    const paid = spyPaid(hit);
    const r = await discover(broadwayShow, { cheap: [], paidSpy: paid });
    assert.strictEqual(paid.calls, 1, 'zero cheap roundups may mean the cheap regex drifted; paid DOM read must run');
    assert.strictEqual(r.via, 'reviews.php');
  });

  it('still uses the paid tier when the cheap scan is unusable (null)', async () => {
    const hit = ['https://www.broadwayworld.com/article/Review-Roundup-Critics-Weigh-In-On-SEVEN-GUITARS-20261120'];
    const paid = spyPaid(hit);
    const r = await discover(broadwayShow, { cheap: null, paidSpy: paid });
    assert.strictEqual(paid.calls, 1, 'blocked cheap scan must fall back to Browserbase');
    assert.strictEqual(r.via, 'reviews.php');
  });

  it('forceReviewsPhp still forces the paid probe', async () => {
    const paid = spyPaid([]);
    await discover(broadwayShow, { cheap: LISTING, paidSpy: paid, opts: { forceReviewsPhp: true } });
    assert.strictEqual(paid.calls, 1);
  });

  it('BWW_PAID_AFTER_CHEAP_MISS=1 restores the old paid probe', async () => {
    const paid = spyPaid([]);
    await discover(broadwayShow, { cheap: LISTING, paidSpy: paid, env: { BWW_PAID_AFTER_CHEAP_MISS: '1' } });
    assert.strictEqual(paid.calls, 1);
  });

  it('Off-Broadway keeps section-only (no new miss records)', async () => {
    const paid = spyPaid([]);
    const r = await discover({ ...broadwayShow, category: 'off-broadway' }, { cheap: LISTING, paidSpy: paid });
    assert.strictEqual(r.via, 'section-only');
    assert.strictEqual(paid.calls, 0);
  });
});
