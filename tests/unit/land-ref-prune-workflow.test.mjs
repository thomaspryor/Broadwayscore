// BRO-6103: the prune workflow landed advisory (BRO-2123). BRO-6276: the daily
// cron applies by default, LAND_REF_PRUNE_APPLY=false is the kill switch, and a
// manual run still reports unless apply=true.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(dir, '../../.github/workflows/land-ref-prune.yml'), 'utf8');

describe('land-ref-prune.yml (BRO-6103)', () => {
  it('applies on the cron, reports on a plain manual run, and has a kill switch', () => {
    assert.match(src, /default: false/);
    assert.match(src, /vars\.LAND_REF_PRUNE_APPLY != 'false' && \(inputs\.apply == true \|\| github\.event_name == 'schedule'/);
    assert.match(src, /else node scripts\/prune-stale-land-refs\.js; fi/);
  });
  it('runs one daily cron', () => {
    assert.deepEqual([...src.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]), ['41 5 * * *']);
  });
});
