// BRO-7552: spend-effect-check replays the 2026-11-15 failures as ledger fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowOf, compare, parseLedger, format } = require('./spend-effect-check.js');

const LAND = Date.parse('2026-11-15T18:37:00Z');
const H = 3600000;
const row = (t, o = {}) => JSON.stringify({ ts: new Date(t).toISOString(), provider: 'scrapingbee', host: 'deadline.com', fn: 'render', credits: 5, purpose: null, showId: 'x', ...o });
const many = (start, n, spanMs, o) => Array.from({ length: n }, (_, i) => row(start + (i * spanMs) / n, o));

test('flowOf separates Broadway/WE press night from off-market and other', () => {
  assert.equal(flowOf({ purpose: 'press-night:downstate-2026:2026-11-16' }), 'press-night-broadway-we');
  assert.equal(flowOf({ purpose: 'press-night:potus-off-broadway-2026:2026-11-13' }), 'press-night-off-market');
  assert.equal(flowOf({ purpose: 'press-night:hamlet-off-west-end-2026:2026-11-12' }), 'press-night-off-market');
  assert.equal(flowOf({ purpose: null }), 'other');
});

test('BRO-7532 replay: 24 paid renders/hour before and after is NO CHANGE, not savings', () => {
  const ledger = [...many(LAND - H, 24, H), ...many(LAND, 24, H)].join('\n');
  const r = compare(parseLedger([row(LAND - 2 * H, 1), ledger].join('\n')), { since: LAND, until: LAND + H, hosts: ['deadline.com'] });
  assert.equal(r.verdict, 'NO CHANGE');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].verdict, 'NO CHANGE');
  assert.equal(r.rows[0].beforePerHour, 24);
  assert.match(format(r), /NO CHANGE/);
});

test('637f3125e replay: doubled Broadway press-night cost is WORSE even when the target flow improved', () => {
  const bw = { purpose: 'press-night:downstate-2026:2026-11-16', provider: 'brightdata', host: 'google.com', fn: 'serp-unlocker' };
  const other = { purpose: 'press-night:potus-off-broadway-2026:2026-11-13', provider: 'scrapingbee', host: 'google.com', fn: 'serp' };
  const ledger = [row(LAND - 2 * H, 1), ...many(LAND - H, 10, H, bw), ...many(LAND, 22, H, bw), ...many(LAND - H, 30, H, other), ...many(LAND, 2, H, other)].join('\n');
  const r = compare(parseLedger(ledger), { since: LAND, until: LAND + H });
  assert.equal(r.verdict, 'WORSE');
  const by = Object.fromEntries(r.rows.map((x) => [x.flow, x.verdict]));
  assert.equal(by['press-night-off-market'], 'saved');
  assert.equal(by['press-night-broadway-we'], 'WORSE');
});

test('a real saving is reported, vendors can be selected, windows are equal length', () => {
  const sd = { provider: 'scrapingdog', host: 'serp.scrapingdog' };
  const ledger = [row(LAND - 2 * H, 1), ...many(LAND - H / 2, 20, H / 2), ...many(LAND, 2, H / 2), ...many(LAND, 50, H / 2, sd)].join('\n');
  const r = compare(parseLedger(ledger), { since: LAND, until: LAND + H / 2 });
  assert.equal(r.windowHours, 0.5);
  assert.equal(r.rows.find((x) => x.host === 'deadline.com').verdict, 'saved');
  const onlySd = compare(parseLedger(ledger), { since: LAND, until: LAND + H / 2, vendors: { include: ['scrapingdog'] } });
  assert.equal(onlySd.rows.length, 1);
  assert.equal(onlySd.rows[0].verdict, 'new');
});

test('nothing elapsed since the land: says so instead of inventing a verdict', () => {
  const r = compare(parseLedger(many(LAND - H, 5, H).join('\n')), { since: LAND, until: LAND });
  assert.match(format(r), /do not call this verified/);
});

test('poller rows with purpose null still count as press night, Broadway vs off-market by showId', () => {
  assert.equal(flowOf({ script: 'opening-night-poller.js', purpose: null, showId: 'downstate-2026' }), 'press-night-broadway-we');
  assert.equal(flowOf({ script: 'opening-night-poller.js', purpose: null, showId: 'potus-off-broadway-2026' }), 'press-night-off-market');
  assert.equal(flowOf({ script: 'gather-reviews.js', purpose: null, showId: 'downstate-2026' }), 'other');
});

test('page -> render at the same call count is WORSE on est $, not NO CHANGE', () => {
  const page = { fn: 'page', credits: 1 };
  const render = { fn: 'render', credits: 5 };
  const ledger = [row(LAND - 2 * H, 1), ...many(LAND - H, 20, H, page), ...many(LAND, 20, H, render)].join('\n');
  const r = compare(parseLedger(ledger), { since: LAND, until: LAND + H });
  assert.equal(r.rows[0].verdict, 'WORSE');
});

test('SERP rows are selectable with --hosts=serp and a Bright Data row (credits 0) still costs', () => {
  const sd = { provider: 'scrapingdog', host: 'serp.scrapingdog', fn: 'serp', credits: 5 };
  const bd = { provider: 'brightdata', host: 'serp.brightdata', fn: 'serp-unlocker', credits: 0 };
  const ledger = [row(LAND - 2 * H, 1), ...many(LAND - H, 10, H, sd), ...many(LAND, 10, H, sd), ...many(LAND, 10, H, bd)].join('\n');
  const r = compare(parseLedger(ledger), { since: LAND, until: LAND + H, hosts: ['serp'] });
  assert.equal(r.rows.length, 2);
  assert.equal(r.verdict, 'new');
});

test('a ledger that does not reach back a full window is pending, never a verdict', () => {
  const r = compare(parseLedger(many(LAND - H / 4, 5, H / 4).concat(many(LAND, 5, H)).join('\n')), { since: LAND, until: LAND + H });
  assert.equal(r.baselineComplete, false);
  assert.equal(r.verdict, 'pending');
  assert.match(format(r), /WARNING: the ledger does not reach back/);
});

test('ship-check BRO-7552: a ledger with no rows after the land time is pending, never "saved"', () => {
  const ledger = [row(LAND - 2 * H, 1), ...many(LAND - H, 24, H)].join('\n');
  const r = compare(parseLedger(ledger), { since: LAND, until: LAND + H, hosts: ['deadline.com'] });
  assert.equal(r.afterComplete, false);
  assert.equal(r.verdict, 'pending');
  assert.match(format(r), /git pull/);
});
