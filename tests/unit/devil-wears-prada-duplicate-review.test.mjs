import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executeReviewFieldEditIn } = require('../../scripts/lib/review-field-edit.js');
const { safeWriteReview, _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');
const { explainExclusion } = require('../../scripts/lib/review-guards.js');
const plan = require('../../data/pending-fixes/bro-4233.json');
const baseline = require('../../data/audit/same-url-duplicate-baseline.json');
const showId = 'the-devil-wears-prada-west-end-2024';
const canonical = 'whatsonstage--miriam-sallon.json';
const duplicate = 'whatsonstage--sarah-crompton.json';
const url = 'https://www.whatsonstage.com/news/the-devil-wears-prada-musical-review-couture-or-off-the-rack_1656396/';
const show = { id: showId, title: 'The Devil Wears Prada', category: 'west-end', openingDate: '2024-12-01' };
const stamp = { fixId: plan.planId, at: '2026-10-13T00:00:00.000Z' };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4233-'));
  _setShowsCacheForTest(new Map([[showId, show]]));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); _setShowsCacheForTest(null); });
  fs.mkdirSync(path.join(dir, showId));
  const common = { showId, outletId: 'whatsonstage', url, publishDate: '2024-12-06', originalScore: '2/5 stars' };
  // Metadata from the partial BRO-4898 fix, with synthetic bodies only.
  fs.writeFileSync(path.join(dir, showId, canonical), JSON.stringify({
    ...common, criticName: 'Miriam Sallon', assignedScore: 39,
    fullText: 'The Devil Wears Prada has disappointing creative choices. '.repeat(20),
    duplicateOf: duplicate, duplicateReason: 'url-collision-detected-at-write',
    duplicateClearReason: plan.plan.actions[0].oldValue,
  }));
  fs.writeFileSync(path.join(dir, showId, duplicate), JSON.stringify({
    ...common, criticName: 'Sarah Crompton', assignedScore: 40,
    fullText: 'Cookie consent and privacy preferences. '.repeat(30),
    wrongAttribution: true, _duplicateOfCleared: 'legacy same-URL clear',
  }));
  return { dir, read: (f) => JSON.parse(fs.readFileSync(path.join(dir, showId, f))) };
}

test('BRO-4233 plan applies through the real writer and preserves only the verified byline', (t) => {
  const { dir, read } = fixture(t);
  assert.equal(read(canonical).duplicateOf, duplicate, 'reproduce the stale canonical pointer');
  for (const action of plan.plan.actions) {
    const result = executeReviewFieldEditIn(dir, action, stamp);
    assert.equal(result.ok, true, result.reason);
  }
  assert.equal(read(canonical).duplicateOf, null);
  assert.equal(read(duplicate).duplicateOf, canonical);
  assert.equal(read(duplicate)._duplicateOfCleared, undefined);
  assert.match(read(canonical).duplicateClearReason, /byline verified as Miriam Sallon/);
  assert.equal(read(canonical).assignedScore, 39);
  assert.equal(read(duplicate).assignedScore, 40);
  assert.deepEqual([canonical, duplicate].filter(f => !explainExclusion(read(f), show, f)), [canonical]);
  // Subsequent enrichment must not resurrect the reversed pointer.
  safeWriteReview(path.join(dir, showId, canonical), { ...read(canonical), textWordCount: 180 });
  assert.equal(read(canonical).duplicateOf, null);
});

test('approved clears still refuse changed data and locked records', (t) => {
  const { dir, read } = fixture(t);
  const action = plan.plan.actions.find(a => a.field === 'duplicateOf' && a.newValue === null);
  const stale = executeReviewFieldEditIn(dir, { ...action, oldValue: 'another-critic.json' }, stamp);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /current value doesn't match expected/);
  const file = path.join(dir, showId, canonical);
  fs.writeFileSync(file, JSON.stringify({ ...read(canonical), _locked: true }));
  const locked = executeReviewFieldEditIn(dir, action, stamp);
  assert.equal(locked.ok, false);
  assert.match(locked.reason, /_locked/);
  assert.equal(read(canonical).duplicateOf, duplicate);
});

test('ordinary writes cannot clear an existing pointer using a stale breadcrumb', (t) => {
  const { dir, read } = fixture(t);
  safeWriteReview(path.join(dir, showId, canonical), { ...read(canonical), duplicateOf: null });
  assert.equal(read(canonical).duplicateOf, duplicate);
});

test('approved pointer clears still require a breadcrumb and respect valid URL collisions', (t) => {
  const { dir, read } = fixture(t);
  const action = plan.plan.actions.find(a => a.field === 'duplicateOf' && a.newValue === null);
  const file = path.join(dir, showId, canonical);
  fs.writeFileSync(file, JSON.stringify({ ...read(canonical), duplicateClearReason: null }));
  const missing = executeReviewFieldEditIn(dir, action, stamp);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /needs a duplicateClearReason/);
  fs.writeFileSync(file, JSON.stringify({ ...read(canonical), duplicateClearReason: 'verified clear' }));
  fs.writeFileSync(path.join(dir, showId, duplicate), JSON.stringify({ ...read(duplicate), wrongAttribution: false }));
  const collision = executeReviewFieldEditIn(dir, action, stamp);
  assert.equal(collision.ok, false, 'a live same-URL sibling still prevents a duplicate clear');
  assert.equal(read(canonical).duplicateOf, duplicate);
});

test('BRO-4233 no longer grandfathers the incorrect same-URL pair', () => {
  assert.ok(!baseline.pairs.includes(`${showId}|${url.slice(0, -1)}`));
  assert.ok(plan.plan.actions.every(a => a.file.startsWith(`${showId}/`)));
});
