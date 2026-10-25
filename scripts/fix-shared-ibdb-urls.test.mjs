import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from './lib/shows-sandbox.mjs';

const U = 'https://www.ibdb.com/broadway-production/x-1';
const fixture = () => [
  { id: 'x-1998', title: 'X', openingDate: '1998-01-01', ibdbUrl: U },
  { id: 'x-2026', title: 'X', openingDate: '2026-01-01', ibdbUrl: U },
  { id: 'y-2020', title: 'Y', openingDate: '2020-01-01', ibdbUrl: 'https://www.ibdb.com/broadway-production/y' },
];
const byId = (shows, id) => shows.find(s => s.id === id);

test('--dry-run reports the revival but writes nothing', () => {
  const r = runInSandbox('fix-shared-ibdb-urls.js', ['--dry-run'], fixture());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would null ibdbUrl on x-2026 \(kept on x-1998\)/);
  assert.equal(byId(r.after, 'x-2026').ibdbUrl, U);
});

test('apply nulls the later production, keeps the earliest and unrelated shows', () => {
  const r = runInSandbox('fix-shared-ibdb-urls.js', [], fixture());
  assert.equal(r.status, 0);
  assert.equal(byId(r.after, 'x-2026').ibdbUrl, null);
  assert.equal(byId(r.after, 'x-1998').ibdbUrl, U);
  assert.match(byId(r.after, 'y-2020').ibdbUrl, /broadway-production\/y$/);
  assert.equal(r.after.length, 3);
});

test('nothing shared: exits 0 and leaves every show alone', () => {
  const shows = fixture().slice(2);
  const r = runInSandbox('fix-shared-ibdb-urls.js', [], shows);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to fix/);
  assert.deepEqual(r.after, shows);
});

test('--help exits 0 before touching the file', () => {
  const r = runInSandbox('fix-shared-ibdb-urls.js', ['--help'], fixture());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.equal(byId(r.after, 'x-2026').ibdbUrl, U);
});
