// TESTS-VS-DERIVED-DATA-EXEMPT: structural consistency check across awards.json, shows.json and tony-cutoffs.ts; asserts no specific derived values.
// Guard (BRO-5667): every Tony record's season label must agree with its
// ceremony number and opening-date window whenever two of the three agree.
// The fantasy scorer filters award records by season, so a mislabel scores a
// real nomination as 0. Fix with: node scripts/repair-awards-season-labels.js --write
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { repairSeasonLabels } = require(path.join(root, 'scripts/lib/awards-season-labels.js'));
const { readTonyCutoffs } = require(path.join(root, 'scripts/lib/tony-cutoffs-reader.js'));

const awardsPath = path.join(root, 'data/awards.json');
const showsPath = path.join(root, 'data/shows.json');

test('awards.json Tony season labels are consistent', { skip: !fs.existsSync(awardsPath) || !fs.existsSync(showsPath) }, () => {
  const awards = JSON.parse(fs.readFileSync(awardsPath, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = new Map((raw.shows || raw).map(s => [s.id, s]));
  const windows = readTonyCutoffs();
  const windowLabelFor = id => {
    const s = shows.get(id);
    if (!s?.openingDate || (s.category && s.category !== 'broadway')) return null;
    return windows.find(w => s.openingDate >= w.start && s.openingDate <= w.end)?.label || null;
  };
  const changes = repairSeasonLabels(awards.shows, windowLabelFor);
  assert.deepEqual(changes.map(c => `${c.id}: ${c.from.season} ${c.from.ceremony}`), []);
});
