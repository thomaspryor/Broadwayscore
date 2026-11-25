import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planTbDatedCollisionRepairs, applyTbDatedCollisionRepairs } = require('./tb-dated-collision.js');
const B = 'https://www.talkinbroadway.com/page/ob/';
const shows = [
  { id: 'falls-for-jodie', title: 'Falls for Jodie', openingDate: '2026-10-05' }, { id: 'hairy-ape', title: 'The Hairy Ape', openingDate: '2026-10-05' },
  { id: 'hairy-ape-2022', title: 'The Hairy Ape', openingDate: '2022-04-11' },
  { id: 'bach-orig', title: 'Going Bacharach', openingDate: '2026-01-12' }, { id: 'bach-return', title: 'Going Bacharach', openingDate: '2026-09-16' },
];
const index = [
  { url: `${B}10_05_26.html`, title: 'The Hairy Ape' }, { url: `${B}10_05_26b.html`, title: 'Falls for Jodie' },
  { url: `${B}01_12_26.html`, title: 'Going Bacharach' },
];

test('the show the index lists at the b page is moved off the bare page; the owner is untouched', () => {
  const files = [
    { showId: 'hairy-ape', file: 'talkinbroadway--a.json', url: `${B}10_05_26.html` },
    { showId: 'falls-for-jodie', file: 'talkinbroadway--b.json', url: `${B}10_05_26.html` },
  ];
  const { repairs, unresolved } = planTbDatedCollisionRepairs(index, files, shows);
  assert.equal(unresolved.length, 0);
  assert.deepEqual(repairs.map((r) => [r.showId, r.from, r.to]), [['falls-for-jodie', `${B}10_05_26.html`, `${B}10_05_26b.html`]]);
});

test('flagged files, same-title productions and unindexed pages are never repaired', () => {
  const flagged = [
    { showId: 'hairy-ape', file: 'a.json', url: `${B}10_05_26.html` },
    { showId: 'falls-for-jodie', file: 'b.json', url: `${B}10_05_26.html`, flagged: true },
  ];
  assert.equal(planTbDatedCollisionRepairs(index, flagged, shows).repairs.length, 0);
  const twin = [
    { showId: 'bach-orig', file: 'a.json', url: `${B}01_12_26.html` },
    { showId: 'bach-return', file: 'b.json', url: `${B}01_12_26.html` },
  ];
  const r = planTbDatedCollisionRepairs(index, twin, shows);
  assert.equal(r.repairs.length, 0);
  assert.equal(r.unresolved.length, 1);
  const unlisted = [
    { showId: 'hairy-ape', file: 'a.json', url: `${B}10_06_26.html` },
    { showId: 'falls-for-jodie', file: 'b.json', url: `${B}10_06_26.html` },
  ];
  assert.equal(planTbDatedCollisionRepairs(index, unlisted, shows).repairs.length, 0);
});

test('apply hands each repair to the review-field-edit path as a url edit', () => {
  const calls = [];
  const out = applyTbDatedCollisionRepairs('/x', [{ showId: 's', file: 'f.json', from: 'a', to: 'b', evidence: 'e' }],
    { executeIn: (dir, action) => { calls.push(action); return { ok: true, msg: 'done' }; } });
  assert.deepEqual([calls[0].file, calls[0].field, calls[0].oldValue, calls[0].newValue], ['s/f.json', 'url', 'a', 'b']);
  assert.equal(out[0].ok, true);
});

test('loadTbReviewFiles reads real files and marks flagged ones', async (t) => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const { makeTmpDir } = require('./tmpdir-for-tests.js');
  const { loadTbReviewFiles } = require('./tb-dated-collision.js');
  const dir = makeTmpDir(t, 'tbc-');
  fs.mkdirSync(path.join(dir, 's1'));
  fs.writeFileSync(path.join(dir, 's1', 'talkinbroadway--a.json'), JSON.stringify({ url: `${B}10_05_26.html` }));
  fs.writeFileSync(path.join(dir, 's1', 'talkinbroadway--b.json'), JSON.stringify({ url: `${B}10_05_26.html`, wrongShow: true }));
  const got = loadTbReviewFiles(dir).map((f) => [f.file, f.flagged]).sort();
  assert.deepEqual(got, [['talkinbroadway--a.json', false], ['talkinbroadway--b.json', true]]);
});

