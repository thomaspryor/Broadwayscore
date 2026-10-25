import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideInclusion, FLAG_FIELDS } = require('./scoring-delta.js');
const { createBaselineShowSnapshot, loadDedupGuards } = require('./lib/scoring-delta-dedup.js');
const guards = {
  ...require('./lib/review-guards.js'),
  __dateGuard: require('./lib/date-guard.js'),
  __priorRunLib: require('./lib/wrong-production-autoclear.js'),
};
const show = { id: 'dedup-fixture', category: 'broadway', earliestDate: null };
const text = 'The performers bring comic timing and emotional depth to this remarkable production. '.repeat(20);
const review = { assignedScore: 75, contentTier: 'complete', fullText: text };

function fixture(t, records, fixtureShow = show) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bro3963-fixture-'));
  const dir = path.join(root, show.id);
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(records)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  }
  const decide = (name, data = records[name], sideGuards = guards) => decideInclusion(data, fixtureShow, sideGuards, path.join(dir, name));
  decide.dir = dir;
  return decide;
}

test('circular survivor flips when its non-review flag clears', t => {
  const a = { ...review, duplicateOf: 'b.json', isNonReview: true };
  const b = { ...review, duplicateOf: 'a.json' };
  const decide = fixture(t, { 'a.json': a, 'b.json': b });
  assert.equal(decide('a.json').included, false);
  assert.equal(decide('a.json', { ...a, isNonReview: false }).included, true);
  assert.equal(decide('b.json').included, false);
});

test('circular pair with a duplicateTextOf back-pointer keeps the lower file', t => {
  const decide = fixture(t, {
    'a.json': { ...review, duplicateOf: 'b.json' },
    'b.json': { ...review, duplicateOf: 'other.json', duplicateTextOf: 'a.json' },
  });
  assert.equal(decide('a.json').included, true);
});

test('circular pair with different text recovers both reviews', t => {
  const decide = fixture(t, {
    'a.json': { ...review, duplicateOf: 'b.json' },
    'b.json': { ...review, fullText: 'A different article celebrates an intimate musical with stunning choreography. '.repeat(20), duplicateOf: 'a.json' },
  });
  assert.equal(decide('a.json').included, true);
  assert.equal(decide('b.json').included, true);
});

test('same URL confirms a circular pair even with absent text', t => {
  const a = { ...review, fullText: null, dtliExcerpt: text, url: 'https://example.org/review', duplicateOf: 'b.json' };
  const b = { ...a, duplicateOf: 'a.json' };
  const decide = fixture(t, { 'a.json': a, 'b.json': b });
  assert.equal(decide('a.json').included, true);
  assert.equal(decide('b.json').included, false);
});

test('three-node duplicate cycle keeps exactly the lexical minimum', t => {
  const decide = fixture(t, {
    'a.json': { ...review, duplicateOf: 'b.json' },
    'b.json': { ...review, duplicateOf: 'c.json' },
    'c.json': { ...review, duplicateOf: 'a.json' },
  });
  assert.deepEqual(['a.json', 'b.json', 'c.json'].map(f => decide(f).included), [true, false, false]);
});

test('ordinary duplicate stays excluded; a stale pointer recovers', t => {
  const decide = fixture(t, {
    'a.json': { ...review, duplicateOf: 'b.json' },
    'b.json': review,
    'stale.json': { ...review, duplicateOf: 'missing.json' },
    'sentinel.json': { ...review, duplicateOf: 'known-outlet-copy-exists' },
  });
  assert.equal(decide('a.json').included, false);
  assert.equal(decide('stale.json').included, true);
  assert.equal(decide('sentinel.json').included, false);
});

