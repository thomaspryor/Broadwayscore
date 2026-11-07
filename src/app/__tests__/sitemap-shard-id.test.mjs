/**
 * BRO-6114: Next 16 calls the sitemap handler with `id` as a Promise<string>
 * (next-metadata-route-loader: `handler({ id: targetIdPromise })`). The handler
 * indexed SITEMAP_SHARDS with the Promise itself, so every /sitemap/N.xml 404'd
 * in production after the Next 15 -> 16 upgrade. Call it the way Next does.
 *
 * Run: npx tsx --test src/app/__tests__/sitemap-shard-id.test.mjs
 */
import { register } from 'node:module';
register('../api/__tests__/next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// sitemap.ts imports these gitignored manifests (built by prebuild.sh). The
// Unit Tests job does not build them, so build them here (sub-second each).
for (const [file, script] of [['data/actor-slugs.json', 'scripts/build-actor-slugs-manifest.js'], ['data/cast-manifest.json', 'scripts/build-cast-manifest.js']]) {
  if (!existsSync(file)) execFileSync(process.execPath, [script], { stdio: 'ignore' });
}

const { default: sitemap, generateSitemaps } = await import('../sitemap.ts');
const { SITEMAP_SHARDS } = await import('../../config/sitemap-shards.ts');

test('generateSitemaps lists one id per shard', () => {
  assert.deepEqual(generateSitemaps().map((s) => String(s.id)), SITEMAP_SHARDS.map((_, i) => String(i)));
});

test('a Promise<string> shard id (Next 16 contract) builds that shard', async () => {
  const opera = SITEMAP_SHARDS.findIndex((s) => s.name === 'opera');
  const entries = await sitemap({ id: Promise.resolve(String(opera)) });
  assert.ok(entries.length > 0, 'opera shard should not be empty');
  assert.ok(entries.every((e) => typeof e.url === 'string' && e.url.startsWith('http')));
});

test('the core shard carries /biz (smoke.spec.ts asserts it on prod)', async () => {
  const core = SITEMAP_SHARDS.findIndex((s) => s.name === 'core');
  const entries = await sitemap({ id: Promise.resolve(String(core)) });
  assert.ok(entries.some((e) => e.url.endsWith('/biz')), 'core shard should list /biz');
});

for (const bad of [String(SITEMAP_SHARDS.length), 'abc', '-1', '1.5']) {
  test(`unknown shard id ${JSON.stringify(bad)} 404s`, async () => {
    await assert.rejects(sitemap({ id: Promise.resolve(bad) }), (err) => /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(String(err?.digest ?? err?.message)));
  });
}
