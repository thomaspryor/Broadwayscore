import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCoreFiles, findUnregisteredCoreFiles } from './core-data-registry-coverage.js';
import { CORE_DATA_MERGE_REGISTRY } from './core-data-merge-registry.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('extractCoreFiles parses the CORE_FILES bash array', () => {
  const text = 'CORE_FILES="shows.json reviews.json  commercial.json"\nother stuff';
  assert.deepEqual(extractCoreFiles(text), ['shows.json', 'reviews.json', 'commercial.json']);
});

test('extractCoreFiles returns empty when the line is absent', () => {
  assert.deepEqual(extractCoreFiles('no such line here'), []);
});

test('findUnregisteredCoreFiles flags a CORE_FILES entry with no registry match', () => {
  const registry = [{ file: 'shows.json', surface: 'private-core-data', status: 'special' }];
  const gaps = findUnregisteredCoreFiles(['shows.json', 'new-file.json'], registry);
  assert.deepEqual(gaps, [{ file: 'new-file.json' }]);
});

test('findUnregisteredCoreFiles ignores a registry entry on the wrong surface', () => {
  const registry = [{ file: 'commercial.json', surface: 'public-repo', status: 'active' }];
  const gaps = findUnregisteredCoreFiles(['commercial.json'], registry);
  assert.deepEqual(gaps, [{ file: 'commercial.json' }]);
});

test('findUnregisteredCoreFiles is clean when every CORE_FILES entry has a registry match', () => {
  const registry = [
    { file: 'a.json', surface: 'private-core-data', status: 'active' },
    { file: 'b.json', surface: 'private-core-data', status: 'deferred' },
  ];
  assert.deepEqual(findUnregisteredCoreFiles(['a.json', 'b.json'], registry), []);
});

test('REGRESSION: every real CORE_FILES entry in push-core-data/action.yml is registered', () => {
  const actionYml = fs.readFileSync(path.join(REPO_ROOT, '.github/actions/push-core-data/action.yml'), 'utf8');
  const coreFiles = extractCoreFiles(actionYml);
  assert.ok(coreFiles.length > 5, 'sanity: CORE_FILES parsing found a plausible number of entries');
  const gaps = findUnregisteredCoreFiles(coreFiles, CORE_DATA_MERGE_REGISTRY);
  assert.deepEqual(gaps, [], `unregistered CORE_FILES entries (add each to scripts/lib/core-data-merge-registry.js): ${JSON.stringify(gaps)}`);
});
