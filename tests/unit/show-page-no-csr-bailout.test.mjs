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
// Home + market browse pages had the same bailout: the HTML shipped no show
// grid, only the RSC payload carried it (BRO-4600).
const BROWSE_ENTRIES = [
  ['src/app/page.tsx', 'HomePageClient.tsx'],
  ['src/app/west-end/page.tsx', 'WestEndPageClient.tsx'],
  ['src/app/off-broadway/page.tsx', 'OffBroadwayPageClient.tsx'],
  ['src/app/off-west-end/page.tsx', 'OffWestEndPageClient.tsx'],
  ['src/app/opera/page.tsx', 'OperaPageClient.tsx'],
];

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

// Comments may name the hook when explaining why it is banned.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/[^'"`\n]*$/gm, '');
const callsUseSearchParams = (f) => /\buseSearchParams\s*\(/.test(stripComments(readFileSync(f, 'utf8')));

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
    .filter(callsUseSearchParams)
    .map(f => path.relative(ROOT, f))
    .filter(f => !ALLOW.has(f));
  assert.deepEqual(offenders, [], `useSearchParams() bails the show page out of server rendering: ${offenders.join(', ')}`);
});

for (const [entry, client] of BROWSE_ENTRIES) {
  test(`nothing ${entry} renders calls useSearchParams()`, () => {
    const files = walk(path.join(ROOT, entry));
    assert.ok([...files].some(f => f.endsWith(client)), `walk should reach ${client}`);
    assert.ok([...files].some(f => f.endsWith('usePanelFilters.ts')) || client === 'OperaPageClient.tsx',
      'walk should reach the shared usePanelFilters hook');
    const offenders = [...files]
      .filter(callsUseSearchParams)
      .map(f => path.relative(ROOT, f))
      .filter(f => !ALLOW.has(f));
    assert.deepEqual(offenders, [], `useSearchParams() bails ${entry} out of server rendering: ${offenders.join(', ')}`);
  });
}

// useLocationSearch() only re-reads the URL on popstate or its own change
// event, so a raw history.replaceState in a browse page leaves the filter
// panel showing stale chips. Writes go through replaceLocationSearch().
for (const [, client] of BROWSE_ENTRIES) {
  test(`${client} writes the URL via replaceLocationSearch()`, () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/components', client), 'utf8'));
    assert.equal(/window\.history\.(replaceState|pushState)\s*\(/.test(src), false,
      `${client} calls window.history directly; use replaceLocationSearch()`);
  });
}

test('the comment stripper still sees a real call', () => {
  assert.equal(/\buseSearchParams\s*\(/.test(stripComments("// useSearchParams()\nconst p = useSearchParams();")), true);
  assert.equal(/\buseSearchParams\s*\(/.test(stripComments("// useSearchParams()\n/* useSearchParams() */\nconst x = 1; // useSearchParams()")), false);
});
