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
const { detectAnomalies, detectCWVAnomalies } = require('../../scripts/check-seo-health.js');
const { findCWVFieldAcknowledgment, ACKNOWLEDGED_CWV_FIELD_REGRESSIONS } = require('../../scripts/lib/seo-cwv-ack.js');
const HOST = 'https://broadwayscorecard.com';

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

/**
 * CWV lab-Lighthouse severity guard.
 *
 * Background: once Core Web Vitals monitoring was repaired (PageSpeed API key
 * added 2026-06-21), the first working run flagged homepage (lab Lighthouse 69)
 * and /show/hamilton (68) under the 70 floor and emailed a CRITICAL alert — even
 * though field/CrUX data was healthy (LCP 797–1077ms, INP 112–118ms, CLS 0). Lab
 * Lighthouse is a synthetic slow-4G + 4x-CPU score; a low value with healthy field
 * data does not hurt real users.
 *
 * Fix: cwv_lighthouse_low is 'error' (CRITICAL email) only when field LCP also
 * breaches Good (>2500ms); otherwise 'warning' (digest only).
 */
describe('detectCWVAnomalies — lab Lighthouse severity', () => {
  test('low lab Lighthouse + healthy field LCP → warning (no CRITICAL email)', () => {
    const cwv = [{ url: `${HOST}/`, performanceScore: 69, lcp: 797, inp: 112, cls: 0 }];
    const issues = detectCWVAnomalies(cwv, []);
    const lh = issues.find(i => i.type === 'cwv_lighthouse_low');
    assert.ok(lh, 'should still flag the low Lighthouse score');
    assert.strictEqual(lh.severity, 'warning', 'healthy field data → warning, not error');
  });

  test('low lab Lighthouse + bad field LCP → error (real users hurt)', () => {
    const cwv = [{ url: `${HOST}/show/hamilton`, performanceScore: 68, lcp: 4200, inp: 118, cls: 0 }];
    const issues = detectCWVAnomalies(cwv, []);
    const lh = issues.find(i => i.type === 'cwv_lighthouse_low');
    assert.ok(lh, 'should flag the low Lighthouse score');
    assert.strictEqual(lh.severity, 'error', 'field LCP over Good → escalate to error');
  });

  test('healthy Lighthouse → no anomaly', () => {
    const cwv = [{ url: `${HOST}/off-broadway`, performanceScore: 92, lcp: 1077, inp: 118, cls: 0 }];
    const issues = detectCWVAnomalies(cwv, []);
    assert.strictEqual(issues.find(i => i.type === 'cwv_lighthouse_low'), undefined);
  });
});

/**
 * Field-LCP post-fix grace acknowledgment (card #368).
 *
 * Background: #311/#317 shipped the SSR fix for /west-end's LCP poster
 * (commit 20315509d45, 2026-07-21), but field LCP is CrUX 28-day trailing
 * data — it stays over the 2500ms Good threshold for weeks regardless of the
 * fix, so cwv_lighthouse_low kept escalating to 'error' (CRITICAL email) for
 * already-resolved work. scripts/lib/seo-cwv-ack.js registers an expiring,
 * per-{url,metric}-scoped acknowledgment that downgrades this back to a
 * tracked warning instead of silently dropping the anomaly.
 */
