/**
 * Every @vercel/og image must load Inter (src/lib/og-fonts.ts). Without a
 * `fonts` option @vercel/og silently renders in its bundled Noto Sans: the
 * newsletter badge changed typeface that way (2026-09-20) and so did the
 * Shared Plans preview card (owner, 2026-10-02).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadInter } from '../../src/lib/og-fonts';

const ROOT = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

test('every file that builds an ImageResponse loads Inter via src/lib/og-fonts', () => {
  const offenders: string[] = [];
  const users: string[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf-8');
    if (!src.includes('new ImageResponse(')) continue;
    users.push(relative(ROOT, file));
    if (!/from '@\/lib\/og-fonts'/.test(src) || !/interFontOption\(/.test(src)) offenders.push(relative(ROOT, file));
  }
  assert.ok(users.length >= 4, `expected the known OG generators, found ${users.join(', ')}`);
  assert.deepEqual(offenders, [], `ImageResponse without Inter: ${offenders.join(', ')}`);
});

test('loadInter caches a complete load and retries after a partial one', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  let failFirst = true;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls++;
    if (failFirst && String(url).includes('-800-')) return new Response(null, { status: 503 });
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  try {
    const partial = await loadInter([700, 800]);
    assert.equal(partial.length, 1, 'partial load returned');
    failFirst = false;
    const full = await loadInter([700, 800]);
    assert.equal(full.length, 2, 'retried after the partial load');
    const before = calls;
    await loadInter([800, 700]);
    assert.equal(calls, before, 'complete load is cached (order-insensitive key)');
  } finally {
    globalThis.fetch = realFetch;
  }
});
