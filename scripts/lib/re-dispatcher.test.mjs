import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCriticalCronEntries, decideRedispatches, shouldThrottle, acceptsRedispatch, redispatchBandHours, isScheduleDead } = require('./re-dispatcher.js');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const NOW = Date.parse('2026-10-12T10:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const DISPATCH_ONLY = 'on:\n  schedule:\n    - cron: \'37 * * * *\'\n  workflow_dispatch:\n';
const DISPATCHABLE = DISPATCH_ONLY + '    inputs:\n      redispatched:\n        default: \'false\'\n';

function entry(workflow, maxHours, months = null) {
  return { workflow, maxHours, name: workflow.replace('.yml', ''), months };
}

test('parses the live CRITICAL_CRONS registry, including the two BRO-4282 crons', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/check-cron-health.yml'), 'utf8');
  const entries = parseCriticalCronEntries(yaml);
  assert.ok(entries.length > 40, `expected the full registry, got ${entries.length}`);
  const byWf = Object.fromEntries(entries.map((e) => [e.workflow, e]));
  assert.equal(byWf['audit-aggregator-gap.yml'].maxHours * 60, 720); // BRO-3867: 12h band
  assert.ok(byWf['clear-stale-wrong-production-flags.yml'], 'clear-stale-wrong-production-flags.yml must be in CRITICAL_CRONS');
  for (const e of entries) {
    const wf = path.join(ROOT, '.github/workflows', e.workflow);
    assert.ok(fs.existsSync(wf), `${e.workflow} listed but missing`);
  }
});

test('BRO-3867: widened opening-night bands keep the old re-dispatch window', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/check-cron-health.yml'), 'utf8');
  const byWf = Object.fromEntries(parseCriticalCronEntries(yaml).map((e) => [e.workflow, e]));
  const want = { 'audit-aggregator-gap.yml': 3, 'check-opening-night-drift.yml': 2, 'opening-night-checklist.yml': 3, 'opening-night-express-retry-check.yml': 3, 'social-autopost.yml': 1 };
  for (const [wf, h] of Object.entries(want)) {
    const text = fs.readFileSync(path.join(ROOT, '.github/workflows', wf), 'utf8');
    assert.ok(acceptsRedispatch(text), `${wf} must accept redispatch`);
    assert.equal(redispatchBandHours(text, byWf[wf].maxHours), h, wf);
  }
});

test('commented-out entries are ignored; seasonal months parse', () => {
  const yaml = '#  "a.yml|3|A"\n  CRITICAL_CRONS=(\n    "b.yml|36|B"\n    "c.yml|72|C|4-6"\n  )';
  assert.deepEqual(parseCriticalCronEntries(yaml).map((e) => [e.workflow, e.months]), [['b.yml', null], ['c.yml', [4, 6]]]);
});

test('dispatches when no run of any event was created within the band', () => {
  const { dispatch } = decideRedispatches({
    entries: [entry('audit-aggregator-gap.yml', 3)],
    lastRuns: { 'audit-aggregator-gap.yml': { lastCreatedAt: hoursAgo(3.5) } },
    workflowYaml: { 'audit-aggregator-gap.yml': DISPATCHABLE },
    now: NOW,
  });
  assert.deepEqual(dispatch.map((d) => d.workflow), ['audit-aggregator-gap.yml']);
  assert.equal(dispatch[0].hoursSince, 3.5);
});

test('does not dispatch inside the band (the re-dispatched run itself resets the clock)', () => {
  const { dispatch } = decideRedispatches({
    entries: [entry('clear-stale-wrong-production-flags.yml', 36)],
    lastRuns: { 'clear-stale-wrong-production-flags.yml': { lastCreatedAt: hoursAgo(25) } },
    workflowYaml: { 'clear-stale-wrong-production-flags.yml': DISPATCHABLE },
    now: NOW,
  });
  assert.equal(dispatch.length, 0);
});