describe('detectCWVAnomalies — field-LCP acknowledgment (#368)', () => {
  // Pinned to a date inside the ack's window on purpose. The ack expires by
  // design (2026-08-18), so asserting "acknowledged → warning" against the real
  // clock makes this test fail on that date with no commit behind it. The
  // expiry behaviour itself is covered separately by
  // 'findCWVFieldAcknowledgment returns null once expired' below, which pins
  // the other side of the boundary.
  const WITHIN_ACK_WINDOW = '2026-07-24';

  test('/west-end field-LCP regression is acknowledged → warning, not error', () => {
    const cwv = [{ url: `${HOST}/west-end`, performanceScore: 69, lcp: 2512, inp: null, cls: 0 }];
    const issues = detectCWVAnomalies(cwv, [], WITHIN_ACK_WINDOW);
    const lh = issues.find(i => i.type === 'cwv_lighthouse_low');
    assert.ok(lh, 'should still flag the low Lighthouse score');
    assert.strictEqual(lh.severity, 'warning', 'acknowledged field regression → warning, not error');
    assert.match(lh.message, /acknowledged/, 'message should surface the acknowledgment, not hide it');

    const lcpAbs = issues.find(i => i.type === 'cwv_lcp_absolute');
    assert.ok(lcpAbs);
    assert.match(lcpAbs.message, /acknowledged/, 'cwv_lcp_absolute should also surface the acknowledgment');
  });

  test('a different page with the same symptom is NOT acknowledged (scoped per-url)', () => {
    const cwv = [{ url: `${HOST}/show/hamilton`, performanceScore: 68, lcp: 4200, inp: 118, cls: 0 }];
    const issues = detectCWVAnomalies(cwv, []);
    const lh = issues.find(i => i.type === 'cwv_lighthouse_low');
    assert.strictEqual(lh.severity, 'error', 'unregistered url/metric must still escalate normally');
    assert.doesNotMatch(lh.message, /acknowledged/);
  });

  test('findCWVFieldAcknowledgment returns null once expired', () => {
    const ack = findCWVFieldAcknowledgment(`${HOST}/west-end`, 'lcp', '2026-08-18');
    assert.strictEqual(ack, null, 'acknowledgment must not apply on/after its expiry date');
  });

  test('findCWVFieldAcknowledgment returns null for an unregistered metric on the same url', () => {
    const ack = findCWVFieldAcknowledgment(`${HOST}/west-end`, 'cls', '2026-07-24');
    assert.strictEqual(ack, null, 'acknowledgment is scoped to the exact metric, not the whole url');
  });
});

/**
 * Origin-fallback field data (card #419).
 *
 * Background: the card fired as "1 critical SEO anomalies: Lighthouse score below 70
 * on /west-end: 69/100 + field LCP 2512ms over 2500ms". PSI serves the ORIGIN's CrUX
 * data under the same field names whenever a URL is below the sampling floor, and
 * check-seo-health.js could not tell the two apart. Consequences: one site-wide number
 * escalated every audited page to `error` (N CRITICAL cards for one root cause), the
 * page-specific message sent readers hunting a page-specific fix, and a page crossing
 * the sampling floor produced a phantom several-hundred-ms LCP "regression".
 *
 * Fixtures are real snapshots from data/audit/seo-performance-history.json.
 */
