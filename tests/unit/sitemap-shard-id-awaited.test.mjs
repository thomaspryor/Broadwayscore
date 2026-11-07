// BRO-6458: Next 16 passes the sitemap shard id as a Promise<string>. The default export must
// await it before indexing SITEMAP_SHARDS, or every /sitemap/N.xml 404s and the post-deploy smoke
// test (and Vercel deploy workflow) fails. Source-level guard: sitemap.ts is TS and not importable here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../src/app/sitemap.ts', import.meta.url), 'utf8');

test('sitemap default export awaits the shard id', () => {
  assert.match(src, /Number\(await \w+\.id\)/, 'must resolve `await props.id` before use');
  assert.doesNotMatch(src, /SITEMAP_SHARDS\[id\]\s*;/, 'must not index shards with an unvalidated id');
});

test('sitemap default export does not destructure a raw numeric id', () => {
  assert.doesNotMatch(src, /export default async function sitemap\(\{\s*id\s*\}\s*:\s*\{\s*id:\s*number/);
});
