import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanArchiveIntegrity, deletePages, runQuarantine } = require('./aggregator-archive-scan.js');

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

test('runQuarantine --delete refuses without --expect and on a count mismatch, deleting nothing', () => {
  const root = fixture();
  const run = (...a) => runQuarantine([`--archive=${root}`, ...a], { defaultArchiveRoot: root, showById: shows, log() {}, error() {} });
  assert.equal(run(), 1, 'report mode exits 1 when poisoned pages exist');
  assert.equal(run('--delete'), 2);
  assert.equal(run('--delete', '--expect=99'), 2);
  assert.equal(fs.readdirSync(path.join(root, 'show-score')).length, 2);
  assert.equal(run('--delete', '--expect=1'), 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'show-score')), ['wicked-2003.html']);
  assert.equal(run(), 0, 'clean archive exits 0');
});

test('runQuarantine refuses a --delete against a missing archive', () => {
  const missing = path.join(os.tmpdir(), 'agg-scan-does-not-exist');
  assert.equal(runQuarantine(['--delete', '--expect=0'], { defaultArchiveRoot: missing, showById: shows, log() {}, error() {} }), 2);
});
