'use strict';

/**
 * BRO-7494 class guard: a component loaded with React.lazy / next/dynamic /
 * createLazyChunk throws during render when its chunk fails to download (flaky
 * network, a deploy that removed the old chunk). Without a local error boundary
 * that throw reaches src/app/error.tsx and replaces the WHOLE page. BRO-7486
 * shipped exactly that on /show/[slug] (RatingEditor in <Suspense fallback={null}>).
 *
 * findUnguardedLazyUses(source, { importedLazy }) returns every JSX use of a
 * lazily loaded component in `source` that is not inside an open error boundary
 * in the same file. Lazy components come from this file's own declarations and
 * from `importedLazy` (names other files export as lazy; see exportedLazyNames).
 * Exempt: loaders with their own `.catch(` fallback (the import can't reject).
 * Flag-gated loaders (`const X = FLAG ? dynamic(...) : () => null`) count too:
 * they render a real lazy chunk the day the flag turns on.
 */

const BOUNDARY_TAGS = ['LazyChunkBoundary', 'ErrorBoundary', 'SheetBoundary', 'StatsErrorBoundary'];

// const X = lazy|React.lazy|dynamic|dynamic<P>(() => import('...'))
const DIRECT = /(export\s+)?const\s+(\w+)\s*=\s*(?:(?:(?!\b(?:const|let|var|function)\b)[^;])*?\?\s*)?(?:React\.lazy|lazy|dynamic)\s*(?:<[^>]*>)?\(\s*(?:async\s*)?\(\)\s*=>\s*import\(([^)]*)\)(\.catch\()?/g;

/** Block and line comments out, offsets kept (replaced by spaces, newlines kept). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre) => {
    const keep = pre || '';
    return keep + m.slice(keep.length).replace(/[^\n]/g, ' ');
  });
}

function lazyComponentNames(source) {
  const names = new Set();
  const chunkVars = new Set();
  let m;
  DIRECT.lastIndex = 0;
  while ((m = DIRECT.exec(source))) {
    if (m[4]) continue; // import(...).catch(...) renders its own fallback
    names.add(m[2]);
  }
  // const chunk = createLazyChunk(...); const X = chunk.get();
  const chunk = /const\s+(\w+)\s*=\s*createLazyChunk\s*(?:<[^>]*>)?\(/g;
  while ((m = chunk.exec(source))) chunkVars.add(m[1]);
  for (const v of chunkVars) {
    const get = new RegExp(`const\\s+(\\w+)\\s*=\\s*${v}\\.get\\(\\)`, 'g');
    while ((m = get.exec(source))) names.add(m[1]);
  }
  return names;
}

/** Names this file exports as lazy components (`export const X = dynamic(...)`). */
function exportedLazyNames(source) {
  const out = new Set();
  let m;
  DIRECT.lastIndex = 0;
  const lazy = new Set();
  while ((m = DIRECT.exec(source))) {
    if (m[4]) continue;
    lazy.add(m[2]);
    if (m[1]) out.add(m[2]);
  }
  // export default X, where X is lazy
  const def = /export\s+default\s+(\w+)\s*;?/.exec(source);
  if (def && lazy.has(def[1])) out.add('default');
  return out;
}

/** Named imports by module specifier: { '@/x/y': ['A', 'B'] } (aliases resolve to the local name). */
function namedImports(source) {
  const out = {};
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [orig, local] = s.split(/\s+as\s+/);
      return { orig: orig.trim(), local: (local || orig).trim() };
    });
    (out[m[2]] = out[m[2]] || []).push(...names);
  }
  // import X from '...'  /  import X, { Y } from '...'
  const def = /import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = def.exec(source))) {
    if (m[1] === 'type') continue;
    (out[m[2]] = out[m[2]] || []).push({ orig: 'default', local: m[1] });
  }
  return out;
}

function openBoundariesBefore(source, index) {
  const before = source.slice(0, index);
  let open = 0;
  for (const tag of BOUNDARY_TAGS) {
    // Opening tags (attributes may hold JSX, so don't parse to '>'); closing and self-closing tags subtract.
    open += (before.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    open -= (before.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    open -= (before.match(new RegExp(`<${tag}(\\s[^<>]*)?/>`, 'g')) || []).length;
  }
  return open;
}

function findUnguardedLazyUses(rawSource, { importedLazy = [] } = {}) {
  const source = stripComments(rawSource);
  const out = [];
  const names = lazyComponentNames(source);
  for (const n of importedLazy) names.add(n);
  for (const name of names) {
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

module.exports = { findUnguardedLazyUses, lazyComponentNames, exportedLazyNames, namedImports, stripComments, BOUNDARY_TAGS };
