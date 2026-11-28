// BRO-7402: a first-pass discovery cron that GitHub drops loses the race to the sweep that grades it.
// The Good Thief (opened 2026-11-17): Front Row Center published 2026-11-18 01:26 UTC; the opening-window
// outlet poller (the first pass that reads FRC's feed) last ran 00:57 and GitHub did not start it again until
// 11:42, while the hourly audit-aggregator-gap sweep (opted into cron-redispatch at 1h) found the review at 10:27.
// Rule: every first-pass discovery cron listed here is opted into cron-redispatch with a band no longer than its
// own schedule interval, so a dropped tick is replaced. Uses the real re-dispatcher and the live workflow files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rd = require('../../scripts/lib/re-dispatcher.js');
const ow = require('../../scripts/lib/outlet-opening-window.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WF = path.join(ROOT, '.github/workflows');
const read = (f) => fs.readFileSync(path.join(WF, f), 'utf8');

// First-pass crons: workflow file -> its own schedule interval in hours.
const FIRST_PASS_CRONS = {
  'outlet-listing-poller-window.yml': 3,
};

const entries = rd.parseCriticalCronEntries(read('check-cron-health.yml'));

for (const [wf, intervalH] of Object.entries(FIRST_PASS_CRONS)) {
  test(`${wf} is a CRITICAL_CRONS entry opted into cron-redispatch within its ${intervalH}h interval`, () => {
    const e = entries.find((x) => x.workflow === wf);
    assert.ok(e, `${wf} missing from check-cron-health.yml CRITICAL_CRONS`);
    const yaml = read(wf);
    assert.ok(rd.acceptsRedispatch(yaml), `${wf} has no redispatched input: a dropped cron tick is never replaced`);
    const band = rd.redispatchBandHours(yaml, e.maxHours);
    assert.ok(band <= intervalH, `${wf} re-dispatch band ${band}h exceeds its ${intervalH}h schedule`);
  });
}

test('The Good Thief night: the 03:30 sweep re-dispatches the window poller (last run 00:57)', () => {
  const wf = 'outlet-listing-poller-window.yml';
  const e = entries.find((x) => x.workflow === wf);
  const { dispatch, skipped } = rd.decideRedispatches({
    entries: [e],
    lastRuns: { [wf]: { lastCreatedAt: '2026-11-18T00:57:56Z' } },
    workflowYaml: { [wf]: read(wf) },
    states: { [wf]: 'active' },
    now: Date.parse('2026-11-18T03:30:00Z'),
  });
  assert.deepEqual(skipped, []);
  assert.deepEqual(dispatch.map((d) => d.workflow), [wf]);
});

test('a run inside the band is left alone (no extra spend)', () => {
  const wf = 'outlet-listing-poller-window.yml';
  const e = entries.find((x) => x.workflow === wf);
  const { dispatch } = rd.decideRedispatches({
    entries: [e],
    lastRuns: { [wf]: { lastCreatedAt: '2026-11-18T02:00:00Z' } },
    workflowYaml: { [wf]: read(wf) },
    now: Date.parse('2026-11-18T03:30:00Z'),
  });
  assert.deepEqual(dispatch, []);
});

// More ticks must not mean the same show collected twice at once (ship-check P1).
test('activeCollectShowIds reads show ids from queued/running collect run titles only', () => {
  const runs = [
    { displayTitle: 'Collect Review Texts \u2014 the-good-thief-off-broadway-2026', status: 'in_progress' },
    { displayTitle: 'Collect Review Texts \u2014 a-2026,b-2026', status: 'queued' },
    { displayTitle: 'Collect Review Texts \u2014 done-2026', status: 'completed' },
    { displayTitle: 'Collect Review Texts', status: 'in_progress' },
  ];
  assert.deepEqual([...ow.activeCollectShowIds(runs)].sort(), ['a-2026', 'b-2026', 'the-good-thief-off-broadway-2026']);
  assert.deepEqual([...ow.activeCollectShowIds(null)], []);
});

test('collect-review-texts.yml run title carries the show list in the form the window poller parses', () => {
  const y = read('collect-review-texts.yml');
  const m = y.match(/^run-name:\s*(.+)$/m);
  assert.ok(m, 'collect-review-texts.yml has no run-name: the window poller cannot see which show is being collected');
  assert.ok(m[1].includes("format(' \u2014 {0}', github.event.inputs.show_filter)"), m[1]);
  assert.match(read('outlet-listing-poller-window.yml'), /activeCollectShowIds/);
});
