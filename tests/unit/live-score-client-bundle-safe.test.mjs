// BRO-7830 class guard: modules the show page ships to the browser
// (LiveScoreOverlay.tsx imports resolve.js + apply.js) must not reach a Node
// builtin through require(); webpack would bundle a polyfill (crypto = +134kB
// first-load JS on every /show/[slug]).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, builtinModules } from 'node:module';
const require = createRequire(import.meta.url);
const dir = path.resolve('scripts/lib/live-score');
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function closure(entry, seen = new Set()) {
  const f = path.resolve(dir, entry);
  if (seen.has(f)) return seen;
  seen.add(f);
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[1].startsWith('.')) closure(m[1].endsWith('.js') ? m[1] : `${m[1]}.js`, seen);
    else assert.ok(!BUILTIN.has(m[1]), `${path.basename(f)} (client-bundled via ${entry}) requires Node builtin '${m[1]}'`);
  }
  return seen;
}

test('overlay-imported live-score modules reach no Node builtin', () => {
  for (const e of ['resolve.js', 'apply.js']) closure(e);
});

test('SCHEMA is shared by core and resolve', () => {
  assert.equal(require(path.join(dir, 'core.js')).SCHEMA, require(path.join(dir, 'schema.js')).SCHEMA);
});

// Cousin (BRO-7830): src/lib/critic-claim.ts imports Node 'crypto'; client
// components must take constants from critic-claim-constants.ts instead.
test("no 'use client' file imports @/lib/critic-claim", () => {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.tsx?$/.test(e.name)) {
        const s = fs.readFileSync(f, 'utf8');
        if (/^\s*['"]use client['"]/m.test(s.slice(0, 400)) && /from\s+['"]@\/lib\/critic-claim['"]/.test(s)) bad.push(f);
      }
    }
  };
  walk(path.resolve('src'));
  assert.deepEqual(bad, []);
});
