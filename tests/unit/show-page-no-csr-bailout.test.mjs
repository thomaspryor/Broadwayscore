// The show page is a static export. A component that calls useSearchParams()
// bails its nearest Suspense boundary out to client-side rendering, and the
// prerendered HTML ships an empty hole instead. ShowHeroRedesign did exactly
// that from the 2026-10-02 redesign launch: every show page's <h1>, score and
// verdict were missing from the HTML search engines and link previews read
// (BRO-4597). This walks everything page.tsx imports and refuses any
// useSearchParams() outside the allowlist (each entry must be a deliberately
// client-only island, never the hero).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src/app/show/[slug]/page.tsx');
const ALLOW = new Set([]);

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const ext of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js']) {
    const p = base + ext;
    if (existsSync(p) && !p.endsWith('/') && /\.(tsx?|jsx?)$/.test(p)) return p;
  }
  return null;
}

function walk(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const p = resolveImport(f, m[1] || m[2]);
      if (p && p.startsWith(path.join(ROOT, 'src'))) stack.push(p);
    }
  }
  return seen;
}

test('nothing the show page renders calls useSearchParams()', () => {
  const files = walk(ENTRY);
  assert.ok(files.size > 20, `import walk found only ${files.size} files; resolver broken?`);
  assert.ok([...files].some(f => f.endsWith('ShowHeroRedesign.tsx')), 'walk should reach ShowHeroRedesign');
  const offenders = [...files]
    .filter(f => /\buseSearchParams\s*\(/.test(readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f))
    .filter(f => !ALLOW.has(f));
  assert.deepEqual(offenders, [], `useSearchParams() bails the show page out of server rendering: ${offenders.join(', ')}`);
});
