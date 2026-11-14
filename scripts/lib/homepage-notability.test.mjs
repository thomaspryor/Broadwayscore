// BRO-7413: scripts/lib/homepage-notability.js must agree with src/lib/homepage-notability.ts, the homepage's rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ts = require('typescript');
const js = require('./homepage-notability.js');
const src = fs.readFileSync(path.join(root, 'src', 'lib', 'homepage-notability.ts'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(mod, mod.exports);
const homepage = mod.exports;

test('thresholds are identical', () => {
  assert.deepEqual(js.NOTABILITY_THRESHOLDS, { ...homepage.NOTABILITY_THRESHOLDS });
});

test('isHomepageNotable and the revival path agree on every combination of signals', () => {
  let n = 0;
  for (const status of ['open', 'previews', 'closed']) for (const type of ['musical', 'play', 'opera'])
    for (const isRevival of [true, false]) for (const tags of [undefined, [], ['Classic'], ['lottery']])
      for (const t1Count of [0, 3, 4]) for (const reviewCount of [0, 3, 4, 17, 18]) for (const criticScore of [0, 79, 80])
        for (const curatedAudience of [0, 249, 250]) for (const homepageInclude of [undefined, true]) for (const homepageExclude of [undefined, true]) {
          const s = { status, type, isRevival, tags, t1Count, reviewCount, criticScore, curatedAudience, homepageInclude, homepageExclude };
          assert.equal(js.isHomepageNotable(s), homepage.isHomepageNotable(s), JSON.stringify(s));
          assert.equal(js.isAcclaimedKnownPropertyRevival(s), homepage.isAcclaimedKnownPropertyRevival(s), JSON.stringify(s));
          n++;
        }
  assert.ok(n > 10000);
});
