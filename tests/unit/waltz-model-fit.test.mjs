import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fit = require('../../scripts/lib/waltz-model-fit.js');
const healthCheck = require('../../scripts/health-check.js');

const musical = (id) => ({ id, title: id, type: 'musical', venue: 'Some Theatre' });
const post = (date, body) => ({ created_utc: Date.parse(date) / 1000, selftext: body });
// His real layout (Grosses Analysis, week ending Oct 4 2026), figures varied per case.
const block = (name, profit) => `➡ ***${name}*** \\- *$1,000k, 80% capacity, $93 atp (Up \\~$43k from last week). Began performances March 29, 2024, Open-Ended.*\n\nGross Less-Fees: $880k; Estimated Weekly Operating Cost: $800k/week; Estimated Profit (Loss): ${profit}\n\n`;

describe('buildFitRows', () => {
  test('scores closed ranges with the model and skips open ranges and unmatched shows', () => {
    const body = block('Alpha', '$50k-$150k') + block('Beta', '$1M+') + block('Nobody', '$0-$10k');
    const rows = fit.buildFitRows([post('2026-10-05', body)], (n) => (n === 'Nobody' ? null : musical(n.toLowerCase())));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].showId, 'alpha');
    assert.equal(rows[0].postDate, '2026-10-05');
    assert.equal(rows[0].ratio, 1.25);
    // Model at $1M gross, $800k cost: 1M*(1-0.11) - (70k-96k→0) - 800k = 90k, inside $50k-$150k.
    assert.ok(Math.abs(fit.ourWeeklyProfit(1e6, 8e5, musical('alpha')) - 90000) < 1);
    assert.equal(rows[0].errPctNut, 0);
  });

  test('a range the model misses gets a signed error as % of cost', () => {
    const rows = fit.buildFitRows([post('2026-10-05', block('Alpha', '$200k-$300k'))], () => musical('alpha'));
    assert.ok(Math.abs(rows[0].errPctNut - -13.75) < 1e-9); // (90k-200k)/800k
  });
});

describe('summarizeFit', () => {
  const row = (showId, postDate, ratio, errPctNut) => ({ showId, postDate, ratio, errPctNut });

  test('suppresses bands under the row and show floors (public repo)', () => {
    const rows = [
      ...['a', 'b', 'c'].flatMap((s) => [row(s, '2026-10-04', 1.0, 0), row(s, '2026-09-27', 1.1, 5)]),
      row('d', '2026-10-04', 2.0, 0), row('d', '2026-09-27', 2.0, 0), row('d', '2026-09-20', 2.0, 0),
      row('d', '2026-09-13', 2.0, 0), row('d', '2026-09-06', 2.0, 0),
    ];
    const s = fit.summarizeFit(rows);
    assert.equal(s.asOf, '2026-10-04');
    assert.deepEqual(s.bands.mid, { n: 6, shows: 3, insidePct: 50, medianSignedPctNut: 2.5 });
    assert.deepEqual(s.bands.high, { n: 5, suppressed: true }); // one show only
    assert.deepEqual(s.bands.low, { n: 0, suppressed: true });
    assert.equal(s.overall.insidePct, 73);
    assert.ok(!JSON.stringify(s).includes('"a"'), 'no show ids in the output');
  });

  test('only the trailing 84 days count', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((s) => row(s, '2026-10-04', 1, 0));
    rows.push(row('f', '2026-07-01', 1, 50));
    assert.equal(fit.summarizeFit(rows).overall.n, 5);
  });
});

describe('recordFit and fitCheckStatus', () => {
  const entry = (asOf, insidePct, generatedAt = asOf) => ({ asOf, generatedAt, windowDays: 84, overall: { n: 50, shows: 20, insidePct }, bands: {} });

  test('a re-run for the same week replaces, never duplicates', () => {
    const h = fit.recordFit([entry('2026-09-27', 40)], entry('2026-10-04', 41));
    assert.equal(fit.recordFit(h, entry('2026-10-04', 45)).length, 2);
  });

  test('keeps 12 entries', () => {
    let h = [];
    for (let d = 1; d <= 15; d++) h = fit.recordFit(h, entry(`2026-08-${String(d).padStart(2, '0')}`, 40));
    assert.equal(h.length, 12);
    assert.equal(h[0].asOf, '2026-08-04');
  });

  const now = new Date('2026-10-06T12:00:00Z');
  test('pass carries the band line', () => {
    const r = fit.fitCheckStatus({ history: [entry('2026-10-04', 43)] }, now);
    assert.equal(r.status, 'pass');
    assert.match(r.message, /^overall 43% inside \(n=50\)/);
  });
  test('missing, stale and drift warn; never error', () => {
    assert.equal(fit.fitCheckStatus(null, now).status, 'warn');
    assert.match(fit.fitCheckStatus({ history: [entry('2026-09-20', 43)] }, now).message, /not updated for 16 days/);
    const drift = [entry('2026-09-13', 44), entry('2026-09-20', 42), entry('2026-09-27', 43), entry('2026-10-04', 25)];
    assert.match(fit.fitCheckStatus({ history: drift }, now).message, /dropped 18 points below its usual 43%/);
    drift[3] = entry('2026-10-04', 30);
    assert.equal(fit.fitCheckStatus({ history: drift }, now).status, 'pass');
  });
});

describe('staleness follows the Monday run, not his Tuesday post date', () => {
  // Monday 2026-10-12 run writes his Tuesday 2026-10-06 post.
  const file = { history: [{ asOf: '2026-10-06', generatedAt: '2026-10-12', windowDays: 84, overall: { n: 80, shows: 10, insidePct: 55 }, bands: {} }] };
  test('passes all week until the next Monday run is overdue', () => {
    for (const d of ['2026-10-13', '2026-10-16', '2026-10-19', '2026-10-21']) {
      assert.equal(fit.fitCheckStatus(file, new Date(`${d}T09:00:00Z`)).status, 'pass', d);
    }
    assert.match(fit.fitCheckStatus(file, new Date('2026-10-22T09:00:00Z')).message, /not updated/);
  });
  test('a run that keeps going but finds no new post warns after 16 days', () => {
    const f = { history: [{ ...file.history[0], generatedAt: '2026-10-19' }] };
    assert.match(fit.fitCheckStatus(f, new Date('2026-10-23T09:00:00Z')).message, /No new Boring Waltz post in 17 days/);
  });
  test('summarizeFit stamps the run date', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((s) => ({ showId: s, postDate: '2026-10-06', ratio: 1, errPctNut: 0 }));
    assert.equal(fit.summarizeFit(rows, '2026-10-12').generatedAt, '2026-10-12');
  });
  test('an implausible cost is skipped', () => {
    const body = block('Alpha', '$50k-$150k').replace('$800k/week', '$8k/week');
    assert.equal(fit.buildFitRows([post('2026-10-05', body)], () => musical('alpha')).length, 0);
  });
});

describe('health-check wiring', () => {
  test('routed this-week so a warn is named in the digest', () => {
    assert.equal(healthCheck.getPlaybookEntry('Commercial model: Boring Waltz fit').urgency, 'this-week');
  });
  test('the check runs and never errors', () => {
    const row = healthCheck.checkCommercialModelDrift().find((r) => r.name === 'Commercial model: Boring Waltz fit');
    assert.ok(row);
    assert.ok(['pass', 'warn'].includes(row.status), `${row.status}: ${row.message}`);
  });
});
