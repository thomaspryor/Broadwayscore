// BRO-6241: the "what counts as a UI file" rule lives in several copies (bash hook, MCP gate,
// ui-paths.mjs, transcript-scan, verify-edits.sh, headless-dispatchability). They must agree on
// a fixed probe set; route handlers, tests and type files are NOT UI, components and styles are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isUiPath } from '../lib/ui-paths.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const UI = ['src/components/Foo.tsx', 'src/app/page.tsx', 'src/app/shows/[slug]/page.tsx', 'src/styles/a.css', 'src/x/y.module.css', 'tailwind.config.ts'];
const NOT_UI = ['src/app/api/owner-decision/route.ts', 'src/app/sitemap.ts', 'src/lib/scoring.ts', 'scripts/lib/x.js', 'data/shows.json'];

function ere(file, name) {
  const re = new RegExp(`^${name}='([^']+)'`, 'm').exec(read(file))?.[1];
  assert.ok(re, `${name} not found in ${file}`);
  return (p) => spawnSync('grep', ['-Eq', re], { input: p }).status === 0;
}

for (const [file, name] of [['.claude/hooks/pre-push-visual-gate.sh', 'UI_PATTERN'], ['scripts/lib/mcp-push-visual-gate.sh', 'UI_PATTERN']]) {
  test(`${file} agrees on the probe set`, () => {
    const f = ere(file, name);
    for (const p of UI) assert.ok(f(p), p);
    for (const p of NOT_UI) assert.ok(!f(p), p);
  });
}

test('ui-paths.mjs agrees on the probe set', () => {
  for (const p of UI) assert.ok(isUiPath(p), p);
  for (const p of NOT_UI) assert.ok(!isUiPath(p), p);
});

test('headless-dispatchability agrees on the probe set', () => {
  const { UI_PATH_RE } = require('../lib/headless-dispatchability.js');
  for (const p of UI) assert.ok(UI_PATH_RE.test(p), p);
  for (const p of NOT_UI) assert.ok(!UI_PATH_RE.test(p), p);
});

test('transcript-scan and verify-edits carry no src/app ts/js alternative', () => {
  assert.ok(!/src\\?\/app\\?\/\.\*\\\.\(\??:?tsx\|jsx\|ts\|js\)/.test(read('scripts/lib/transcript-scan.mjs')));
  assert.ok(!/src\/app\/\.\*\\\.\(\?:tsx\|jsx\|ts\|js\)/.test(read('.claude/hooks/verify-edits.sh')));
});
