// BRO-6312: path.join(process.cwd(), ..., <variable>) in src/ makes Next's file
// tracer bundle the whole directory (public/ = 793MB into the off-broadway
// function, failing every Vercel deploy). Every arg after process.cwd() must be
// a string literal. Intentional exceptions: add `// nft-dynamic-ok: <reason>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

export function findDynamicCwdJoins(text) {
  const hits = [];
  const re = /path\.(?:join|resolve)\(\s*process\.cwd\(\)\s*((?:,\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*)*)(,[^)]*)?\)/g;
  for (const m of text.matchAll(re)) {
    if (m[2] !== undefined && m[2].trim() !== '' && m[2].trim() !== ',') {
      const line = text.slice(0, m.index).split('\n').length;
      if (!text.split('\n')[line - 1].includes('nft-dynamic-ok')) hits.push({ line, code: m[0] });
    }
  }
  return hits;
}

test('detector flags the BRO-6312 pattern and allows literals', () => {
  assert.equal(findDynamicCwdJoins("fs.existsSync(path.join(process.cwd(), 'public', variant))").length, 1);
  assert.equal(findDynamicCwdJoins("path.join(process.cwd(), 'public', 'data', 'x.json')").length, 0);
  assert.equal(findDynamicCwdJoins("path.join(process.cwd(), 'data/lottery-rush.json')").length, 0);
});

test('no src/ server code joins process.cwd() with a non-literal', () => {
  const bad = [];
  for (const f of walk(path.join(ROOT, 'src'))) {
    for (const h of findDynamicCwdJoins(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(ROOT, f)}:${h.line} ${h.code}`);
  }
  assert.deepEqual(bad, []);
});
