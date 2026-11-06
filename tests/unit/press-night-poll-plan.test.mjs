// BRO-6858: 5-min orchestrator sleeps only in a Broadway show's first 2h after the embargo; input always wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pollIntervalMin } = require('../../scripts/lib/press-night-poll-plan.js');
const E = Date.parse('2026-11-09T03:00:00Z');
const M = 60000;
const bw = { id: 'wanted-2022', category: 'broadway', embargoMs: E };

test('fast only inside [embargo, +2h] for Broadway', () => {
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E + 30 * M }).intervalMin, 5);
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E + 121 * M }).intervalMin, 15);
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E - 10 * M }).intervalMin, 15);
  assert.equal(pollIntervalMin({ shows: [{ ...bw, category: 'off-broadway' }], nowMs: E + 30 * M }).intervalMin, 15);
  assert.equal(pollIntervalMin({ shows: [{ ...bw, embargoMs: NaN }], nowMs: E }).intervalMin, 15);
});

test('an explicit input wins; a default under 5 is never raised', () => {
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E + 30 * M, overrideMin: 20 }).intervalMin, 20);
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E + 30 * M, defaultMin: 3 }).intervalMin, 3);
});

// BRO-6858 item 4 (SERP): the orchestrator still sends --skip-serp on iterations 1-8, but for Broadway the poller's
// hourly SERP sweep (BRO-4272, serp-burst-caps.js) overrides it once the night's first reviews are stored, inside the
// poller's aggressive window and under the burst caps. This pins that the default press-night embargo and its first
// 3h fall inside that window, so the sweep cannot silently stop covering the night if either clock moves.
test('Broadway SERP sweep is allowed from the default embargo to +3h (date-only openingDate)', () => {
  const { defaultEmbargoAt } = require('../../scripts/lib/press-night-record.js');
  const { pollMode } = require('../../scripts/opening-night-poller.js');
  const { checkSerpBurstAllowed, DEFAULT_BW_SERP_BURST_CONFIG } = require('../../scripts/lib/serp-burst-caps.js');
  for (const openingDate of ['2026-11-08', '2026-03-15', '2026-07-01']) {
    const show = { id: 'x-2026', category: 'broadway', openingDate };
    const embargoMs = Date.parse(defaultEmbargoAt(show));
    assert.ok(Number.isFinite(embargoMs), `default embargo for ${openingDate}`);
    for (let t = embargoMs; t <= embargoMs + 180 * M; t += 10 * M) {
      const now = new Date(t);
      const mode = pollMode(show, now);
      assert.equal(mode, 'aggressive', `${openingDate} at ${now.toISOString()}`);
      const r = checkSerpBurstAllowed({
        flagEnabled: true, show, mode, hoursSinceOpening: (t - Date.parse(openingDate)) / 3600000,
        burstsToday: 0, burstsForShowToday: 0, minutesSinceLastBurstForShow: null, firstReviewsLanded: true,
        config: DEFAULT_BW_SERP_BURST_CONFIG,
      });
      assert.equal(r.allowed, true, `${openingDate} at ${now.toISOString()}: ${r.reason}`);
    }
  }
});
