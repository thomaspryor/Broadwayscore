// BRO-5673: land-retry-cancelled.yml's jobs pick their work by the literal cron
// string (github.event.schedule). Changing a cron without its `if:` lines would
// silently stop the stranded-ref and reclaim passes, so pin both together.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(dir, '../../.github/workflows/land-retry-cancelled.yml'), 'utf8');
const crons = [...src.matchAll(/^\s*- cron: '([^']+)'/gm)].map((m) => m[1]);
const keyed = [...src.matchAll(/github\.event\.schedule [!=]= '([^']+)'/g)].map((m) => m[1]);

describe('land-retry-cancelled schedules (BRO-5673)', () => {
  it('has the hourly stranded/reclaim cron and a faster sweep backstop', () => {
    assert.deepEqual(crons, ['*/20 * * * *', '23 * * * *']);
  });
  it('every schedule string a job keys on is a real cron', () => {
    assert.equal(keyed.length, 3, 'sweep, stranded and reclaim each key on the hourly string');
    for (const s of keyed) assert.ok(crons.includes(s), `job keys on '${s}', which no cron fires`);
  });
});
