// BRO-8321 class guard: scripts/lib modules are bundled into Next routes (admin ingest, review
// normalization). Inside a webpack bundle require.resolve() returns a module id NUMBER, so
// fs.readFileSync(require.resolve(...)) reads a file descriptor and every `next build` dies with
// "EBADF: bad file descriptor, read" at page-data collection (production deploys failed 13:35Z to
// 17:30Z on 2026-11-25 from content-quality.js). Read sibling files via __dirname inside try/catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// A statement (text up to the next ";") that both resolves a module path and reads a file is the
// bundle-unsafe shape, however it is split across lines or routed through .map(). A lazy, scripts-only
// site (never imported from src/) can opt out with a "bundle-safe-ok:" comment on that statement.
export function findBundleUnsafeReads(source) {
  const hits = [];
  let offset = 0;
  for (const stmt of source.split(';')) {
    if (/require\.resolve\(/.test(stmt) && /readFile(?:Sync)?\(/.test(stmt) && !/bundle-safe-ok:/.test(stmt)) {
      const at = stmt.search(/require\.resolve\(/);
      const line = source.slice(0, offset + at).split('\n').length;
      const text = source.split('\n')[line - 1] || '';
      if (!/^\s*(\/\/|\*)/.test(text)) hits.push({ line, text });
    }
    offset += stmt.length + 1;
  }
  return hits;
}

function libFiles(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : libFiles(f);
    return /\.(?:js|cjs|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name) ? [f] : [];
  });
}

test('detector flags the broken pattern', () => {
  assert.equal(findBundleUnsafeReads("const s = require('fs').readFileSync(require.resolve('./x'), 'utf8');").length, 1);
  assert.equal(findBundleUnsafeReads("fs.readFileSync(path.join(__dirname, 'x.js'), 'utf8')").length, 0);
  assert.equal(findBundleUnsafeReads("fs.readFileSync(\n  require.resolve('./x'),\n 'utf8')").length, 1);
  assert.equal(findBundleUnsafeReads("[a, require.resolve('./x')].map((f) => fs.readFileSync(f, 'utf8'))").length, 1);
  assert.equal(findBundleUnsafeReads("// bundle-safe-ok: lazy\n[require.resolve('./x')].map((f) => fs.readFileSync(f))").length, 0);
});

test('no scripts/lib module reads a file through require.resolve', () => {
  const bad = [];
  for (const f of libFiles(dir)) {
    for (const hit of findBundleUnsafeReads(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(dir, f)}:${hit.line}`);
  }
  assert.deepEqual(bad, []);
});
