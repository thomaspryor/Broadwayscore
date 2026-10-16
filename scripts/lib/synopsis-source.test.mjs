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
// Prevention: every script that assigns show.synopsis must go through setSynopsis.
test('no write site assigns .synopsis directly', () => {
  const sites = ['scrape-show-score-audience.js', 'enrich-todaytix-data.js', 'enrich-wikipedia-synopsis.js', 'auto-fix-show-data.js'];
  for (const f of sites) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/\bshow\.synopsis\s*=[^=]/.test(src), `${f} assigns show.synopsis directly; use setSynopsis`);
    assert.ok(src.includes('setSynopsis('), `${f} must call setSynopsis`);
  }
});