for (const [label, referenceDate, allowEarlyDate, included] of [
  ['in-window reference excludes the copy', '2025-01-10', false, false],
  ['pre-window reference recovers the copy', '2020-01-01', false, true],
  ['early-date override keeps the reference live', '2020-01-01', true, false],
]) {
  test(`ordinary duplicate with a string show date: ${label}`, t => {
    const a = { ...review, publishDate: '2025-01-10', duplicateOf: 'b.json' };
    const decide = fixture(t, {
      'a.json': a,
      'b.json': { ...review, publishDate: referenceDate, allowEarlyDate },
    }, { ...show, earliestDate: '2025-01-01' });
    assert.equal(decide('a.json').included, included);
    assert.equal(decide('a.json', { ...a, duplicateOf: null }).included, true);
  });
}

test('excluded reference recovers a copy only when inherited flags are cleared', t => {
  const a = { ...review, duplicateOf: 'b.json' };
  const decide = fixture(t, { 'a.json': a, 'b.json': { ...review, isNonReview: true } });
  assert.equal(decide('a.json').included, false);
  assert.equal(decide('a.json', { ...a, duplicateOfFlagInheritanceCleared: true }).included, true);
});

test('clearing syndicated flag flips inclusion', t => {
  const d = { ...review, isSyndicatedDuplicate: true };
  const decide = fixture(t, { 'a.json': d });
  assert.equal(decide('a.json').included, false);
  assert.equal(decide('a.json', { ...d, isSyndicatedDuplicate: false }).included, true);
});

test('known syndicated secondary is excluded only with a live primary', t => {
  const secondary = { ...review, criticName: 'Chris Jones', outletId: 'nydailynews' };
  const decide = fixture(t, {
    'nydailynews--chris-jones.json': secondary,
    'chicagotribune--chris-jones.json': { ...review, criticName: 'Chris Jones', outletId: 'chicagotribune' },
  });
  assert.equal(decide('nydailynews--chris-jones.json').included, false);
  const primary = path.join(decide.dir, 'chicagotribune--chris-jones.json');
  fs.writeFileSync(primary, JSON.stringify({ ...review, wrongProduction: true }));
  assert.equal(decide('nydailynews--chris-jones.json').included, true);
});

test('cross-outlet flag excludes a copy, and clearing it flips inclusion', t => {
  const d = { ...review, crossOutletDuplicate: true, crossOutletPrimaryFile: 'primary.json' };
  const decide = fixture(t, { 'a.json': d, 'primary.json': review });
  assert.equal(decide('a.json').included, false);
  assert.equal(decide('a.json', { ...d, crossOutletDuplicate: false }).included, true);
});

test('mutual cross-outlet pair keeps exactly one review', t => {
  const decide = fixture(t, {
    'a.json': { ...review, crossOutletDuplicate: true, crossOutletPrimaryFile: `${show.id}/b.json` },
    'b.json': { ...review, crossOutletDuplicate: true, crossOutletPrimaryFile: `${show.id}/a.json` },
  });
  assert.equal(decide('a.json').included, true);
  assert.equal(decide('b.json').included, false);
});

test('ensemble rejection already replays and clearing rejectedBy flips inclusion', t => {
  const d = { ...review, rejectedBy: ['model-a', 'model-b'] };
  const decide = fixture(t, { 'a.json': d });
  assert.equal(decide('a.json').reason, 'rejectedByMultipleModels');
  assert.equal(decide('a.json', { ...d, rejectedBy: [] }).included, true);
  assert.equal(decide('a.json', { ...d, rejectedBy: ['model-a'] }).included, true);
});

test('dedup inputs and existing ensemble inputs trigger data replay', () => {
  for (const field of ['duplicateOf', 'duplicateTextOf', 'duplicateOfFlagInheritanceCleared', 'fullText', 'criticName', 'outletId', 'outlet', 'publishDate', 'isSyndicatedDuplicate', 'crossOutletDuplicate', 'crossOutletPrimaryFile', 'rejectedBy', 'rejectedAt', 'rejectionReason']) {
    assert.ok(FLAG_FIELDS.has(field), `missing ${field}`);
  }
});

