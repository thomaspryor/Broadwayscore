// BRO-5050: the BRO-5020 cap-only commercial entries must stay applied to
// data/commercial.json (private data repo, gitignored). Skips when the file
// is absent (CI jobs without the private data).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = process.env.COMMERCIAL_JSON || path.join(root, 'data/commercial.json');
const present = fs.existsSync(file);
const data = present ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const records = data.productions || data.shows || data;

const EXPECTED = {
  'the-lehman-trilogy-2021': { designation: 'TBD', capitalization: 5750000 },
  'mrs-doubtfire-2021': { designation: 'TBD', capitalization: 18000000 },
  'thoughts-of-a-colored-man-2021': { designation: 'TBD', capitalization: 5000000 },
  'the-piano-lesson-2022': { designation: 'TBD', capitalization: 7000000 },
  'caroline-or-change-2021': { designation: 'Nonprofit' },
  'grey-house': { designation: 'TBD', capitalization: 8000000 },
};

for (const [slug, want] of Object.entries(EXPECTED)) {
  test(`${slug} carries the BRO-5020 values`, { skip: !present && 'data/commercial.json not available' }, () => {
    const rec = records[slug];
    assert.ok(rec, `${slug} missing from commercial.json`);
    for (const [k, v] of Object.entries(want)) assert.equal(rec[k], v, `${slug}.${k}`);
  });
}

test('grey-house has no loss label without a recouped source', { skip: !present && 'data/commercial.json not available' }, () => {
  const rec = records['grey-house'];
  assert.notEqual(rec.recouped, true, 'never recouped:true without citation');
  if (['Fizzle', 'Flop'].includes(rec.designation)) assert.ok(rec.recoupedSource, 'loss label needs a cited source');
});

test('piano-lesson recouped:true carries its citation', { skip: !present && 'data/commercial.json not available' }, () => {
  const rec = records['the-piano-lesson-2022'];
  if (rec.recouped === true) assert.ok(rec.recoupedSource, 'recouped:true needs recoupedSource');
});
