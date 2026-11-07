// BRO-6305: a server module that touches public/ through fs with a dynamic
// path makes Next's file tracing copy that tree into every function that
// imports it. On 2026-10-26 one fs.existsSync(public/images/...) check
// doubled the Vercel upload (725MB -> 1.4GB) and every deploy failed for
// hours. Functions never need public/ files (the CDN serves them), so the
// big public trees stay excluded, and any server module reading public/
// through fs must be covered by an exclude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const config = require(join(ROOT, 'next.config.js'));
const excludes = (config.outputFileTracingExcludes || {})['**/*'] || [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

test('next.config.js keeps public/images out of server function traces', () => {
  assert.ok(excludes.includes('public/images/**'), 'outputFileTracingExcludes["**/*"] must include public/images/**');
});

test('server code that reads public/ through fs is covered by a tracing exclude', () => {
  const offenders = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    if (!/\bfs\b|from ['"](node:)?fs['"]/.test(src)) continue;
    // fs access built from process.cwd() + 'public' (the BRO-6305 shape).
    if (!/process\.cwd\(\)[^;\n]*['"]public['"]/.test(src)) continue;
    const coveredBy = excludes.find(e => e.startsWith('public/'));
    if (!coveredBy) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], 'add the public/ subtree these files read to outputFileTracingExcludes');
});
