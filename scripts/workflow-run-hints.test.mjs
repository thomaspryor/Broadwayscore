// Every `gh workflow run <target>` hint a script prints must name a real
// workflow (file name or `name:`). verify-review-recovery.js once told people
// to run "Refresh Review Data" (the scraper) to rebuild reviews.json (BRO-5942).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const wfDir = path.join(root, '.github', 'workflows');
const files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
const names = new Set(files.map((f) => {
  const m = fs.readFileSync(path.join(wfDir, f), 'utf8').match(/^name:\s*["']?(.+?)["']?\s*$/m);
  return m ? m[1] : null;
}).filter(Boolean));

function scriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : scriptFiles(p);
    return /\.(c?js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

test('gh workflow run hints name an existing workflow', () => {
  const bad = [];
  for (const f of scriptFiles(path.join(root, 'scripts'))) {
    // Comment lines hold examples (`gh workflow run x.yml`), not hints.
    const src = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    for (const m of src.matchAll(/gh workflow run (?:"([^"$`{]+)"|'([^'$`{]+)'|([\w.-]+\.ya?ml))/g)) {
      const target = m[1] || m[2] || m[3];
      if (!files.includes(target) && !names.has(target)) bad.push(`${path.relative(root, f)}: ${target}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('verify-review-recovery points a missing-from-reviews.json row at the rebuild', () => {
  const src = fs.readFileSync(path.join(root, 'scripts', 'verify-review-recovery.js'), 'utf8');
  assert.match(fs.readFileSync(path.join(wfDir, 'rebuild-reviews.yml'), 'utf8'), /reviews\.json/);
  assert.ok(src.includes('gh workflow run rebuild-reviews.yml'));
  assert.ok(!src.includes('Refresh Review Data'), 'Refresh Review Data is the scraper, not the rebuild');
});
