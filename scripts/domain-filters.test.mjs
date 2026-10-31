// BRO-5273: a tumblr.com subdomain a registry outlet declares as its own site
// (Dan Dwyer's dandwyeroffscript.tumblr.com, off-script-with-dan-dwyer) is not
// a blocked review URL; every other tumblr host still is. The real gate is
// rebuild-all-reviews.js's skippedBlockedUrl check; explainExclusion mirrors it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  isBlockedReviewUrl,
  isBlockedReviewRecord,
  isSocialMediaUrl,
  isRegistryDeclaredBlogSubdomain,
  declaredHostsFromRegistry,
  getRegistryDeclaredHosts,
} = require('./lib/domain-filters.js');
const { explainExclusion } = require('./lib/review-guards.js');

const DWYER = 'https://dandwyeroffscript.tumblr.com/post/148601767421/cats';
const OTHER = 'https://random-other.tumblr.com/post/1/cats';
const BARE = 'https://tumblr.com/post/1/cats';
const WWW = 'https://www.tumblr.com/dandwyeroffscript/148601767421/cats';

test('registry declares dandwyeroffscript.tumblr.com under off-script-with-dan-dwyer', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'outlet-registry.json'), 'utf8'));
  const outlet = registry.outlets['off-script-with-dan-dwyer'];
  assert.ok(outlet, 'outlet exists');
  assert.ok((outlet.domainAliases || []).includes('dandwyeroffscript.tumblr.com'));
  assert.ok(getRegistryDeclaredHosts().has('dandwyeroffscript.tumblr.com'));
});

test('declared tumblr subdomain is not blocked; other tumblr hosts are', () => {
  assert.equal(isBlockedReviewUrl(DWYER), false);
  assert.equal(isBlockedReviewUrl(DWYER.replace('https://', 'http://')), false);
  assert.equal(isSocialMediaUrl(DWYER), false);
  assert.equal(isBlockedReviewUrl(OTHER), true);
  assert.equal(isBlockedReviewUrl(BARE), true);
  assert.equal(isBlockedReviewUrl(WWW), true);
  assert.equal(isSocialMediaUrl(OTHER), true);
});

test('exemption needs the registry declaration, and only covers per-user blog platforms', () => {
  const empty = new Set();
  assert.equal(isBlockedReviewUrl(DWYER, { declaredHosts: empty }), true);
  const declared = declaredHostsFromRegistry({ outlets: {
    a: { domain: 'x.com', domainAliases: ['Someone.Tumblr.com', 'tumblr.com', 'facebook.com'] },
    b: { domain: 'www.other.tumblr.com' },
  } });
  assert.equal(isRegistryDeclaredBlogSubdomain('someone.tumblr.com', declared), true);
  assert.equal(isRegistryDeclaredBlogSubdomain('other.tumblr.com', declared), true);
  // the bare platform and non-blog social hosts never get exempted, even if declared
  assert.equal(isBlockedReviewUrl('https://tumblr.com/p/1', { declaredHosts: declared }), true);
  assert.equal(isBlockedReviewUrl('https://facebook.com/p/1', { declaredHosts: declared }), true);
  assert.equal(isBlockedReviewUrl('https://x.com/p/1', { declaredHosts: declared }), true);
  // an Array.filter index as 2nd arg is ignored, not mistaken for options
  assert.deepEqual([DWYER, OTHER].filter(isBlockedReviewUrl), [OTHER]);
});

test('other block rules still apply on a declared host', () => {
  assert.equal(isBlockedReviewUrl('https://dandwyeroffscript.tumblr.com/interview/foo'), true);
});

test('rebuild inclusion and explainExclusion share the exemption', () => {
  const rec = (url) => ({ outletId: 'off-script-with-dan-dwyer', url });
  assert.equal(isBlockedReviewRecord(rec(DWYER)), false);
  assert.equal(isBlockedReviewRecord(rec(OTHER)), true);
  assert.equal(isBlockedReviewRecord({}), false);
  assert.notEqual(explainExclusion(rec(DWYER), null, null), 'blockedReviewUrl');
  assert.equal(explainExclusion(rec(OTHER), null, null), 'blockedReviewUrl');

  // rebuild-all-reviews.js's real gate must call the same predicate, not a copy.
  const src = fs.readFileSync(path.join(here, 'rebuild-all-reviews.js'), 'utf8');
  const gate = src.match(/if \(([^)]*\([^)]*\))\) \{\s*logExclusion\("skippedBlockedUrl"/);
  assert.ok(gate, 'skippedBlockedUrl gate found');
  assert.equal(gate[1], 'isBlockedReviewRecord(data)');
  assert.match(src, /const \{ isBlockedReviewRecord \} = require\('\.\/lib\/domain-filters'\)/);
});