test('baseline sibling snapshot exposes a flip on an unchanged circular survivor', t => {
  const a = { ...review, duplicateOf: 'b.json' };
  const b = { ...review, duplicateOf: 'a.json' };
  const decide = fixture(t, { 'a.json': a, 'b.json': b });
  const oldDir = createBaselineShowSnapshot(decide.dir, new Map([
    [`${show.id}/b.json`, { old: { ...b, wrongProduction: true }, new: b }],
  ]), path.join(path.dirname(decide.dir), 'old'));
  assert.equal(decideInclusion(a, show, guards, path.join(oldDir, 'a.json')).included, false);
  assert.equal(decide('a.json').included, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(decide.dir, 'b.json'))).wrongProduction, undefined);
});

test('baseline snapshot restores deleted files and omits newly added primaries', t => {
  const secondary = { ...review, criticName: 'Chris Jones', outletId: 'nydailynews' };
  const primary = { ...review, criticName: 'Chris Jones', outletId: 'chicagotribune' };
  const decide = fixture(t, {
    'nydailynews--chris-jones.json': secondary,
    'chicagotribune--chris-jones.json': primary,
  });
  const oldDir = createBaselineShowSnapshot(decide.dir, new Map([
    [`${show.id}/chicagotribune--chris-jones.json`, { old: null, new: primary }],
    [`${show.id}/deleted.json`, { old: review, new: null }],
  ]), path.join(path.dirname(decide.dir), 'old'));
  assert.equal(fs.existsSync(path.join(oldDir, 'deleted.json')), true);
  assert.equal(fs.existsSync(path.join(oldDir, 'chicagotribune--chris-jones.json')), false);
  assert.equal(decideInclusion(secondary, show, guards, path.join(oldDir, 'nydailynews--chris-jones.json')).included, true);
  assert.equal(decide('nydailynews--chris-jones.json').included, false);
});

test('unchanged cross-outlet loser flips when its partner exclusion clears', t => {
  const a = { ...review, crossOutletDuplicate: true, crossOutletPrimaryFile: 'b.json' };
  const b = { ...review, crossOutletDuplicate: true, crossOutletPrimaryFile: 'a.json' };
  const decide = fixture(t, { 'a.json': a, 'b.json': b });
  const oldDir = createBaselineShowSnapshot(decide.dir, new Map([
    [`${show.id}/a.json`, { old: { ...a, isNonReview: true }, new: a }],
  ]), path.join(path.dirname(decide.dir), 'old'));
  assert.equal(decideInclusion(b, show, guards, path.join(oldDir, 'b.json')).included, true);
  assert.equal(decide('b.json').included, false);
});

test('dedup identity includes transitive predicates and constants', t => {
  const { dir } = fixture(t, {});
  for (const name of ['duplicate-of-exclusion', 'cross-outlet-cycle', 'syndication-pairs', 'review-normalization']) {
    fs.writeFileSync(path.join(dir, `${name}.js`), 'module.exports = {};');
  }
  fs.writeFileSync(path.join(dir, 'review-guards.js'), "module.exports = require('./predicate');");
  const predicatePath = path.join(dir, 'predicate.js');
  fs.writeFileSync(predicatePath, 'const threshold = 2; module.exports = () => threshold;');
  const before = loadDedupGuards(dir).__dedupFingerprint;
  fs.writeFileSync(predicatePath, 'const threshold = 3; module.exports = () => threshold;');
  assert.notEqual(loadDedupGuards(dir).__dedupFingerprint, before);
});

test('baseline snapshot recovers the last file of a deleted show directory', t => {
  const { dir } = fixture(t, {});
  fs.rmdirSync(dir);
  const oldDir = createBaselineShowSnapshot(dir, new Map([
    [`${show.id}/deleted.json`, { old: review, new: null }],
  ]), path.join(path.dirname(dir), 'old'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(oldDir, 'deleted.json'))), review);
});
