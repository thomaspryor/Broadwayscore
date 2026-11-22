// Tests for scripts/lib/show-refresh/manifest.js (BRO-8056 phase 1b). Requires the real module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { buildManifest, verifyManifest, gitBlobSha, registrySha, MANIFEST_SCHEMA } = require('./manifest.js');

const base = () => ({
  manifestId: 'm1',
  buildInstant: Date.UTC(2026, 10, 22, 2, 0),
  coreSha: 'c'.repeat(40),
  publicSha: 'p'.repeat(40),
  registryFile: { _meta: { lastUpdated: 'x' }, outlets: { nyt: { tier: 1 } } },
  dataFiles: { 'shows.json': '{"a":1}', 'reviews.json': '[]' },
  imageKeys: ['b', 'a'],
  shows: [{ id: 's1', slug: 'show-one', images: { hero: '/h.webp' } }],
  sliceHashById: new Map([['s1', 'abc']]),
  heldById: new Map([['s1', true]]),
});

test('gitBlobSha matches git hash-object', () => {
  const content = 'hello\n';
  const want = execFileSync('git', ['hash-object', '--stdin'], { input: content }).toString().trim();
  assert.equal(gitBlobSha(content), want);
});

test('registrySha ignores _meta churn', () => {
  assert.equal(registrySha({ _meta: { a: 1 }, outlets: { x: 1 } }), registrySha({ _meta: { a: 2 }, outlets: { x: 1 } }));
  assert.notEqual(registrySha({ outlets: { x: 1 } }), registrySha({ outlets: { x: 2 } }));
});

test('builds the manifest from injected inputs only', () => {
  const m = buildManifest(base());
  assert.equal(m.schema, MANIFEST_SCHEMA);
  assert.equal(m.buildDate, '2026-11-22');
  assert.deepEqual(Object.keys(m.dataShas), ['reviews.json', 'shows.json']);
  assert.deepEqual(m.shows.s1, { slug: 'show-one', hash: 'abc', held: true, imagesSig: m.shows.s1.imagesSig });
  assert.equal(m.showCount, 1);
  const b = base(); b.imageKeys = ['a', 'b'];
  assert.equal(buildManifest(b).imageKeysSha, m.imageKeysSha, 'image key order does not matter');
});

test('refuses a prerendered show with no slice hash or held verdict', () => {
  const a = base(); a.sliceHashById = new Map();
  assert.throws(() => buildManifest(a), /no slice hash/);
  const b = base(); b.heldById = new Map();
  assert.throws(() => buildManifest(b), /no held verdict/);
  const c = base(); delete c.buildInstant;
  assert.throws(() => buildManifest(c), /buildInstant/);
});

test('verifyManifest flags data that changed mid-build and a wrong HEAD', () => {
  const m = buildManifest(base());
  assert.deepEqual(verifyManifest(m, { dataFiles: base().dataFiles, publicSha: 'p'.repeat(40) }), []);
  const probs = verifyManifest(m, { dataFiles: { 'shows.json': '{"a":2}' }, publicSha: 'q'.repeat(40) });
  assert.equal(probs.length, 3, probs.join('; '));
});

test('an optional input that appears mid-build fails verification', () => {
  const a = base(); a.absentFiles = ['audit/show-review-gap.json'];
  const m = buildManifest(a);
  assert.deepEqual(m.absentFiles, ['audit/show-review-gap.json']);
  assert.deepEqual(verifyManifest(m, { dataFiles: base().dataFiles, publicSha: 'p'.repeat(40) }), []);
  const probs = verifyManifest(m, { dataFiles: { ...base().dataFiles, 'audit/show-review-gap.json': '{}' }, publicSha: 'p'.repeat(40) });
  assert.equal(probs.length, 1, probs.join('; '));
  assert.match(probs[0], /appeared/);
});

test('an invalid marker is never a usable manifest', () => {
  const { isUsableManifest, invalidManifest } = require('./manifest.js');
  assert.equal(isUsableManifest(buildManifest(base())), true);
  const bad = invalidManifest(['x']);
  assert.equal(isUsableManifest(bad), false);
  assert.equal(verifyManifest(bad, { dataFiles: {}, publicSha: null }).length, 1);
});
