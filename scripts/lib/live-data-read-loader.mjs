// live-data-read-loader.mjs (BRO-7101) — ESM load hook registered by
// live-data-read-hook.mjs: records `import ... from '<repo>/data/x.json'`,
// which bypasses the public fs object. Never alters what is resolved.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { liveDataRelPath, isTestCaller } = createRequire(import.meta.url)('./live-data-paths.js');
let cfg = null;
const seen = new Set();
export async function initialize(data) { cfg = data; }
// resolve, not load: only resolve sees which module did the import (parentURL).
export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  try {
    if (cfg && r && typeof r.url === 'string' && r.url.startsWith('file:')) {
      const p = liveDataRelPath(fileURLToPath(r.url), cfg.root);
      if (p) {
        const parent = context.parentURL && context.parentURL.startsWith('file:')
          ? path.relative(cfg.root, fileURLToPath(context.parentURL)).split(path.sep).join('/') : '';
        const direct = isTestCaller(parent, cfg.test);
        const key = `${direct ? 'd' : 'i'}:${p}`;
        if (!seen.has(key)) { seen.add(key); fs.appendFileSync(cfg.log, JSON.stringify({ test: cfg.test, path: p, direct }) + '\n'); }
      }
    }
  } catch { /* never break the resolve */ }
  return r;
}
