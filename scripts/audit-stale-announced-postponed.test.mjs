// BRO-4913 VERIFY: the audit exits nonzero and flags a fixture show whose
// official page shows a future first-performance date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const run = (pages) => spawnSync('node', [
  path.join(dir, 'audit-stale-announced-shows.js'), '--dry-run', '--fail-on-gap',
  `--shows-file=${path.join(dir, 'fixtures/postponed/shows.json')}`,
  `--reviews-file=${path.join(dir, 'fixtures/postponed/reviews.json')}`,
  `--pages-fixture=${pages}`, '--now=2026-10-11T12:00:00Z',
], { encoding: 'utf8' });

test('fixture show with future official date → exit 1 and flagged', () => {
  const r = run(path.join(dir, 'fixtures/postponed/pages.json'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /mm-fixture .*future date 2027-01-28/);
});
test('page with no future date → exit 0', () => {
  const r = run(path.join(dir, 'fixtures/postponed/pages-ok.json'));
  assert.equal(r.status, 0);
});
