/**
 * Guard: server code under src/ must never name the data/ (or public/) root
 * as a path.
 *
 * Next's file tracer (nft) bundles whatever a server module's fs paths point
 * at. src/lib/data-core.ts once passed path.join(process.cwd(), 'data') to a
 * helper, so every server function that loads data-core traced all of data/
 * (12,479 files locally; ~290 MB on Vercel, including the review transcripts).
 * Eight functions went over Vercel's size limit and every production deploy
 * failed with state=ERROR until it was fixed (2026-10-21). Name files
 * (data/audit/x.json) or a small subfolder instead.
 *
 * Comments are ignored. Subfolders already in use (data/social-pulse,
 * public/data/shows, content/reviews) are not roots and stay allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = new Set(['data', 'public', 'public/data', '.', '']);

function walk(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (!ent.name.startsWith('.') && ent.name !== 'node_modules' && ent.name !== '__tests__') walk(join(dir, ent.name), out); }
    else if (/\.(?:c|m)?[jt]sx?$/.test(ent.name) && !/\.test\./.test(ent.name)) out.push(join(dir, ent.name));
  }
  return out;
}

const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

/** cwd-based path calls whose literal segments name a whole-tree root. */
export function rootDirHits(src) {
  const hits = [];
  const code = stripComments(src);
  for (const m of code.matchAll(/path\.(?:join|resolve)\(\s*process\.cwd\(\)((?:\s*,\s*['"][^'"]*['"])*)\s*\)/g)) {
    const segs = [...m[1].matchAll(/['"]([^'"]*)['"]/g)].map(x => x[1]).join('/').replace(/\/+$/, '');
    if (ROOTS.has(segs)) hits.push(m[0]);
  }
  // process.cwd() + '/data' and `${process.cwd()}/data` (page.tsx already uses
  // the + form, with file names), ending at the root rather than a file.
  for (const m of code.matchAll(/process\.cwd\(\)\s*\+\s*(['"])([^'"]*)\1(?!\s*\+)|`\$\{process\.cwd\(\)\}([^`$]*)`/g)) {
    const segs = (m[2] ?? m[3] ?? '').replace(/^\/+|\/+$/g, '');
    if (ROOTS.has(segs)) hits.push(m[0]);
  }
  return hits;
}

test('detector: roots caught, files and subfolders allowed, comments ignored', () => {
  assert.equal(rootDirHits("load(path.join(process.cwd(), 'data'))").length, 1);
  assert.equal(rootDirHits('const d = path.resolve(process.cwd(), "public", "data");').length, 1);
  assert.equal(rootDirHits("path.join(process.cwd(), 'data', 'audit', 'x.json')").length, 0);
  assert.equal(rootDirHits("path.join(process.cwd(), 'data', 'social-pulse')").length, 0);
  assert.equal(rootDirHits("// passing path.join(process.cwd(), 'data') traced everything").length, 0);
  assert.equal(rootDirHits("const d = process.cwd() + '/data';").length, 1);
  assert.equal(rootDirHits('const d = `${process.cwd()}/public/data/`;').length, 1);
  assert.equal(rootDirHits("fs.readFileSync(process.cwd() + '/public/data/homepage-archive.json')").length, 0);
  assert.equal(rootDirHits("const r = `${process.cwd()}/data/audit/x.json`;").length, 0);
});

test('no server code under src/ names the data/ or public/ root', () => {
  const files = walk(join(ROOT, 'src'), []);
  assert.ok(files.length > 300, `scanned only ${files.length} files — walk is broken`);
  const problems = [];
  for (const f of files) {
    for (const h of rootDirHits(readFileSync(f, 'utf8'))) problems.push(`${relative(ROOT, f).split(sep).join('/')}: ${h}`);
  }
  assert.deepEqual(problems, [], 'name the files you read (data/audit/x.json), not the root: Next traces the whole directory into every server function');
});
