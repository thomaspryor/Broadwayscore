// BRO-7327 cousin (BRO-4891 class): a record whose syndicatedPrimaryFile names itself is
// not a syndicated copy. Every exclusion site must route through isSyndicatedDuplicateActive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const synd = require('./syndication-pairs.js');
const guards = require('./review-guards.js');
const { classifyRebuildExclusion } = require('./llm-scoring-parity.js');

const SHOW = 'a-little-night-music-2009';
const FILE = 'nytimes--charles-isherwood.json';
const show = { id: SHOW, status: 'closed', category: 'broadway', openingDate: '2009-12-13' };
const rec = (extra) => ({
  showId: SHOW, outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Charles Isherwood',
  url: 'https://www.nytimes.com/2010/08/02/theater/02night.html', contentTier: 'complete', isFullReview: true,
  fullText: 'A full review of the revival. '.repeat(80), assignedScore: 68, publishDate: '2010-08-02',
  isSyndicatedDuplicate: true, ...extra,
});
const fp = (dir) => path.join(dir, SHOW, FILE);

test('isSelfSyndicationPointer: bare and show-qualified self pointers', () => {
  assert.equal(synd.isSelfSyndicationPointer({ syndicatedPrimaryFile: FILE }, `/x/${SHOW}/${FILE}`), true);
  assert.equal(synd.isSelfSyndicationPointer({ syndicatedPrimaryFile: `${SHOW}/${FILE}` }, `/x/${SHOW}/${FILE}`), true);
});

test('isSelfSyndicationPointer: other file, other show, or no path is not a self pointer', () => {
  assert.equal(synd.isSelfSyndicationPointer({ syndicatedPrimaryFile: 'ap--mark-kennedy.json' }, `/x/${SHOW}/${FILE}`), false);
  // To Kill a Mockingbird WE 2022 -> 2026 folder: a cross-show pointer, not self
  assert.equal(synd.isSelfSyndicationPointer({ syndicatedPrimaryFile: `other-show-2026/${FILE}` }, `/x/${SHOW}/${FILE}`), false);
  assert.equal(synd.isSelfSyndicationPointer({ syndicatedPrimaryFile: FILE }, undefined), false);
  assert.equal(synd.isSelfSyndicationPointer({}, `/x/${SHOW}/${FILE}`), false);
});

test('isSyndicatedDuplicateActive: self pointer ignored, real pointer and legacy flag honoured', () => {
  const p = `/x/${SHOW}/${FILE}`;
  assert.equal(synd.isSyndicatedDuplicateActive(rec({ syndicatedPrimaryFile: `${SHOW}/${FILE}` }), p), false);
  assert.equal(synd.isSyndicatedDuplicateActive(rec({ syndicatedPrimaryFile: `${SHOW}/ap--mark-kennedy.json` }), p), true);
  assert.equal(synd.isSyndicatedDuplicateActive(rec({}), p), true); // legacy flag with no pointer
  assert.equal(synd.isSyndicatedDuplicateActive(rec({ syndicatedPrimaryFile: FILE }), undefined), true); // no path: conservative
  assert.equal(synd.isSyndicatedDuplicateActive(rec({ isSyndicatedDuplicate: false }), p), false);
  assert.equal(guards.isSyndicatedDuplicateActive(rec({ syndicatedPrimaryFile: FILE }), p), false);
});

test('explainExclusion + parity mirror do not exclude a self-pointing copy (real Isherwood shape)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synd-self-'));
  fs.mkdirSync(path.join(dir, SHOW));
  const self = rec({ syndicatedPrimaryFile: `${SHOW}/${FILE}`, syndicationSimilarity: 100 });
  fs.writeFileSync(fp(dir), JSON.stringify(self));
  assert.notEqual(guards.explainExclusion(self, show, fp(dir)), 'isSyndicatedDuplicate');
  assert.notEqual(classifyRebuildExclusion(self, show, fp(dir)), 'isSyndicatedDuplicate');
  // a real pointer to a sibling still excludes
  const real = rec({ syndicatedPrimaryFile: `${SHOW}/ap--mark-kennedy.json` });
  assert.equal(guards.explainExclusion(real, show, fp(dir)), 'isSyndicatedDuplicate');
  assert.equal(classifyRebuildExclusion(real, show, fp(dir)), 'isSyndicatedDuplicate');
});

test('every exclusion site reads the flag through the canonical predicate (no raw === true check)', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const sites = ['review-guards.js', 'llm-scoring-parity.js', '../rebuild-all-reviews.js', '../scoring-delta.js', '../admin/compute-composite.js'];
  for (const rel of sites) {
    const src = fs.readFileSync(path.join(here, rel), 'utf8');
    // any direct read of the flag inside an `if (` / `return` exclusion line, chained or not
    const raw = src.split('\n').filter((l) => /\b(data|review)\.isSyndicatedDuplicate\b/.test(l) && /\bif \(|\breturn\b/.test(l) && !/^\s*\/\//.test(l));
    assert.deepEqual(raw, [], `${rel} gates on the raw isSyndicatedDuplicate flag; use isSyndicatedDuplicateActive(data, filePath)`);
  }
});

test('every ESM named import of these CJS modules resolves (cjs-module-lexer visibility)', async () => {
  // An inline arrow/function-valued property in module.exports stops the lexer and silently hides
  // every later export from `import { x } from` (BRO-7327 land failure: getWrongProductionReasonForBww).
  const scriptsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const mods = ['review-guards', 'syndication-pairs', 'llm-scoring-parity', 'review-field-edit'];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.mjs') ? [p] : []);
  });
  const files = walk(scriptsDir);
  let checked = 0;
  for (const mod of mods) {
    const visible = new Set(Object.keys(await import(`./${mod}.js`)));
    const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*\\/${mod}\\.js['"]`, 'g');
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim();
          if (!name) continue;
          checked++;
          assert.ok(visible.has(name), `${path.relative(scriptsDir, f)} imports { ${name} } from ${mod}.js, but ESM cannot see it`);
        }
      }
    }
  }
  assert.ok(checked > 0, 'scan found no ESM named imports; the regex or paths are wrong');
});
