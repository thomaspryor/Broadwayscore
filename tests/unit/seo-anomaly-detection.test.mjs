/**
 * SEO anomaly detection — clicks/position guard for impressions_drop.
 *
 * Background: 2026-04-26 alert "Impressions down 44% vs 4-week avg" was a false
 * positive — opening-night spike (Apr 5/12 hit 67k imp vs 24-37k baseline)
 * inflated the mean. Returning to baseline tripped the >30% threshold even though
 * clicks (-7% WoW), CTR (3.33% +33%), and position (13.0 flat) were all healthy.
 *
 * Fix: in detectAnomalies, suppress impressions_drop alert when clicks are within
 * 15% of avg AND position not worsened by >2 spots. Real SEO problems show up
 * in click outcomes; impression-only drops are usually long-tail churn.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectAnomalies } = require('../../scripts/check-seo-health.js');

// recent4 = last 4 entries before the new snapshot is pushed
function makeHistory(weeks) {
  return weeks.map((w, i) => ({
    date: `2026-W${i}`,
    clicks: w.clicks,
    impressions: w.impressions,
    ctr: w.ctr ?? 0.02,
    position: w.position,
  }));
}

describe('detectAnomalies — impressions drop guard', () => {
  test('2026-04-26 real case: 44% impression drop with stable clicks/position is suppressed', () => {
    // recent4 prior to current push: Mar 22, Apr 5, Apr 12, Apr 19
    const history = makeHistory([
      { clicks: 730, impressions: 37756, position: 12.9 },
      { clicks: 1327, impressions: 67823, position: 12.7 },
      { clicks: 1220, impressions: 65907, position: 12.9 },
      { clicks: 1086, impressions: 43683, position: 13.9 },
    ]);
    const current = { clicks: 1008, impressions: 30247, ctr: 0.0333, position: 13.0 };
    const issues = detectAnomalies(current, history);

    const impressionsAlert = issues.find(i => i.type === 'impressions_drop');
    assert.strictEqual(impressionsAlert, undefined, 'impressions_drop should be suppressed when clicks/position are healthy');
  });

  test('impressions drop AND clicks drop > 15% still fires', () => {
    const history = makeHistory([
      { clicks: 1000, impressions: 50000, position: 13 },
      { clicks: 1000, impressions: 50000, position: 13 },
      { clicks: 1000, impressions: 50000, position: 13 },
      { clicks: 1000, impressions: 50000, position: 13 },
    ]);
    // Clicks down 30%, impressions down 50% — real degradation
    const current = { clicks: 700, impressions: 25000, ctr: 0.028, position: 13 };
    const issues = detectAnomalies(current, history);

    const impressionsAlert = issues.find(i => i.type === 'impressions_drop');
    assert.ok(impressionsAlert, 'impressions_drop should fire when clicks also dropped');
  });

  test('impressions drop AND position worse > 2 spots still fires', () => {
    const history = makeHistory([
      { clicks: 1000, impressions: 50000, position: 10 },
      { clicks: 1000, impressions: 50000, position: 10 },
      { clicks: 1000, impressions: 50000, position: 10 },
      { clicks: 1000, impressions: 50000, position: 10 },
    ]);
    // Clicks stable but position worsened from 10 → 14
    const current = { clicks: 950, impressions: 25000, ctr: 0.038, position: 14 };
    const issues = detectAnomalies(current, history);

    const impressionsAlert = issues.find(i => i.type === 'impressions_drop');
    assert.ok(impressionsAlert, 'impressions_drop should fire when position worsened > 2 spots');
  });

  test('clicks down > 25% with impressions below avg still fires clicks_drop', () => {
    const history = makeHistory([
      { clicks: 1000, impressions: 50000, position: 13 },
      { clicks: 1000, impressions: 50000, position: 13 },
      { clicks: 1000, impressions: 50000, position: 13 },
      { clicks: 1000, impressions: 50000, position: 13 },
    ]);
    // Impressions fell below the 4-week avg → real loss, event-recede guard must not suppress
    const current = { clicks: 600, impressions: 40000, ctr: 0.015, position: 13 };
    const issues = detectAnomalies(current, history);

    const clicksAlert = issues.find(i => i.type === 'clicks_drop');
    assert.ok(clicksAlert, 'clicks_drop should fire when clicks down > 25% and impressions below avg');
  });
});

/**
 * Event-recede guard for clicks_drop.
 *
 * Background: 2026-06-21 alert "[CRITICAL] Clicks down 26% vs 4-week avg (853 vs
 * avg 1152)" was a false positive. The Tony Awards spike (06-07: 1320, 06-14:
 * 1553 clicks, dominated by "tony awards 2026 predictions" queries) inflated the
 * 4-week baseline. The first post-Tony week read as a 26% drop even though
 * impressions were near-record (73.6k vs ~53.7k avg) and position improved (9.6
 * vs 11.7 avg) — a CTR/query-mix shift, not a ranking loss. The seasonal YoY
 * suppression only fires at 52+ weeks of history; we had 18.
 *
 * Fix: suppress clicks_drop when impressions >= 4-week avg AND position not
 * worsened by > 2 spots. Real regressions move impressions down and/or position
 * worse, so they still fire.
 */
describe('detectAnomalies — clicks drop event-recede guard', () => {
  test('2026-06-21 real case: clicks drop with high impressions + improved position is suppressed', () => {
    // recent4 prior to the 06-21 push: 05-24, 05-31, 06-07, 06-14
    const history = makeHistory([
      { clicks: 814, impressions: 37998, position: 13.1 },
      { clicks: 920, impressions: 43009, position: 13.6 },
      { clicks: 1320, impressions: 53109, position: 10.7 },
      { clicks: 1553, impressions: 80780, position: 9.4 },
    ]);
    const current = { clicks: 853, impressions: 73617, ctr: 0.012, position: 9.6 };
    const issues = detectAnomalies(current, history);

    const clicksAlert = issues.find(i => i.type === 'clicks_drop');
    assert.strictEqual(clicksAlert, undefined, 'clicks_drop should be suppressed when impressions/position are healthy');
  });

  test('clicks drop with high impressions but position worsened > 2 spots still fires', () => {
    const history = makeHistory([
      { clicks: 1000, impressions: 50000, position: 9 },
      { clicks: 1000, impressions: 50000, position: 9 },
      { clicks: 1000, impressions: 50000, position: 9 },
      { clicks: 1000, impressions: 50000, position: 9 },
    ]);
    // Impressions healthy but rankings collapsed 9 → 14
    const current = { clicks: 700, impressions: 60000, ctr: 0.0117, position: 14 };
    const issues = detectAnomalies(current, history);

    const clicksAlert = issues.find(i => i.type === 'clicks_drop');
    assert.ok(clicksAlert, 'clicks_drop should fire when position worsened despite high impressions');
  });
});
