import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { unionCensus, censusVerdict, buildCensusFromArchives, CI_UNFETCHABLE_OUTLETS } = require('./review-census.js');

test('unionCensus dedups by normalized outlet, merges sources, keeps URL + real critic', () => {
  const c = unionCensus([
    { source: 'theatre-reviews', reviews: [
      { outlet: 'The Guardian', outletId: 'guardian', critic: 'Arifa Akbar', stars: 3, url: 'g.com/r' },
      { outlet: 'WhatsOnStage', outletId: 'whatsonstage', critic: 'Unknown', stars: 3, url: '' },
    ]},
    { source: 'lbo', reviews: [
      { outlet: 'WhatsOnStage', outletId: 'whatsonstage', critic: 'Sarah Crompton', stars: 3, url: 'wos.com/r' },
    ]},
  ]);
  assert.equal(c.count, 2);
  assert.equal(c.hadAnySource, true);
  assert.deepEqual(c.sourcesPresent, ['theatre-reviews', 'lbo']);
  const wos = c.entries.find(e => e.outletId === 'whatsonstage');
  assert.equal(wos.critic, 'Sarah Crompton', 'real critic beats Unknown');
  assert.equal(wos.url, 'wos.com/r', 'URL filled from the source that had it');
  assert.deepEqual(wos.sources.sort(), ['lbo', 'theatre-reviews']);
});

test('empty / no-source census → hadAnySource false', () => {
  assert.equal(unionCensus([]).hadAnySource, false);
  assert.equal(unionCensus([{ source: 'theatre-reviews', reviews: [] }]).hadAnySource, false);
  assert.equal(unionCensus([{ source: 'x', reviews: [] }]).count, 0);
});

// THE KILLER TEST (reviewers): an empty census must NEVER read complete.
test('no-census-yet: empty census is never "complete", even with reviews present', () => {
  const empty = unionCensus([]); // no roundup published yet
  const covered = new Set(['guardian', 'times-uk', 'telegraph']); // we DO have some scored
  const v = censusVerdict(empty, covered);
  assert.equal(v.verdict, 'no-census-yet');
  assert.notEqual(v.verdict, 'complete');
});

test('verdict complete only when every censused outlet is present AND scored', () => {
  const census = unionCensus([{ source: 'theatre-reviews', reviews: [
    { outletId: 'guardian', outlet: 'The Guardian', critic: 'A', stars: 3, url: 'u1' },
    { outletId: 'whatsonstage', outlet: 'WhatsOnStage', critic: 'B', stars: 3, url: 'u2' },
  ]}]);
  // both present + scored → complete
  assert.equal(censusVerdict(census, new Set(['guardian', 'whatsonstage'])).verdict, 'complete');
  // whatsonstage missing → incomplete, listed
  const inc = censusVerdict(census, new Set(['guardian']));
  assert.equal(inc.verdict, 'incomplete');
  assert.deepEqual(inc.missing.map(m => m.outletId), ['whatsonstage']);
});

test('present-but-unscored counts as missing (MJ/All My Sons class)', () => {
  // coveredScoredOutlets only includes outlets with assignedScore != null.
  // whatsonstage has a FILE but no score → caller does NOT put it in the set → missing.
  const census = unionCensus([{ source: 'theatre-reviews', reviews: [
    { outletId: 'whatsonstage', outlet: 'WhatsOnStage', critic: 'B', stars: 3, url: 'u2' },
  ]}]);
  assert.equal(censusVerdict(census, new Set([])).verdict, 'incomplete');
});

test('market-suffix tolerance: census "timeout" matches reviews "timeout-london"', () => {
  const census = unionCensus([{ source: 'theatre-reviews', reviews: [
    { outletId: 'timeout', outlet: 'Time Out', critic: 'A', stars: 4, url: 'u1' },     // roundup bare label
    { outletId: 'guardian', outlet: 'The Guardian', critic: 'B', stars: 3, url: 'u2' },
  ]}]);
  assert.equal(censusVerdict(census, new Set(['timeout-london', 'guardian'])).verdict, 'complete');
  // reverse direction: census -london, reviews bare
  const census2 = unionCensus([{ source: 'lbo', reviews: [
    { outletId: 'timeout-london', outlet: 'Time Out London', critic: 'A', stars: 4, url: 'u1' },
  ]}]);
  assert.equal(censusVerdict(census2, new Set(['timeout'])).verdict, 'complete');
});

test('suppressed (unfetchable T1) keeps the show incomplete + visible, never complete', () => {
  const census = unionCensus([{ source: 'theatre-reviews', reviews: [
    { outletId: 'guardian', outlet: 'The Guardian', critic: 'A', stars: 3, url: 'u1' },
    { outletId: 'nytimes', outlet: 'The New York Times', critic: 'C', stars: null, url: 'u3' },
  ]}]);
  const v = censusVerdict(census, new Set(['guardian']), { suppressed: new Set(['nytimes']) });
  assert.equal(v.verdict, 'incomplete', 'suppressed-missing must NOT flip to complete');
  assert.deepEqual(v.suppressedMissing.map(m => m.outletId), ['nytimes']);
  assert.deepEqual(v.missing.map(m => m.outletId), []);
});

test('CI_UNFETCHABLE_OUTLETS is exported and covers the CI-IP-blocked outlets', () => {
  assert.ok(CI_UNFETCHABLE_OUTLETS instanceof Set);
  assert.ok(CI_UNFETCHABLE_OUTLETS.has('wsj'));
  assert.ok(CI_UNFETCHABLE_OUTLETS.has('newyorker'));
});

test('buildCensusFromArchives flags zeroExtract: archive present but parser returns 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
  // Two source archives EXIST on disk; one extractor parses fine, one returns [].
  fs.mkdirSync(path.join(dir, 'good'));
  fs.mkdirSync(path.join(dir, 'broke'));
  fs.writeFileSync(path.join(dir, 'good', 'show-x.html'), '<html>ok</html>');
  fs.writeFileSync(path.join(dir, 'broke', 'show-x.html'), '<html>changed DOM</html>');
  const sources = [
    { name: 'good', dir: 'good', fn: () => [{ outletId: 'guardian', outlet: 'The Guardian', critic: 'A', stars: 3, url: 'u' }] },
    { name: 'broke', dir: 'broke', fn: () => [] }, // parser drift → 0 reviews despite a present archive
  ];
  const census = buildCensusFromArchives('show-x', { archiveDir: dir, sources });
  assert.deepEqual(census.archivesPresent.sort(), ['broke', 'good'], 'both files were present');
  assert.deepEqual(census.zeroExtract, ['broke'], 'the broken parser is flagged, not silently swallowed');
  assert.equal(census.hadAnySource, true, 'the working source still yields a census');
  assert.equal(census.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
