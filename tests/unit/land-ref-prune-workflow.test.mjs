// BRO-6103: the prune workflow lands advisory (BRO-2123): it may delete only when
// apply is asked for explicitly, and it is the only thing that deletes refs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(dir, '../../.github/workflows/land-ref-prune.yml'), 'utf8');

describe('land-ref-prune.yml (BRO-6103)', () => {
  it('reports only unless apply is requested', () => {
    assert.match(src, /default: false/);
    assert.match(src, /vars\.LAND_REF_PRUNE_APPLY == 'true'/);
    assert.match(src, /else node scripts\/prune-stale-land-refs\.js; fi/);
  });
  it('runs one daily cron', () => {
    assert.deepEqual([...src.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]), ['41 5 * * *']);
  });
});
