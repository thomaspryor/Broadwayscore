// Minimal loader hooks so `node --test` can import Next.js API route.ts
// files directly, with no bundler in the loop:
//   1. next@14.2.x ships without a package.json "exports" map, so bare
//      subpath imports like `next/server` need an explicit extension under
//      native ESM resolution (fine at require()-time inside Next's own CJS
//      files, and under bundlers, but not from a plain ESM entrypoint).
//   2. tsconfig.json's `@/*` -> `./src/*` path alias isn't understood by
//      Node's resolver at all, so it's rewritten to a real src/ file URL.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = pathToFileURL(`${process.cwd()}/`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const candidateBase = new URL(`src/${specifier.slice(2)}`, ROOT).href;
    for (const ext of ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
      if (existsSync(fileURLToPath(candidateBase + ext))) {
        return nextResolve(candidateBase + ext, context);
      }
    }
    return nextResolve(candidateBase, context);
  }
  if (specifier.startsWith('next/') && !/\.(m?js|cjs|json)$/.test(specifier)) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return nextResolve(`${specifier}.js`, context);
    }
  }
  return nextResolve(specifier, context);
}
