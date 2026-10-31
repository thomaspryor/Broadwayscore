import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { SYNOPSIS_SOURCES, setSynopsis, synopsisSourceProblem } = require('./synopsis-source.js');

test('setSynopsis stamps text and source together', () => {
  const s = setSynopsis({ id: 'x' }, 'A plot.', 'wikipedia');
  assert.equal(s.synopsis, 'A plot.');
  assert.equal(s.synopsisSource, 'wikipedia');
});
test('setSynopsis with empty text drops the stamp', () => {
  const s = setSynopsis({ synopsis: 'a', synopsisSource: 'llm' }, '', 'llm');
  assert.equal(s.synopsisSource, undefined);
});
test('setSynopsis rejects unknown sources', () => {
  assert.throws(() => setSynopsis({}, 'x', 'wiki'));
});
test('synopsisSourceProblem: legacy unstamped ok, bad value and orphan stamp flagged', () => {
  assert.equal(synopsisSourceProblem({ synopsis: 'x' }), null);
  assert.ok(synopsisSourceProblem({ synopsis: 'x', synopsisSource: 'bogus' }));
  assert.ok(synopsisSourceProblem({ synopsisSource: 'llm' }));
  assert.equal(synopsisSourceProblem({ synopsis: 'x', synopsisSource: 'hand-written (BRO-4884)' }), null);
  for (const src of SYNOPSIS_SOURCES) assert.equal(synopsisSourceProblem({ synopsis: 'x', synopsisSource: src }), null);
});
// Prevention: no script may assign .synopsis directly (stamp would go stale). Cleared/blank
// initialisation in discover scripts is fine (`synopsis: ''`); those are not assignments.
test('no script assigns .synopsis directly', () => {
  const dir = new URL('../', import.meta.url);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = new URL(e.name + (e.isDirectory() ? '/' : ''), d);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.js') && !/\.test\./.test(e.name) && e.name !== 'synopsis-source.js') files.push(p);
    }
  };
  walk(dir);
  // Reviewed exceptions: the text is derived from the already-stamped value, or it is not a show row.
  const ALLOW = new Set([
    'clean-synopsis-markup.js', // markup stripped from the existing synopsis; stamp stays valid
    'lib/tour-family.js', // patch carries parent.synopsisSource alongside the text
    'scrape-show-score-audience.js', // result.synopsis is scrape metadata; the show write uses setSynopsis
  ]);
  const offenders = files.filter((f) => /\.synopsis\s*=[^=]/.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
  assert.deepEqual(offenders.map((f) => f.pathname.split('/scripts/')[1]).filter((n) => !ALLOW.has(n)), [], 'use setSynopsis/clearSynopsis from lib/synopsis-source.js');
});