test('a failed run query is unknown, never stale', () => {
  const { dispatch, skipped } = decideRedispatches({
    entries: [entry('a.yml', 3)],
    lastRuns: { 'a.yml': { lastCreatedAt: null, error: true } },
    workflowYaml: { 'a.yml': DISPATCHABLE },
    now: NOW,
  });
  assert.equal(dispatch.length, 0);
  assert.equal(skipped[0].reason, 'run query failed');
});

test('skips: no dispatch trigger, not opted in, disabled, out of season, never ran', () => {
  const entries = [entry('nodisp.yml', 3), entry('opt.yml', 3), entry('off.yml', 3), entry('tony.yml', 3, [4, 6]), entry('never.yml', 3)];
  const old = { lastCreatedAt: hoursAgo(100) };
  const { dispatch, skipped } = decideRedispatches({
    entries,
    lastRuns: { 'nodisp.yml': old, 'opt.yml': old, 'off.yml': old, 'tony.yml': old, 'never.yml': { lastCreatedAt: null } },
    workflowYaml: {
      'nodisp.yml': "on:\n  schedule:\n    - cron: '0 1 * * *'\n",
      'opt.yml': DISPATCH_ONLY,
      'off.yml': DISPATCHABLE,
      'tony.yml': DISPATCHABLE,
      'never.yml': DISPATCHABLE,
    },
    states: { 'off.yml': 'disabled_manually' },
    now: NOW,
  });
  assert.equal(dispatch.length, 0);
  assert.deepEqual(Object.fromEntries(skipped.map((s) => [s.workflow, s.reason])), {
    'nodisp.yml': 'no workflow_dispatch trigger',
    'opt.yml': 'not opted in (no redispatched input)',
    'off.yml': 'state disabled_manually',
    'tony.yml': 'out of season',
    'never.yml': 'no runs on record',
  });
  assert.equal(acceptsRedispatch(DISPATCH_ONLY + '    inputs:\n      redispatched_at:\n'), false, 'only the exact input name opts in');
});

test('redispatch-after-hours tightens the band, never loosens it', () => {
  assert.equal(redispatchBandHours('# redispatch-after-hours: 26\n', 36), 26);
  assert.equal(redispatchBandHours('# redispatch-after-hours: 48\n', 36), 36);
  assert.equal(redispatchBandHours('', 36), 36);
  const { dispatch } = decideRedispatches({
    entries: [entry('d.yml', 36)],
    lastRuns: { 'd.yml': { lastCreatedAt: hoursAgo(27) } },
    workflowYaml: { 'd.yml': DISPATCHABLE + '# redispatch-after-hours: 26\n' },
    now: NOW,
  });
  assert.deepEqual(dispatch.map((d) => [d.workflow, d.maxHours]), [['d.yml', 26]]);
});

test('a schedule with no scheduled run in 7 days is flagged dead', () => {
  assert.equal(isScheduleDead(null, NOW), true);
  assert.equal(isScheduleDead(hoursAgo(24 * 8), NOW), true);
  assert.equal(isScheduleDead(hoursAgo(30), NOW), false);
});

test('every live opted-in workflow treats redispatched=true as its scheduled run', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const yaml = fs.readFileSync(path.join(dir, 'check-cron-health.yml'), 'utf8');
  const opted = parseCriticalCronEntries(yaml).filter((e) => acceptsRedispatch(fs.readFileSync(path.join(dir, e.workflow), 'utf8')));
  assert.ok(opted.length >= 2, `expected the BRO-4282 crons opted in, got ${opted.map((e) => e.workflow)}`);
  for (const e of opted) {
    // Comments do not count: a mention in a comment must not satisfy the check.
    const text = fs.readFileSync(path.join(dir, e.workflow), 'utf8').replace(/^\s*#.*$/gm, '');
    // Any branch on how the run started must also consult the flag.
    if (/github\.event_name|github\.event\.schedule/.test(text)) {
      assert.match(text, /inputs\.redispatched/, `${e.workflow} branches on its trigger but never reads inputs.redispatched`);
    }
  }
});