test('throwing executor, a reused title in another year, several files and a held destination', () => {
  const out = applyTbDatedCollisionRepairs('/x', [{ showId: 's', file: 'f.json', from: 'a', to: 'b', evidence: 'e' }], { executeIn: () => { throw new Error('bad json'); } });
  assert.equal(out[0].ok, false);
  // the 2022 Hairy Ape does not make the 2026 one ambiguous
  const files = [
    { showId: 'hairy-ape', file: 'a.json', url: `${B}10_05_26.html` },
    { showId: 'falls-for-jodie', file: 'b.json', url: `${B}10_05_26.html` },
  ];
  assert.equal(planTbDatedCollisionRepairs(index, files, shows).repairs.length, 1);
  // an old production holding the bare page is not moved onto the new show's review
  const old = [
    { showId: 'hairy-ape-2022', file: 'a.json', url: `${B}10_05_26.html` },
    { showId: 'falls-for-jodie', file: 'b.json', url: `${B}10_05_26.html` },
  ];
  assert.equal(planTbDatedCollisionRepairs(index, old, shows).repairs.length, 0);
  const two = [...files, { showId: 'falls-for-jodie', file: 'c.json', url: `${B}10_05_26.html` }];
  assert.equal(planTbDatedCollisionRepairs(index, two, shows).repairs.length, 0);
  const held = [...files, { showId: 'hairy-ape', file: 'd.json', url: `${B}10_05_26b.html` }];
  assert.equal(planTbDatedCollisionRepairs(index, held, shows).repairs.length, 0);
});

test('end to end: load files from disk, plan, and the real review-field-edit executor rewrites the url on disk', async (t) => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const { makeTmpDir } = require('./tmpdir-for-tests.js');
  const { loadTbReviewFiles } = require('./tb-dated-collision.js');
  const dir = makeTmpDir(t, 'tbc-e2e-');
  const put = (show, file, rec) => { fs.mkdirSync(path.join(dir, show), { recursive: true }); fs.writeFileSync(path.join(dir, show, file), JSON.stringify(rec, null, 2)); };
  const rec = (url) => ({ showId: 'x', outletId: 'talkinbroadway', criticName: 'Frank Scheck', url, fullText: 'a review '.repeat(40), publishDate: '2026-10-05' });
  put('hairy-ape', 'talkinbroadway--frank-scheck.json', { ...rec(`${B}10_05_26.html`), showId: 'hairy-ape' });
  put('falls-for-jodie', 'talkinbroadway--frank-scheck.json', { ...rec(`${B}10_05_26.html`), showId: 'falls-for-jodie' });
  const files = loadTbReviewFiles(dir);
  const { repairs } = planTbDatedCollisionRepairs(index, files, shows);
  assert.equal(repairs.length, 1);
  const out = applyTbDatedCollisionRepairs(dir, repairs, { fixId: 'test-e2e' });
  assert.equal(out[0].ok, true, out[0].msg);
  const moved = JSON.parse(fs.readFileSync(path.join(dir, 'falls-for-jodie', 'talkinbroadway--frank-scheck.json'), 'utf8'));
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'hairy-ape', 'talkinbroadway--frank-scheck.json'), 'utf8'));
  assert.equal(moved.url, `${B}10_05_26b.html`);
  assert.equal(kept.url, `${B}10_05_26.html`);
});

test('opening-date window: 29 days before the page date is eligible, 31 days is not', () => {
  const mk = (open) => [
    { id: 'owner', title: 'Owner Show', openingDate: '2026-10-05' },
    { id: 'mover', title: 'Mover Show', openingDate: open },
  ];
  const idx = [{ url: `${B}10_05_26.html`, title: 'Owner Show' }, { url: `${B}10_05_26b.html`, title: 'Mover Show' }];
  const files = [
    { showId: 'owner', file: 'a.json', url: `${B}10_05_26.html` },
    { showId: 'mover', file: 'b.json', url: `${B}10_05_26.html` },
  ];
  assert.equal(planTbDatedCollisionRepairs(idx, files, mk('2026-09-06')).repairs.length, 1);
  assert.equal(planTbDatedCollisionRepairs(idx, files, mk('2026-09-04')).repairs.length, 0);
});
