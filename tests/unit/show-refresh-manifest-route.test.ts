/**
 * BRO-8214: /api/show-refresh/manifest serves the build manifest statically,
 * and { usable: false } (200) when it is missing or invalid. server-only and
 * next/cache are stubbed; no Next runtime.
 *
 * Run: npx tsx --test tests/unit/show-refresh-manifest-route.test.ts
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const origLoad = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: unknown[]) {
  if (req === 'server-only') return {};
  if (req === 'next/cache') return { unstable_cache: (fn: unknown) => fn, revalidateTag: () => {}, revalidatePath: () => {} };
  return origLoad.call(this, req, ...rest);
};
const { buildManifest: buildManifestLib, invalidManifest } = require('../../scripts/lib/show-refresh/manifest');

const ROUTE = path.join(__dirname, '..', '..', 'src', 'app', 'api', 'show-refresh', 'manifest', 'route.ts');
const LIB = path.join(__dirname, '..', '..', 'src', 'lib', 'show-refresh.ts');

const tmpDirs: string[] = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Load the route fresh (buildManifest memoizes per module instance) with cwd at a temp repo. */
async function getWith(manifest: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-route-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'data'));
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, 'data', 'show-refresh-manifest.json'), JSON.stringify(manifest));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const k of Object.keys(require.cache)) if (k === ROUTE || k === LIB) delete require.cache[k];
    const route = require(ROUTE);
    assert.equal(route.dynamic, 'force-static');
    const res: Response = route.GET();
    return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
  } finally {
    process.chdir(cwd);
  }
}

const good = buildManifestLib({
  manifestId: 'm1', buildInstant: Date.UTC(2026, 10, 24), registryFile: { outlets: {} }, dataFiles: { 'shows.json': '{}' },
  imageKeys: [], shows: [{ id: 's1', slug: 's1' }], sliceHashById: new Map([['s1', 'a'.repeat(16)]]), heldById: new Map([['s1', false]]),
});

test('serves a usable manifest as JSON', async () => {
  const r = await getWith(good);
  assert.equal(r.status, 200);
  assert.match(String(r.type), /application\/json/);
  assert.deepEqual(r.body, good);
});

test('missing or invalid manifest => { usable: false } with 200', async () => {
  for (const m of [undefined, invalidManifest(['x']), { schema: 99, manifestId: 'x', buildInstant: 1, shows: {} }]) {
    const r = await getWith(m);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { usable: false });
  }
});