test('caps a burst at maxPerSweep, most overdue relative to its band first', () => {
  const entries = [entry('a.yml', 36), entry('b.yml', 3), entry('c.yml', 10), entry('d.yml', 5)];
  const lastRuns = { 'a.yml': { lastCreatedAt: hoursAgo(40) }, 'b.yml': { lastCreatedAt: hoursAgo(12) }, 'c.yml': { lastCreatedAt: hoursAgo(11) }, 'd.yml': { lastCreatedAt: hoursAgo(15) } };
  const workflowYaml = Object.fromEntries(entries.map((e) => [e.workflow, DISPATCHABLE]));
  const { dispatch, skipped } = decideRedispatches({ entries, lastRuns, workflowYaml, now: NOW, maxPerSweep: 2 });
  assert.deepEqual(dispatch.map((d) => d.workflow), ['b.yml', 'd.yml']);
  assert.deepEqual(skipped.map((s) => s.workflow).sort(), ['a.yml', 'c.yml']);
});

test('throttle: one sweep per fixed 30-min window, never starved by a stream of throttled runs', () => {
  assert.equal(shouldThrottle({ prevRunCreatedAt: '2026-10-12T10:01:00Z', myCreatedAt: '2026-10-12T10:20:00Z' }), true);
  assert.equal(shouldThrottle({ prevRunCreatedAt: '2026-10-12T10:20:00Z', myCreatedAt: '2026-10-12T10:31:00Z' }), false);
  // Runs every 5 min forever: each new window still gets its first sweep.
  let sweeps = 0;
  for (let m = 5; m <= 120; m += 5) {
    const prev = new Date(NOW + (m - 5) * 60000).toISOString();
    const mine = new Date(NOW + m * 60000).toISOString();
    if (!shouldThrottle({ prevRunCreatedAt: prev, myCreatedAt: mine })) sweeps++;
  }
  assert.equal(sweeps, 4);
  assert.equal(shouldThrottle({ prevRunCreatedAt: null, myCreatedAt: '2026-10-12T10:00:00Z' }), false);
});

test('the two reverify scripts are on a weekly schedule with --limit (BRO-4282 AC3)', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/reverify-cv-promoted-weekly.yml'), 'utf8');
  assert.match(yaml, /cron:\s*'\d+ \d+ \* \* \d'/);
  assert.match(yaml, /reverify-stale-cv-promoted\.js[^\n]*--limit=\$LIMIT/);
  assert.match(yaml, /reverify-nulled-cv-promoted\.js[^\n]*--limit=\$LIMIT/);
  assert.match(yaml, /LIMIT: \$\{\{ inputs\.limit \|\| '\d+' \}\}/, 'scheduled runs need a numeric default limit');
});

test('BRO-6351: owner-facing frequent crons are opted in at 0.75h and a redispatch never sends the roundup', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const byWf = Object.fromEntries(parseCriticalCronEntries(fs.readFileSync(path.join(dir, 'check-cron-health.yml'), 'utf8')).map((e) => [e.workflow, e]));
  for (const wf of ['owner-decision-emails.yml', 'visual-approval-land.yml']) {
    const text = fs.readFileSync(path.join(dir, wf), 'utf8');
    assert.ok(byWf[wf], `${wf} must be in CRITICAL_CRONS`);
    assert.ok(acceptsRedispatch(text), `${wf} must accept redispatch`);
    assert.equal(redispatchBandHours(text, byWf[wf].maxHours), 0.75, wf);
  }
  const live = fs.readFileSync(path.join(dir, 'owner-decision-emails.yml'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.match(live, /REDISPATCHED: \$\{\{ inputs\.redispatched \}\}/);
  assert.match(live, /\[ "\$ROUNDUP" = "true" \] \|\| \{ \[ "\$REDISPATCHED" != "true" \] && \[ "\$SCHEDULE" = "17 15 \*\/3 \* \*" \]; \}/, 'the schedule-string roundup must be gated on REDISPATCHED != true');
});
