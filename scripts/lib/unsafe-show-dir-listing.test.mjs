import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { countUnsafeLines, scanScripts, compareToBaseline } = require('./unsafe-show-dir-listing.js');

test('countUnsafeLines flags statSync().isDirectory and ignores comments', () => {
  const src = [
    "const a = fs.readdirSync(d).filter(f => fs.statSync(path.join(d, f)).isDirectory());",
    "// fs.statSync(x).isDirectory() in a comment",
    " * fs.statSync(x).isDirectory() in a jsdoc",
    "const b = listShowDirs(d);",
    "const c = fs.lstatSync(p).isFile();",
  ].join('\n');
  assert.equal(countUnsafeLines(src), 1);
});

test('scanScripts + compareToBaseline: new offender regresses, migrated file improves', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unsafe-listing-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'bad.js'), "fs.statSync(p).isDirectory();\n");
  fs.writeFileSync(path.join(root, 'scripts', 'ok.js'), "listShowDirs(p);\n");
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'list-show-dirs.js'), "fs.statSync(p).isDirectory();\n");
  const counts = scanScripts(root);
  assert.deepEqual(counts, { 'scripts/bad.js': 1 });
  assert.equal(compareToBaseline(counts, {}).regressions.length, 1);
  assert.equal(compareToBaseline(counts, { 'scripts/bad.js': 1 }).regressions.length, 0);
  const imp = compareToBaseline({}, { 'scripts/bad.js': 1 }).improvements;
  assert.equal(imp.length, 1);
});
