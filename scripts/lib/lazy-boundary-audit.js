'use strict';

/**
 * BRO-7494 class guard: a component loaded with React.lazy / next/dynamic /
 * createLazyChunk throws during render when its chunk fails to download (flaky
 * network, a deploy that removed the old chunk). Without a local error boundary
 * that throw reaches src/app/error.tsx and replaces the WHOLE page. BRO-7486
 * shipped exactly that on /show/[slug] (RatingEditor in <Suspense fallback={null}>).
 *
 * findUnguardedLazyUses(source) returns every JSX use of a lazily loaded
 * component in `source` that is not inside an open error boundary in the same
 * file. Exempt: loaders with their own `.catch(` fallback (the import can't
 * reject), and HELD_BOX_OFFICE_BUILD loaders (dropped from production builds).
 */

const BOUNDARY_TAGS = ['LazyChunkBoundary', 'ErrorBoundary', 'SheetBoundary', 'StatsErrorBoundary'];

function lazyComponentNames(source) {
  const names = new Set();
  const chunkVars = new Set();
  // const X = lazy(() => import('...'))  /  const X = dynamic(() => import('...'), {...})
  const direct = /const\s+(\w+)\s*=\s*(lazy|dynamic)\(\s*\(\)\s*=>\s*import\(([^)]*)\)(\.catch\()?/g;
  let m;
  while ((m = direct.exec(source))) {
    if (m[4]) continue; // import(...).catch(...) renders its own fallback
    names.add(m[1]);
  }
  // const chunk = createLazyChunk(...); const X = chunk.get();
  const chunk = /const\s+(\w+)\s*=\s*createLazyChunk\(/g;
  while ((m = chunk.exec(source))) chunkVars.add(m[1]);
  for (const v of chunkVars) {
    const get = new RegExp(`const\\s+(\\w+)\\s*=\\s*${v}\\.get\\(\\)`, 'g');
    while ((m = get.exec(source))) names.add(m[1]);
  }
  return names;
}

function openBoundariesBefore(source, index) {
  const before = source.slice(0, index);
  let open = 0;
  for (const tag of BOUNDARY_TAGS) {
    // Opening tags (attributes may hold JSX, so don't parse to '>'); closing tags subtract.
    open += (before.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    open -= (before.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  }
  return open;
}

function findUnguardedLazyUses(source) {
  const out = [];
  for (const name of lazyComponentNames(source)) {
    const use = new RegExp(`<${name}[\\s/>]`, 'g');
    let m;
    while ((m = use.exec(source))) {
      if (openBoundariesBefore(source, m.index) > 0) continue;
      const line = source.slice(0, m.index).split('\n').length;
      out.push({ name, line });
    }
  }
  return out;
}

module.exports = { findUnguardedLazyUses, lazyComponentNames, BOUNDARY_TAGS };
