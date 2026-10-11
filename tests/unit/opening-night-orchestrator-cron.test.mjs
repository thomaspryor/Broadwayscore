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
