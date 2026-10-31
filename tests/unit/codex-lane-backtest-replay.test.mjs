// BRO-6139 (BRO-6134 stage 3, change safety): a change to the Codex runner's summary format, the
// lane alarm or its floors must still catch every known regression on the 18-day history, with no
// more false alarms on the healthy days. Offline replay of the committed history
// (tests/fixtures/codex-lane-history.json) through scripts/backtest-codex-lane-health.js replay().
// A deliberate floor change that moves a number: rerun
//   node scripts/backtest-codex-lane-health.js --fixture=tests/fixtures/codex-lane-history.json
// and update BASELINE in the same commit, with the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const B = require(path.join(ROOT, 'scripts/backtest-codex-lane-health.js'));
const R = require(path.join(ROOT, 'scripts/lib/codex-runner.js'));
const HIST = B.fromFixture(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/codex-lane-history.json'), 'utf8')));

// Hours from onset to the first confirmed alarm, and confirmed alarms in the healthy window
// (10-19 00:00 .. 10-21 12:00), as of BRO-6139. Delays may only shrink; false alarms may only fall.
const BASELINE = {
  delayH: { E1: 0.6, E2: 2.6, E3: 5.6, E4: 0.6, E5: 5.6, E6: 0.6, E7: 0.7 },
  // The class that first catches each episode: any other confirmed breach overlapping it must not stand in.
  cls: { E1: 'codex:landed-low', E2: 'codex:landed-low', E3: 'cloud:no-run', E4: 'cloud:no-run', E5: 'cloud:landed-none', E6: 'cloud:landed-none', E7: 'gha:stand-down' },
  healthyFalseAlarms: 22,
};

const result = B.replay(HIST);

test('replay: every known Codex-lane regression is still caught, no later than before', () => {
  for (const e of result.episodes) {
    assert.notEqual(e.delayH, null, `${e.id} (${e.what}) is no longer caught:\n${B.report(result)}`);
    assert.ok(e.classes.includes(BASELINE.cls[e.id]), `${e.id} (${e.what}) is first caught as ${e.classes.join(', ')}, not ${BASELINE.cls[e.id]}:\n${B.report(result)}`);
    assert.ok(e.delayH <= BASELINE.delayH[e.id] + 0.05, `${e.id} (${e.what}) now alarms ${e.delayH.toFixed(1)}h after onset (was ${BASELINE.delayH[e.id]}h):\n${B.report(result)}`);
  }
});

test('replay: no more false alarms on the healthy days than before', () => {
  assert.ok(result.healthy.checks >= 60, 'the healthy window is covered');
  assert.ok(result.healthy.falseAlarms <= BASELINE.healthyFalseAlarms, `${result.healthy.falseAlarms} confirmed false alarms (was ${BASELINE.healthyFalseAlarms}):\n${B.report(result)}`);
});

test('replay: the runner\'s lane-marked headings read exactly as the history they replace', () => {
  // Rewrite every summary heading the way daily-runner.js now writes it (R.summaryHeading, with the
  // lane laneOfSummary gives the old heading); the alarm must not change at any hour.
  const rewritten = HIST.summaries.map((c) => {
    const h = R.parseSummaryHeading(c.body);
    if (!h) return c;
    const lane = R.laneOfSummary(c.body, Date.parse(c.createdAt), HIST.runs);
    const slot = h.slot === null ? (lane === 'gha' ? R.LANES.gha.base : 0) : h.slot;
    const rest = c.body.split('\n').slice(1).join('\n');
    return { ...c, body: `${R.summaryHeading({ date: h.date, worked: h.worked, mins: h.mins, slot, lane })}\n${rest}` };
  });
  assert.ok(rewritten.every((c) => !R.parseSummaryHeading(c.body) || R.parseSummaryHeading(c.body).lane));
  const again = B.replay({ ...HIST, summaries: rewritten });
  const key = (r) => r.timeline.map((x) => `${x.t}:${x.confirmed.map((b) => `${b.lane}:${b.cls}`).sort().join(',')}`).join('\n');
  assert.equal(key(again), key(result));
});