describe('detectCWVAnomalies — origin-fallback field data (#419)', () => {
  const originWeek = [
    { url: `${HOST}/`, performanceScore: 95, lcp: 3000, inp: 112, cls: 0 },
    { url: `${HOST}/show/hamilton`, performanceScore: 69, lcp: 3000, inp: 112, cls: 0 },
    { url: `${HOST}/off-broadway`, performanceScore: 68, lcp: 3000, inp: 112, cls: 0 },
  ];

  test('one origin-level LCP breach produces ONE error, not one per page', () => {
    const issues = detectCWVAnomalies(originWeek, []);
    const errors = issues.filter(i => i.severity === 'error');
    assert.strictEqual(errors.length, 1, `one origin measurement must yield one error, got ${errors.length}`);
    assert.strictEqual(errors[0].type, 'cwv_lcp_absolute');
    assert.strictEqual(errors[0].scope, 'origin');
    assert.match(errors[0].message, /^SITE-WIDE:/);
  });

  test('the per-page LCP threshold anomaly is not repeated for every origin-scoped page', () => {
    const issues = detectCWVAnomalies(originWeek, []);
    const lcpAbs = issues.filter(i => i.type === 'cwv_lcp_absolute');
    assert.strictEqual(lcpAbs.length, 1, 'three pages sharing one measurement must not emit three anomalies');
  });

  test('a low lab score with an origin-level field breach stays a warning and says so', () => {
    const issues = detectCWVAnomalies(originWeek, []);
    const hamilton = issues.find(i => i.type === 'cwv_lighthouse_low' && i.message.includes('/show/hamilton'));
    assert.ok(hamilton);
    assert.strictEqual(hamilton.severity, 'warning', 'an origin number cannot escalate an individual page');
    assert.match(hamilton.message, /site-wide slowdown is reported separately/);
  });

  test('a genuine page-level field breach still escalates to error', () => {
    // /west-end's own 2512ms alongside four pages sharing the 1455ms origin value.
    const mixed = [
      { url: `${HOST}/`, performanceScore: 71, lcp: 1455, inp: 111, cls: 0 },
      { url: `${HOST}/show/hamilton`, performanceScore: 68, lcp: 1455, inp: 111, cls: 0 },
      { url: `${HOST}/off-broadway`, performanceScore: 72, lcp: 1455, inp: 111, cls: 0 },
      { url: `${HOST}/some-page`, performanceScore: 60, lcp: 4200, inp: null, cls: 0 },
    ];
    const issues = detectCWVAnomalies(mixed, []);
    const lh = issues.find(i => i.type === 'cwv_lighthouse_low' && i.message.includes('/some-page'));
    assert.strictEqual(lh.severity, 'error', 'page-level breach + low lab score is a real page problem');
    assert.match(lh.message, /AND real visitors' LCP is 4200ms over the 2500ms target/);
  });

  test('crossing the CrUX sampling floor does not invent an LCP regression', () => {
    // Prior week: /west-end page-level at 1400ms. This week: it fell back to the
    // 2400ms origin value. A +1000ms delta with nothing about the page changed.
    const prior = {
      coreWebVitals: [
        { url: `${HOST}/`, lcp: 900, inp: 110, cls: 0, performanceScore: 90 },
        { url: `${HOST}/show/hamilton`, lcp: 900, inp: 110, cls: 0, performanceScore: 90 },
        { url: `${HOST}/west-end`, lcp: 1400, inp: null, cls: 0, performanceScore: 90 },
      ],
    };
    const current = [
      { url: `${HOST}/`, lcp: 2400, inp: 112, cls: 0, performanceScore: 90 },
      { url: `${HOST}/show/hamilton`, lcp: 2400, inp: 112, cls: 0, performanceScore: 90 },
      { url: `${HOST}/west-end`, lcp: 2400, inp: 112, cls: 0, performanceScore: 90 },
    ];
    const issues = detectCWVAnomalies(current, [prior, prior]);
    const westEndRegression = issues.find(
      i => i.type === 'cwv_lcp_regression' && i.message.includes('/west-end')
    );
    assert.strictEqual(westEndRegression, undefined, 'a measurement swap is not a regression');

    // The real 900ms → 2400ms move on the origin cohort is still reported — once,
    // at origin scope, rather than repeated for each page that shares the number.
    const originRegression = issues.find(i => i.type === 'cwv_lcp_regression' && i.scope === 'origin');
    assert.ok(originRegression, 'the real origin-level regression must still be reported');
    assert.match(originRegression.message, /2400ms \(was 900ms\)/);
    assert.strictEqual(issues.filter(i => i.type === 'cwv_lcp_regression').length, 1,
      'and exactly once — not once per page sharing the measurement');
  });

  test('a real regression within page-level data still fires', () => {
    const prior = {
      coreWebVitals: [
        { url: `${HOST}/a`, lcp: 1000, inp: 100, cls: 0, performanceScore: 90 },
        { url: `${HOST}/b`, lcp: 1500, inp: null, cls: 0, performanceScore: 90 },
      ],
    };
    const current = [
      { url: `${HOST}/a`, lcp: 1000, inp: 100, cls: 0, performanceScore: 90 },
      { url: `${HOST}/b`, lcp: 2200, inp: null, cls: 0, performanceScore: 90 },
    ];
    const issues = detectCWVAnomalies(current, [prior, prior]);
    const reg = issues.find(i => i.type === 'cwv_lcp_regression' && i.message.includes('/b'));
    assert.ok(reg, '/b stayed page-level and genuinely regressed 1500ms → 2200ms');
  });
});

/**
 * Gaps the /ship-check reviewers found in the first cut of the #419 fix.
 * Each test pins a specific under-alert or duplicate-alert they demonstrated.
 */
describe('detectCWVAnomalies — reviewer-found gaps (#419 round 2)', () => {
  test('a null-LCP origin record cannot swallow a real breach reported by its sibling', () => {
    // PSI's origin_fallback marker bypasses triple-grouping, so origin-scoped records
    // can disagree. Reading metrics off originScoped[0] alone silenced all three checks.
    const cwv = [
      { url: `${HOST}/a`, originFallback: true, lcp: null, inp: null, cls: null, performanceScore: 60 },
      { url: `${HOST}/b`, originFallback: true, lcp: 3000, inp: 600, cls: 0.3, performanceScore: 60 },
    ];
    const issues = detectCWVAnomalies(cwv, []);
    assert.ok(issues.find(i => i.type === 'cwv_lcp_absolute'), 'a 3000ms origin LCP must still be reported');
    assert.ok(issues.find(i => i.type === 'cwv_inp_absolute'), 'a 600ms origin INP must still be reported');
    assert.ok(issues.find(i => i.type === 'cwv_cls_absolute'), 'a 0.3 origin CLS must still be reported');
    assert.ok(issues.some(i => i.severity === 'error'), 'lab-low + breached origin field is still a real error');
  });

  test('origin INP and CLS breaches each emit exactly one anomaly, not one per page', () => {
    const cwv = [
      { url: `${HOST}/`, lcp: 1000, inp: 600, cls: 0.3, performanceScore: 90 },
      { url: `${HOST}/a`, lcp: 1000, inp: 600, cls: 0.3, performanceScore: 90 },
      { url: `${HOST}/b`, lcp: 1000, inp: 600, cls: 0.3, performanceScore: 90 },
    ];
    const issues = detectCWVAnomalies(cwv, []);
    assert.strictEqual(issues.filter(i => i.type === 'cwv_inp_absolute').length, 1);
    assert.strictEqual(issues.filter(i => i.type === 'cwv_cls_absolute').length, 1);
  });

  test('a site-wide LCP regression is one digest line, not one per origin-scoped page', () => {
    const week = (lcp) => [
      { url: `${HOST}/`, lcp, inp: 112, cls: 0, performanceScore: 90 },
      { url: `${HOST}/a`, lcp, inp: 112, cls: 0, performanceScore: 90 },
      { url: `${HOST}/b`, lcp, inp: 112, cls: 0, performanceScore: 90 },
      { url: `${HOST}/c`, lcp, inp: 112, cls: 0, performanceScore: 90 },
      { url: `${HOST}/d`, lcp, inp: 112, cls: 0, performanceScore: 90 },
    ];
    const prior = { coreWebVitals: week(1467) };
    const issues = detectCWVAnomalies(week(2200), [prior, prior]);
    const regressions = issues.filter(i => i.type === 'cwv_lcp_regression');
    assert.strictEqual(regressions.length, 1, `one shared measurement → one line, got ${regressions.length}`);
    assert.strictEqual(regressions[0].scope, 'origin');
    assert.match(regressions[0].message, /^SITE-WIDE:/);
  });

  test('an origin-scoped page never carries a url-scoped acknowledgment in its message', () => {
    // /west-end has a live ack (#368). Once its data is origin-scoped the number is
    // not /west-end's, so quoting the ack there contradicts the same sentence.
    const cwv = [
      { url: `${HOST}/`, lcp: 3000, inp: 112, cls: 0, performanceScore: 60 },
      { url: `${HOST}/west-end`, lcp: 3000, inp: 112, cls: 0, performanceScore: 60 },
      { url: `${HOST}/off-broadway`, lcp: 3000, inp: 112, cls: 0, performanceScore: 60 },
    ];
    const issues = detectCWVAnomalies(cwv, []);
    const we = issues.find(i => i.type === 'cwv_lighthouse_low' && i.message.includes('/west-end'));
    assert.ok(we);
    assert.doesNotMatch(we.message, /acknowledged/, 'a page-scoped ack must not annotate an origin-scoped number');
  });

  test('an origin-scoped acknowledgment downgrades the site-wide error when one is registered', () => {
    // Proves the origin branch of the ack lookup is reachable, not dead code.
    const withAck = ACKNOWLEDGED_CWV_FIELD_REGRESSIONS.some(a => a.url === HOST && a.metric === 'lcp');
    assert.strictEqual(
      findCWVFieldAcknowledgment(HOST, 'lcp') != null,
      withAck,
      'origin-scope lookup must resolve against a bare-origin registry key'
    );
  });

  test('KNOWN LIMIT: a lone page below the CrUX floor is not detectable by inference', () => {
    // Only PSI's origin_fallback marker can catch this — one page's origin value is
    // a unique triple. Pinned so the limitation is asserted, not discovered later.
    const cwv = [
      { url: `${HOST}/a`, lcp: 1000, inp: 100, cls: 0, performanceScore: 90 },
      { url: `${HOST}/b`, lcp: 1200, inp: 110, cls: 0, performanceScore: 90 },
      { url: `${HOST}/c`, lcp: 1467, inp: 112, cls: 0, performanceScore: 90 },
    ];
    const issues = detectCWVAnomalies(cwv, []);
    assert.strictEqual(issues.filter(i => i.scope === 'origin').length, 0,
      'no repeated triple → nothing is classified origin; behaviour matches pre-fix');
  });
});
