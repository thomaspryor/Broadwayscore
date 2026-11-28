// BRO-5909: a duplicateOf copy whose reference is excluded as a copy of another
// review must stay out of the rebuild, or the original review ships twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { duplicateOfExclusion } = require('../../scripts/lib/duplicate-of-exclusion.js');
const guards = require('../../scripts/lib/review-guards.js');

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcopy-'));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  return dir;
}
const run = (dir, file, extra) => {
  const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  return duplicateOfExclusion(data, path.join(dir, file), {
    readSibling: () => null, fileCount: 3,
    referenceExcluded: () => true,
    inheritedFlag: () => null,
    ...extra,
  });
};

test('excluded reference that is a copy: the duplicateOf copy is not recovered', () => {
  const dir = setup({ 'a.json': { duplicateOf: 'b.json', url: 'https://x/a' }, 'b.json': { url: 'https://x/b' } });
  const out = run(dir, 'a.json', { referenceIsCopy: () => true });
  assert.equal(out.reason, 'skippedDuplicateOf');
});

test('excluded reference that is not a copy: still recovered (unchanged)', () => {
  const dir = setup({ 'a.json': { duplicateOf: 'b.json', url: 'https://x/a' }, 'b.json': { url: 'https://x/b' } });
  assert.equal(run(dir, 'a.json', { referenceIsCopy: () => false }).reason, null);
  assert.equal(run(dir, 'a.json', {}).reason, null);
});

test('circular pair keeps its own tiebreak (the copy check never applies)', () => {
  const dir = setup({
    'a.json': { duplicateOf: 'b.json', url: 'https://x/same' },
    'b.json': { duplicateOf: 'a.json', url: 'https://x/same' },
  });
  assert.equal(run(dir, 'a.json', { referenceIsCopy: () => true }).reason, null);
});

test('duplicateOfRefIsCopy is true only for the copy reasons', () => {
  assert.ok(guards.DUPLICATE_OF_COPY_REF_REASONS.has('crossOutletDuplicate'));
  assert.ok(guards.DUPLICATE_OF_COPY_REF_REASONS.has('personalRepost'));
  assert.ok(guards.DUPLICATE_OF_COPY_REF_REASONS.has('knownSyndicationSecondary'));
  assert.equal(guards.duplicateOfRefIsCopy({}, {}, 'x.json'), false);
});

// Guard: every caller of the shared gate must pass the copy predicate, so the
// rebuild, scoring-delta and the census mirror cannot drift apart again.
test('rebuild and scoring-delta both pass referenceIsCopy to duplicateOfExclusion', () => {
  for (const f of ['scripts/rebuild-all-reviews.js', 'scripts/scoring-delta.js']) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    const calls = [...src.matchAll(/(?:=|\.)\s*(?:dupeLib\.)?duplicateOfExclusion\(/g)];
    assert.ok(calls.length >= 1, `${f} no longer calls duplicateOfExclusion`);
    for (const m of calls) assert.match(src.slice(m.index, m.index + 2500), /referenceIsCopy:/, `${f} must pass referenceIsCopy`);
  }
});

test('real predicate: copy-reason reference excludes, but confirmed-different text keeps the copy', () => {
  const words = (seed) => Array.from({ length: 120 }, (_, i) => `${seed}${i}`).join(' ');
  const same = words('alpha');
  assert.equal(guards.duplicateOfCopyRefVerdict('crossOutletDuplicate', { fullText: same }, { fullText: same }), true);
  assert.equal(guards.duplicateOfCopyRefVerdict('crossOutletDuplicate', { fullText: same }, { fullText: words('beta') }), false);
  assert.equal(guards.duplicateOfCopyRefVerdict('crossOutletDuplicate', {}, {}), true, 'no text to compare: keep excluded');
  assert.equal(guards.duplicateOfCopyRefVerdict('isSyndicatedDuplicate', { fullText: same }, { fullText: same }), true);
  assert.equal(guards.duplicateOfCopyRefVerdict('wrongAttribution', { fullText: same }, { fullText: same }), false);
  assert.equal(guards.duplicateOfCopyRefVerdict(null, { fullText: same }, { fullText: same }), false, 'no exclusion reason: recovered');
  assert.equal(guards.duplicateOfCopyRefVerdict('wrongAttribution', { fullText: same }, { fullText: same }), false);
});

test('only duplicateTextOf pointing back is still circular, so the copy check is skipped', () => {
  const dir = setup({
    'a.json': { duplicateOf: 'b.json', url: 'https://x/same' },
    'b.json': { duplicateTextOf: 'a.json', url: 'https://x/same' },
  });
  assert.equal(run(dir, 'a.json', { referenceIsCopy: () => true }).reason, null);
});
