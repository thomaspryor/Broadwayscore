import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadDiscoveryRetiredIds } = require('./discovery-retired-ids');
const { matchesRetired } = require('./retired-show-ids');

test('discovery loads valid entries explicitly and preserves retirement matching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-registry-'));
  const listPath = join(dir, 'retired-show-ids.json');
  const entries = [{ id: 'old-show', title: 'Old Show', venue: 'Booth Theatre' }];
  try {
    writeFileSync(listPath, JSON.stringify(entries));
    const loaded = loadDiscoveryRetiredIds({ listPath });
    assert.deepEqual(loaded, entries);
    assert.deepEqual(matchesRetired({ id: 'old-show' }, loaded), { id: 'old-show', matchedBy: 'id' });
    assert.deepEqual(matchesRetired({ id: 'new-id', title: 'OLD SHOW', venue: 'Booth Theatre' }, loaded),
      { id: 'old-show', matchedBy: 'title+venue' });
    assert.equal(matchesRetired({ id: 'unrelated' }, loaded), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing and empty discovery registries retain the existing empty-list behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-registry-'));
  const listPath = join(dir, 'retired-show-ids.json');
  try {
    assert.deepEqual(loadDiscoveryRetiredIds({ listPath }), []);
    for (const raw of ['', '[]']) {
      writeFileSync(listPath, raw);
      assert.deepEqual(loadDiscoveryRetiredIds({ listPath }), []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid JSON, non-array JSON and unreadable registries fail closed with a single-line diagnostic naming the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-registry-'));
  const listPath = join(dir, 'retired-show-ids.json');
  const previous = process.env.RETIRED_IDS_PATH;
  process.env.RETIRED_IDS_PATH = listPath;
  try {
    for (const raw of ['{broken\nJSON', '{}', 'null']) {
      writeFileSync(listPath, raw);
      assert.throws(() => loadDiscoveryRetiredIds(), error => {
        assert.equal(error.code, 'RETIRED_IDS_UNREADABLE');
        assert.ok(error.message.includes(listPath));
        assert.match(error.message, /refusing discovery/);
        assert.equal(error.message.split('\n').length, 1);
        return true;
      });
    }
    rmSync(listPath);
    mkdirSync(listPath);
    assert.throws(() => loadDiscoveryRetiredIds({ listPath }), { code: 'RETIRED_IDS_UNREADABLE' });
  } finally {
    if (previous === undefined) delete process.env.RETIRED_IDS_PATH;
    else process.env.RETIRED_IDS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
