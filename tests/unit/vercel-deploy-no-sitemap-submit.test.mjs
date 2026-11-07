/**
 * BRO-4602: the deploy must not call the Search Console sitemap API (403 on every
 * shard: the service account has no access to the property; robots.txt lists shards).
 * Run: node --test tests/unit/vercel-deploy-no-sitemap-submit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml = readFileSync(new URL('../../.github/workflows/vercel-deploy.yml', import.meta.url), 'utf8');

test('vercel-deploy.yml does not run submit-google-indexing.js --submit-sitemap', () => {
  assert.ok(!/submit-google-indexing\.js\s+--submit-sitemap/.test(yml));
});

test('vercel-deploy.yml still pings Bing for the sitemap', () => {
  assert.ok(yml.includes('bing.com/ping?sitemap='));
});
