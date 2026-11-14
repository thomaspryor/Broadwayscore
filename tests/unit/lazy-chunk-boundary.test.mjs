// BRO-7494: every lazily loaded component must render inside a local error
// boundary, so a failed chunk download can't replace the whole page with
// src/app/error.tsx. Run: node --test tests/unit/lazy-chunk-boundary.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findUnguardedLazyUses } = require('../../scripts/lib/lazy-boundary-audit.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('BRO-7486 shape (lazy editor in Suspense fallback={null}, no boundary) is flagged', () => {
  const src = `
const RatingEditor = lazy(() => import('@/components/user/RatingEditor'));
function Hero() {
  return open && (<Suspense fallback={null}><RatingEditor showTitle="x" /></Suspense>);
}`;
  assert.deepEqual(findUnguardedLazyUses(src).map(u => u.name), ['RatingEditor']);
});

test('next/dynamic sheet without a boundary is flagged; with one it passes', () => {
  const bare = `const PlanSheet = dynamic(() => import('./PlanSheet'), { ssr: false });
const x = <>{opened && <PlanSheet isOpen />}</>;`;
  assert.equal(findUnguardedLazyUses(bare).length, 1);
  const guarded = `const PlanSheet = dynamic(() => import('./PlanSheet'), { ssr: false });
const x = <>{opened && (<LazyChunkBoundary onError={close}><PlanSheet isOpen /></LazyChunkBoundary>)}</>;`;
  assert.equal(findUnguardedLazyUses(guarded).length, 0);
});

test('createLazyChunk components are tracked through .get()', () => {
  const src = `const editorChunk = createLazyChunk(() => import('./RatingEditor'));
function A() { const RatingEditor = editorChunk.get(); return <Suspense fallback={<S />}><RatingEditor /></Suspense>; }`;
  assert.deepEqual(findUnguardedLazyUses(src).map(u => u.name), ['RatingEditor']);
});

test('a boundary closed before the use does not count', () => {
  const src = `const Tab = lazy(() => import('./Tab'));
const x = <><LazyChunkBoundary><Other /></LazyChunkBoundary><Tab /></>;`;
  assert.equal(findUnguardedLazyUses(src).length, 1);
});

test('loaders with their own .catch fallback are exempt', () => {
  const src = `const ListsTab = dynamic(() => import('./ListsTab').catch(() => ({ default: () => null })));
const x = <ListsTab />;`;
  assert.equal(findUnguardedLazyUses(src).length, 0);
});

test('no unguarded lazy component anywhere under src/', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    for (const u of findUnguardedLazyUses(fs.readFileSync(file, 'utf8'))) {
      offenders.push(`${path.relative(ROOT, file)}:${u.line} <${u.name}>`);
    }
  }
  assert.deepEqual(offenders, [], `Wrap these in <LazyChunkBoundary> (src/components/ui/LazyChunk.tsx):\n${offenders.join('\n')}`);
});
