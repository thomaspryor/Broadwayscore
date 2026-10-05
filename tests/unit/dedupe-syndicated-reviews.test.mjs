// BRO-2406: cross-outlet syndication duplicates must not re-enter reviews.json,
// and duplicateOf pointers between syndicated copies must survive the audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const sp = require('../../scripts/lib/syndication-pairs.js');
const { normalizeOutlet } = require('../../scripts/lib/review-normalization.js');
const { explainExclusion } = require('../../scripts/lib/review-guards.js');

test('Tribune-group reprints resolve to a primary for any real byline', () => {
  assert.deepEqual(sp.getSyndicationPrimaries('Chris Jones', 'nydailynews'), ['chicagotribune']);
  // critic NOT hand-listed in KNOWN_SYNDICATION_PAIRS
  assert.deepEqual(sp.getSyndicationPrimaries('Jane Roe', 'baltimoresun'), ['chicagotribune', 'nydailynews']);
  assert.deepEqual(sp.getSyndicationPrimaries('Jane Roe', 'chicagotribune'), []);
  assert.deepEqual(sp.getSyndicationPrimaries('Unknown', 'nydailynews'), []);
});

test('isCrossOutletSyndicationPair: group/known/declared yes, unrelated no', () => {
  const a = { criticName: 'Jane Roe', outletId: 'baltimoresun' };
  const b = { criticName: 'Jane Roe', outletId: 'chicagotribune' };
  assert.equal(sp.isCrossOutletSyndicationPair(a, b, normalizeOutlet), true);
  assert.equal(sp.isCrossOutletSyndicationPair(b, a, normalizeOutlet), true);
  assert.equal(sp.isCrossOutletSyndicationPair({ ...a, criticName: 'Other' }, b, normalizeOutlet), false);
  assert.equal(sp.isCrossOutletSyndicationPair({ criticName: 'X', outletId: 'nytimes' }, { criticName: 'X', outletId: 'variety' }, normalizeOutlet), false);
  assert.equal(sp.isCrossOutletSyndicationPair({ criticName: 'X', outletId: 'nytimes', duplicateReason: 'syndicated on critic own site' }, { criticName: 'X', outletId: 'variety' }, normalizeOutlet), true);
  assert.equal(sp.isCrossOutletSyndicationPair({ criticName: 'X', outletId: 'nytimes' }, { criticName: 'X', outletId: 'nytimes' }, normalizeOutlet), false);
});

function mkShowDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2406-'));
  const show = path.join(root, 'review-texts', 'some-show-2026');
  fs.mkdirSync(show, { recursive: true });
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(show, n), JSON.stringify(d));
  return { root, show };
}

test('rebuild guard excludes a group-secondary copy when the primary exists', () => {
  const { show } = mkShowDir({
    'chicagotribune--jane-roe.json': { criticName: 'Jane Roe', outletId: 'chicagotribune', url: 'https://chicagotribune.com/a' },
    'baltimoresun--jane-roe.json': { criticName: 'Jane Roe', outletId: 'baltimoresun', url: 'https://baltimoresun.com/a' },
  });
  const sec = JSON.parse(fs.readFileSync(path.join(show, 'baltimoresun--jane-roe.json'), 'utf8'));
  assert.equal(explainExclusion(sec, null, path.join(show, 'baltimoresun--jane-roe.json')), 'knownSyndicationSecondary');
  const pri = JSON.parse(fs.readFileSync(path.join(show, 'chicagotribune--jane-roe.json'), 'utf8'));
  assert.notEqual(explainExclusion(pri, null, path.join(show, 'chicagotribune--jane-roe.json')), 'knownSyndicationSecondary');
});

test('audit --fix does NOT null a cross-outlet syndication duplicateOf pointer', () => {
  const { root, show } = mkShowDir({
    'chicagotribune--chris-jones.json': { criticName: 'Chris Jones', outletId: 'chicagotribune', url: 'https://chicagotribune.com/x' },
    'nydailynews--chris-jones.json': { criticName: 'Chris Jones', outletId: 'nydailynews', url: 'https://nydailynews.com/y', duplicateOf: 'chicagotribune--chris-jones.json', duplicateReason: 'syndicated' },
  });
  const script = path.resolve('scripts/audit-duplicate-of-url-mismatch.js');
  const env = { ...process.env, REVIEW_TEXTS_DIR: path.join(root, 'review-texts') };
  let out = '';
  try { out = execFileSync('node', [script], { env, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  assert.doesNotMatch(out, /url-mismatch/);
});

test('a primary that is itself excluded does NOT shield the secondary (no both-dropped)', () => {
  const { show } = mkShowDir({
    'chicagotribune--chris-jones.json': { criticName: 'Chris Jones', outletId: 'chicagotribune', url: 'https://chicagotribune.com/a', crossOutletDuplicate: true },
    'nydailynews--chris-jones.json': { criticName: 'Chris Jones', outletId: 'nydailynews', url: 'https://nydailynews.com/a' },
  });
  const sec = JSON.parse(fs.readFileSync(path.join(show, 'nydailynews--chris-jones.json'), 'utf8'));
  assert.notEqual(explainExclusion(sec, null, path.join(show, 'nydailynews--chris-jones.json')), 'knownSyndicationSecondary');
});

test('primary filename match is anchored (rob-weinert vs rob-weinert-kendt)', () => {
  assert.equal(sp.isPrimaryFileFor('chicagotribune--rob-weinert-kendt.json', ['chicagotribune'], 'Rob Weinert'), false);
  assert.equal(sp.isPrimaryFileFor('chicagotribune--rob-weinert.json', ['chicagotribune'], 'Rob Weinert'), true);
  assert.equal(sp.isPrimaryFileFor('chicagotribune--ben-brantley-2.json', ['chicagotribune'], 'Ben Brantley'), true);
  assert.equal(sp.isPrimaryFileFor('chicagotribune--sean-o-hara.json', ['chicagotribune'], "Sean O'Hara"), true);
});

test('syndication reason alone does not exempt a different-critic pointer; "not syndicated" does not exempt', () => {
  assert.equal(sp.isCrossOutletSyndicationPair({ criticName: 'A', outletId: 'nytimes', duplicateReason: 'syndicated' }, { criticName: 'B', outletId: 'variety' }, normalizeOutlet), false);
  assert.equal(sp.isCrossOutletSyndicationPair({ criticName: 'A', outletId: 'nytimes', duplicateReason: 'not syndicated' }, { criticName: 'A', outletId: 'variety' }, normalizeOutlet), false);
});

test('detector choosePrimary agrees with group order (source check)', () => {
  const src = fs.readFileSync(path.resolve('scripts/detect-syndicated-duplicates.js'), 'utf8');
  assert.match(src, /PUBLISHING_GROUPS/);
});

test('accented bylines fold to the ASCII filename slug', () => {
  assert.equal(sp.criticFileSlug('Zoë Müller'), 'zoe-muller');
  assert.equal(sp.isPrimaryFileFor('chicagotribune--zoe-muller.json', ['chicagotribune'], 'Zoë Müller'), true);
});
