// The /methodology "Top critics" copy names critics by hand. This pins that list to
// TOP_CRITICS (the set that actually drives T1 weighting) so the page cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TOP_CRITICS } = require('./compute-critic-score.js');

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const page = fs.readFileSync(path.join(repoRoot, 'src/app/methodology/page.tsx'), 'utf8');

// First paragraph after the "Top critics" heading: "...outlet to outlet: A, B and C."
const section = page.split('>Top critics</h3>')[1] || '';
const listMatch = section.match(/outlet to outlet:\s*([^.<]+)\./);

test('methodology page has a parseable top-critics list', () => {
  assert.ok(listMatch, 'could not find the "outlet to outlet: ..." list under the Top critics heading');
});

test('methodology top-critics list matches TOP_CRITICS exactly', () => {
  const names = listMatch[1].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
  assert.deepEqual([...names].sort(), [...TOP_CRITICS].sort());
});

test('critics named in the T2-outlet note are top critics', () => {
  for (const name of ['Johnny Oleksinski', 'Elisabeth Vincentelli', 'Chris Jones']) {
    assert.ok(TOP_CRITICS.has(name), `${name} is named on the methodology page but is not in TOP_CRITICS`);
    assert.ok(page.includes(name), `${name} missing from methodology page`);
  }
});
