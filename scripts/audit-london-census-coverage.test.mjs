// BRO-5456: audit-london-census-coverage.js reads LONDON_SOURCES keys from source text
// (to stay off the scraper require graph); this pins that parse to the real module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { londonSourceIdsFromText, missingLondonReports } = require('./audit-london-census-coverage.js');
const { isSafeCheckCommand } = require('./lib/check-paths.js');

test('text parse of LONDON_SOURCES matches the real module keys, in order', () => {
  const text = fs.readFileSync(require.resolve('./lib/outlet-census-sources.js'), 'utf8');
  const { LONDON_SOURCES } = require('./lib/outlet-census-sources.js');
  const ids = londonSourceIdsFromText(text);
  assert.ok(ids.length > 0);
  assert.deepEqual(ids, Object.keys(LONDON_SOURCES));
});

test('londonSourceIdsFromText: missing block is [] (cannot verify), nested keys are skipped', () => {
  assert.deepEqual(londonSourceIdsFromText('const SOURCES = {};'), []);
  const text = "const LONDON_SOURCES = {\n  guardian: { kind: 'x',\n    parts: [\n      { kind: 'y' },\n    ] },\n  'times-uk': ciOnly(1),\n};\n";
  assert.deepEqual(londonSourceIdsFromText(text), ['guardian', 'times-uk']);
});

test('missingLondonReports lists ids without a report', () => {
  assert.deepEqual(missingLondonReports(['a', 'b', 'c'], (id) => id === 'b'), ['a', 'c']);
  assert.deepEqual(missingLondonReports([], () => false), []);
});

test('safe-form gate admits the bare command', () => {
  assert.equal(isSafeCheckCommand('node scripts/audit-london-census-coverage.js'), true);
});
