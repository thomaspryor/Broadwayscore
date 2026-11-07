import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from './lib/shows-sandbox.mjs';

const fixture = () => [
  { id: 'bigfoot-off-broadway-2026', title: 'Bigfoot', status: 'open', openingDate: '2026-02-11' },
  { id: 'eva-luna-off-broadway-2022', title: 'Eva Luna', status: 'open', openingDate: '2022-10-01', closingDate: null },
  { id: 'animal-wisdom-off-broadway-2022', title: 'Animal Wisdom', status: 'open', openingDate: '2022-01-01' },
  { id: 'untouched-2026', title: 'Untouched', status: 'open', openingDate: '2026-01-01' },
];
const byId = (shows, id) => shows.find(s => s.id === id);

test('manifest entries are applied: previews + dates, closed + closingDate, upcoming + null opening', () => {
  const r = runInSandbox('fix-show-statuses.js', [], fixture());
  assert.equal(r.status, 0);
  const big = byId(r.after, 'bigfoot-off-broadway-2026');
  assert.equal(big.status, 'previews');
  assert.equal(big.openingDate, '2026-03-01');
  assert.equal(big.previewDate, '2026-02-11');
  const eva = byId(r.after, 'eva-luna-off-broadway-2022');
  assert.equal(eva.status, 'closed');
  assert.equal(eva.closingDate, '2022-12-16');
  assert.ok(eva.closingDateSource, 'closing-date guard stamps its audit trail');
  const animal = byId(r.after, 'animal-wisdom-off-broadway-2022');
  assert.equal(animal.status, 'upcoming');
  assert.equal(animal.openingDate, null);
});

test('shows outside the manifest are left alone and missing manifest ids are reported, not fatal', () => {
  const r = runInSandbox('fix-show-statuses.js', [], fixture());
  assert.equal(r.status, 0);
  assert.deepEqual(byId(r.after, 'untouched-2026'), fixture()[3]);
  assert.match(r.stderr, /Show not found: spare-parts-off-broadway-2026/);
  assert.match(r.stdout, /Done\. 3 shows updated/);
});

test('--help exits 0 without writing', () => {
  const r = runInSandbox('fix-show-statuses.js', ['--help'], fixture());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.deepEqual(r.after, fixture());
});
