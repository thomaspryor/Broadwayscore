// BRO-2730: West End press embargoes lift ~21:00-22:00 UTC but the only West
// End evening cron was 18:00 UTC. Also: GitHub delays these crons 3-6h, so the
// market must come from the cron string (github.event.schedule), never the
// clock hour. Locks both.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(dir, '../../.github/workflows/opening-night-orchestrator.yml'), 'utf8');
const crons = [...src.matchAll(/^\s*- cron: '(0 \d+ \* \* \*)'/gm)].map((m) => m[1]);
const westEnd = (list) => list.split('|').map((x) => x.replace(/"/g, ''));
const stepList = src.match(/case "\$\{\{ github\.event\.schedule \}\}" in\s*\n\s*([^)]+)\)/)[1];
const runNameList = [...src.match(/fromJSON\(''\[(.*?)\]''\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

describe('opening-night-orchestrator West End cron coverage (BRO-2730)', () => {
  it('has a West End late-evening cron between 20:00Z and 23:00Z', () => {
    const we = westEnd(stepList);
    assert.ok(crons.some((c) => we.includes(c) && +c.split(' ')[1] >= 20 && +c.split(' ')[1] <= 23), `crons ${crons}`);
  });
  it('step and run-name agree on which crons are West End', () => {
    assert.deepEqual([...westEnd(stepList)].sort(), [...runNameList].sort());
  });
  it('every West End cron in the maps is an actual schedule entry', () => {
    for (const c of runNameList) assert.ok(crons.includes(c), c);
  });
  it('Broadway crons are not listed as West End', () => {
    for (const c of ['0 23 * * *', '0 0 * * *', '0 8 * * *']) assert.ok(!runNameList.includes(c), c);
  });
  it('Redundancy guard reads the market from the title for scheduled runs too', () => {
    const g = src.slice(src.indexOf('Title carries the market'));
    assert.ok(g.indexOf('(west-end)') < g.indexOf('hour_to_market "${START'));
  });
});

// BRO-6037: run the real Redundancy guard script (bash -e, as GitHub runs it)
// against a stubbed `gh run list`. 2026-10-23: the 01:00Z/01:09Z Broadway crons
// deferred to a 19:45Z run already past its loop budget, so nothing polled
// 01:15-02:20Z across the embargo.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';

const yaml = createRequire(import.meta.url)('js-yaml');
const wf = yaml.load(src);
const job = wf.jobs.orchestrate;
const guardStep = job.steps.find((st) => st.name === 'Redundancy guard');

function runGuard(rows, { market = 'broadway', myId = '900' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-guard-'));
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tsv = [[myId, 'schedule', iso(0), `Opening Night Orchestrator (${market})`], ...rows.map((r) => [r.id, r.event || 'workflow_dispatch', r.start ?? iso(r.minAgo), r.title])]
    .map((r) => r.join('\t')).join('\n');
  fs.writeFileSync(path.join(tmp, 'rows.tsv'), tsv + '\n');
  fs.writeFileSync(path.join(tmp, 'gh'), `#!/bin/sh\ncat "${path.join(tmp, 'rows.tsv')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'guard.sh'), guardStep.run);
  const out = path.join(tmp, 'out');
  const env = {
    ...process.env, ...job.env, PATH: `${tmp}:${process.env.PATH}`, MY_MARKET: market, MY_ID: myId,
    GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(tmp, 'summary'),
  };
  try {
    const log = execFileSync('bash', ['-e', path.join(tmp, 'guard.sh')], { env, encoding: 'utf8' });
    const redundant = /redundant=(\w+)/.exec(fs.readFileSync(out, 'utf8'))[1];
    return { redundant, log };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('Redundancy guard ignores runs past their loop budget (BRO-6037)', () => {
  it('guard and DEADLINE share LOOP_BUDGET_MIN', () => {
    assert.ok(Number(job.env.LOOP_BUDGET_MIN) > 0 && Number(job.env.PRESTEP_MARGIN_MIN) >= 0);
    assert.match(src, /DEADLINE=\$\(\( \$\(date \+%s\) \+ LOOP_BUDGET_MIN\*60 \)\)/);
  });
  it('the 2026-10-23 case: a 5h15m-old (auto) run is not coverage', () => {
    const r = runGuard([{ id: '100', minAgo: 315, title: 'Opening Night Orchestrator (auto)' }]);
    assert.equal(r.redundant, 'false');
    assert.match(r.log, /past its 240m loop budget/);
  });
  it('a 30-min-old same-market run still is', () => {
    assert.equal(runGuard([{ id: '100', minAgo: 30, title: 'Opening Night Orchestrator (broadway)' }]).redundant, 'true');
  });
  it('an expired run is skipped but a younger earlier run behind it still counts', () => {
    const r = runGuard([
      { id: '100', minAgo: 315, title: 'Opening Night Orchestrator (auto)' },
      { id: '200', minAgo: 9, title: 'Opening Night Orchestrator (broadway)' },
    ]);
    assert.equal(r.redundant, 'true');
  });
  it('an unparseable startedAt is skipped under bash -e instead of failing the step', () => {
    const r = runGuard([{ id: '100', start: '2026-13-45T99:00:00Z', title: 'Opening Night Orchestrator (broadway)' }]);
    assert.equal(r.redundant, 'false');
  });
  it('boundary: 254 min still covers, 255 min does not; scheduled (auto) titles use the hour map', () => {
    const cut = Number(job.env.LOOP_BUDGET_MIN) + Number(job.env.PRESTEP_MARGIN_MIN);
    assert.equal(runGuard([{ id: '100', minAgo: cut - 1, title: 'Opening Night Orchestrator (broadway)' }]).redundant, 'true');
    assert.equal(runGuard([{ id: '100', minAgo: cut + 1, title: 'Opening Night Orchestrator (broadway)' }]).redundant, 'false');
    // a scheduled pre-BRO-2730 "(auto)" run maps its start hour to a market; old ones still expire
    const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const start = iso(cut + 30);
    const hour = Number(start.slice(11, 13));
    const bw = hour >= 22 || hour <= 4 || (hour >= 8 && hour <= 13) || (hour >= 14 && hour <= 16);
    const r = runGuard([{ id: '100', event: 'schedule', start, title: 'Opening Night Orchestrator (auto)' }], { market: bw ? 'broadway' : 'west-end' });
    assert.equal(r.redundant, 'false');
  });
  it('another market is never coverage', () => {
    assert.equal(runGuard([{ id: '100', minAgo: 30, title: 'Opening Night Orchestrator (west-end)' }]).redundant, 'false');
  });
});
