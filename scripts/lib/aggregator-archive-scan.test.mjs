import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { scanArchiveIntegrity } = require('./aggregator-archive-scan.js');
const { deletePages } = require('../quarantine-poisoned-aggregator-archive.js');

const shows = {
  'wicked-2003': { id: 'wicked-2003', title: 'Wicked', category: 'broadway', openingDate: '2003-10-30', closingDate: null },
  'hamilton-2015': { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06', closingDate: null },
};
const page = (title) => `<html><head><title>${title}</title></head><body></body></html>`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-scan-'));
  fs.mkdirSync(path.join(root, 'show-score'));
  fs.writeFileSync(path.join(root, 'show-score', 'wicked-2003.html'), page('Wicked Reviews | Show Score'));
  fs.writeFileSync(path.join(root, 'show-score', 'hamilton-2015.html'), page('Wicked Reviews | Show Score'));
  return root;
}

test('scan flags only the page holding another show, with its file path', () => {
  const root = fixture();
  const { bad, totalScanned } = scanArchiveIntegrity(root, shows);
  assert.equal(totalScanned, 2);
  assert.deepEqual(bad.map(b => b.showId), ['hamilton-2015']);
  assert.equal(bad[0].file, path.join(root, 'show-score', 'hamilton-2015.html'));
});

test('deletePages removes exactly the scanned files', () => {
  const root = fixture();
  const { bad } = scanArchiveIntegrity(root, shows);
  assert.equal(deletePages(bad), 1);
  assert.deepEqual(fs.readdirSync(path.join(root, 'show-score')), ['wicked-2003.html']);
  assert.equal(scanArchiveIntegrity(root, shows).bad.length, 0);
});

test('CLI --delete refuses without --expect and on a count mismatch, deleting nothing', () => {
  const root = fixture();
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'quarantine-poisoned-aggregator-archive.js');
  const run = (...a) => spawnSync('node', [cli, `--archive=${root}`, ...a], { encoding: 'utf8' });
  // The CLI reads the real shows.json, where both fixture ids exist, so it finds 1 poisoned page:
  // --expect=99 is a real count mismatch and --delete with no --expect is refused outright.
  assert.equal(run('--delete').status, 2);
  assert.equal(run('--delete', '--expect=99').status, 2);
  assert.equal(fs.readdirSync(path.join(root, 'show-score')).length, 2);
  // and a matching --expect deletes exactly the poisoned page
  assert.equal(run('--delete', '--expect=1').status, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'show-score')), ['wicked-2003.html']);
});
