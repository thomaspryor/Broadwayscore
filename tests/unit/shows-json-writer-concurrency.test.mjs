// BRO-5574: backfill-playwright-credits.yml read-mutate-writes the shows catalog
// (scripts/backfill-playwright-credits.js saveShows + per-N-shows CI checkpoint pushes),
// so it must serialize with the other shows.json writers in the shared group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('backfill script still writes shows.json (premise of the shared group)', () => {
  assert.match(read('scripts/backfill-playwright-credits.js'), /saveShows\(\s*[a-z]/);
});

test('backfill-playwright-credits.yml is in the shows-json-writer concurrency group', () => {
  const m = read('.github/workflows/backfill-playwright-credits.yml').match(/^concurrency:\s*\n(?:[ \t]+#.*\n)*[ \t]+group:\s*(\S+)\s*\n(?:\s*\n)*[ \t]+cancel-in-progress:\s*(\S+)/m);
  assert.ok(m, 'top-level concurrency block missing');
  assert.equal(m[1], 'shows-json-writer');
  assert.equal(m[2], 'false');
});
