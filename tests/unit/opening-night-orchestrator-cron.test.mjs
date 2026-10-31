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

// BRO-6037: run the REAL Redundancy guard bash (extracted from the workflow)
// against a stubbed `gh`. An earlier run started 5h ago is past its loop
// deadline window and must not count as cover; one started 30m ago must.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

function guardScript() {
  const lines = src.split('\n');
  const at = lines.findIndex((l) => /^\s*id: guard\s*$/.test(l));
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  const indent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() && l.match(/^\s*/)[0].length <= indent) break;
    body.push(l.slice(indent + 2));
  }
  return body.join('\n');
}

// The other run is a manual all-market dispatch: event workflow_dispatch,
// title "(auto)" (see run-name), so it covers every market at any clock hour.
function runGuard(otherStartedMinAgo, startOverride) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6037-'));
  const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  const rows = [
    ['111', 'workflow_dispatch', startOverride || iso(otherStartedMinAgo), 'Opening Night Orchestrator (auto)'],
    ['222', 'schedule', iso(1), 'Opening Night Orchestrator (broadway)'],
  ].map((r) => r.join('\t')).join('\n');
  fs.writeFileSync(path.join(tmp, 'rows.tsv'), rows + '\n');
  fs.writeFileSync(path.join(tmp, 'gh'), `#!/bin/bash\ncat "${tmp}/rows.tsv"\n`, { mode: 0o755 });
  // The guard reads `date -u +%s` for "now". Pin it to Node's Date.now() so the
  // fixture and the bash share one clock (the time-bomb audit shifts only Node's).
  fs.writeFileSync(path.join(tmp, 'date'),
    `#!/bin/bash\nif [ "$# $1 $2" = "2 -u +%s" ]; then echo ${Math.floor(Date.now() / 1000)}; else exec /bin/date "$@"; fi\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'guard.sh'), guardScript());
  const out = path.join(tmp, 'out');
  const log = execFileSync('bash', ['-eo', 'pipefail', path.join(tmp, 'guard.sh')], {
    env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, MY_MARKET: 'broadway', MY_ID: '222',
      GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(tmp, 'summary') },
    encoding: 'utf8',
  });
  return { redundant: fs.readFileSync(out, 'utf8').trim(), log };
}

const num = (re) => Number(src.match(re)[1]);
const COVER = num(/COVER_MAX_AGE_MIN=(\d+)/);

describe('Redundancy guard ignores earlier runs near their loop deadline (BRO-6037)', () => {
  it('an earlier all-market run started 5h ago does not cover us', () => {
    const r = runGuard(300);
    assert.equal(r.redundant, 'redundant=false', r.log);
    assert.match(r.log, /Ignoring run 111/);
  });
  it('guard reads "now" via the exact `date -u +%s` call the test clock stub intercepts', () => {
    assert.match(guardScript(), /NOW_EPOCH=\$\(date -u \+%s\)/);
  });
  it('an earlier all-market run started 30m ago still covers us', () => {
    const r = runGuard(30);
    assert.equal(r.redundant, 'redundant=true', r.log);
  });
  it('cutoff boundary: just under counts, just over does not', () => {
    assert.equal(runGuard(COVER - 3).redundant, 'redundant=true');
    assert.equal(runGuard(COVER + 3).redundant, 'redundant=false');
  });
  it('an unparseable startedAt does not count as cover', () => {
    const r = runGuard(0, '2026-10-22T19:45:garbage');
    assert.equal(r.redundant, 'redundant=false', r.log);
    assert.match(r.log, /unparseable startedAt/);
  });
  it('a deferred-to run is sure to dispatch another poller before its DEADLINE', () => {
    // Worst-case iteration: 2min poller lookup + wait-for-run cap + sleep + 3min gh overhead.
    const deadline = num(/DEADLINE=\$\(\( \$\(date \+%s\) \+ (\d+)\*60 \)\)/);
    const wait = num(/wait-for-run\.sh "\$RUN_ID" (\d+)/);
    const interval = num(/POLL_INTERVAL=\$\{\{ inputs\.poll_interval_minutes \|\| (\d+) \}\}/);
    assert.ok(COVER + 2 + wait + interval + 3 <= deadline,
      `COVER_MAX_AGE_MIN=${COVER} + worst iteration ${2 + wait + interval + 3} > DEADLINE ${deadline}`);
  });
});
