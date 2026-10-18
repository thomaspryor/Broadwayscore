import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  TITLE_EXCLUDE_FAMILIES, OPERA_TITLE_EXCLUDE_FAMILIES,
  loadIndependentTitleCorpus, loadTitleCorpus, loadOperaTitleCorpus,
  scanTitleFamilies, evaluateTitleFamilies, checkTitleExcludeCoverage,
} = require('../../scripts/audit-regex-patterns.js');
const fixture = require('../fixtures/discovery-title-corpus.json');

test('discovery gate coverage includes all four families and rejects an unregistered fifth script', () => {
  const found = checkTitleExcludeCoverage();
  assert.deepEqual(found.map(f => f.family).sort(), [...TITLE_EXCLUDE_FAMILIES, ...OPERA_TITLE_EXCLUDE_FAMILIES].sort());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2658-coverage-'));
  try {
    fs.writeFileSync(path.join(dir, 'discover-new-shows.js'),
      'NON_THEATER_PATTERNS.some(p => title.includes(p));');
    assert.equal(checkTitleExcludeCoverage(dir).length, 1);
    fs.writeFileSync(path.join(dir, 'discover-fifth-market.js'),
      'FIFTH_TITLE_PATTERNS.some(\n (pattern) => t.includes(pattern)\n);');
    assert.throws(() => checkTitleExcludeCoverage(dir), /discover-fifth-market.js: FIFTH_TITLE_PATTERNS.*no registered corpus audit/);
    fs.rmSync(path.join(dir, 'discover-fifth-market.js'));
    fs.appendFileSync(path.join(dir, 'discover-new-shows.js'),
      '\nFIFTH_TITLE_PATTERNS.some(pattern => t.includes(pattern));');
    assert.throws(() => checkTitleExcludeCoverage(dir), /discover-new-shows.js: FIFTH_TITLE_PATTERNS.*no registered corpus audit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BRO-2658: external listings supply required evidence for both title corpora', () => {
  assert.equal(loadIndependentTitleCorpus('theatre').length, 38);
  assert.equal(loadIndependentTitleCorpus('opera').length, 24);
  assert.ok(loadIndependentTitleCorpus('theatre').includes('Via Galactica'));
  assert.ok(loadIndependentTitleCorpus('opera').includes('Roberto Devereux'));
});

for (const family of TITLE_EXCLUDE_FAMILIES) {
  test(`BRO-2658: ${family} catches a title rejected before tracking`, () => {
    const trackedShows = [{ t: 'Hamilton', ty: 'musical' }];
    const families = { [family]: ['hard job'] };
    const survivorOnly = scanTitleFamilies({ families, titles: trackedShows.map(s => s.t) });
    assert.equal(evaluateTitleFamilies({ counts: survivorOnly }).length, 0);
    const counts = scanTitleFamilies({ families, titles: loadTitleCorpus({ trackedShows }) });
    const violations = evaluateTitleFamilies({ counts });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].hits, 1);
    assert.equal(violations[0].examples[0].match, 'Hard Job Being God');
  });
}

test('BRO-2658: opera exclusions catch an untracked production from Met repertory', () => {
  const trackedShows = [{ t: 'La Bohème', ty: 'opera' }, { t: 'Hamilton', ty: 'musical' }];
  const families = { [OPERA_TITLE_EXCLUDE_FAMILIES[0]]: ['devereux'] };
  const counts = scanTitleFamilies({ families, titles: loadOperaTitleCorpus({ trackedShows }) });
  const violations = evaluateTitleFamilies({ counts });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].examples[0].match, 'Roberto Devereux');
  assert.ok(!loadOperaTitleCorpus({ trackedShows }).includes('Hamilton'));
  assert.ok(!loadOperaTitleCorpus({ trackedShows: [] }).includes('Via Galactica'));
  assert.ok(!loadTitleCorpus({ trackedShows: [] }).includes('Roberto Devereux'));
});

test('independent titles survive an empty tracked corpus and do not duplicate tracked titles', () => {
  assert.deepEqual(loadTitleCorpus({ trackedShows: [] }), loadIndependentTitleCorpus('theatre'));
  assert.deepEqual(loadOperaTitleCorpus({ trackedShows: [] }), loadIndependentTitleCorpus('opera'));
  const trackedShows = [{ t: 'VIA GALACTICA' }, { t: 'Hamilton' }, { t: 'Hamilton' }];
  const titles = loadTitleCorpus({ trackedShows });
  assert.deepEqual(titles.slice(0, 3), trackedShows.map(s => s.t), 'preserve prior tracked evidence');
  assert.equal(titles.filter(t => t.toLowerCase() === 'via galactica').length, 1);
});

test('independent evidence cannot disappear or degrade into an empty successful audit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2658-corpus-'));
  try {
    const corpusPath = path.join(dir, 'corpus.json');
    assert.throws(() => loadTitleCorpus({ trackedShows: [], corpusPath }), /ENOENT/);
    fs.writeFileSync(corpusPath, '{');
    assert.throws(() => loadIndependentTitleCorpus('theatre', corpusPath), SyntaxError);
    for (const bad of [
      {}, { sources: [] },
      { sources: [{ ...fixture.sources[0], titles: [] }] },
      { sources: [{ ...fixture.sources[0], titles: [''] }] },
      { sources: [{ ...fixture.sources[0], type: 'unknown' }] },
      { sources: [{ ...fixture.sources[0], url: '' }] },
      { sources: [{ ...fixture.sources[0], capturedAt: '' }] },
      { sources: [{ ...fixture.sources[0], selection: '' }] },
    ]) {
      fs.writeFileSync(corpusPath, JSON.stringify(bad));
      assert.throws(() => loadIndependentTitleCorpus('theatre', corpusPath), /independent title/);
    }
    for (const type of ['theatre', 'opera']) {
      const partial = structuredClone(fixture);
      partial.sources.find(s => s.type === type).titles = Array(30).fill('Same title');
      fs.writeFileSync(corpusPath, JSON.stringify(partial));
      assert.throws(() => loadIndependentTitleCorpus(type, corpusPath), /only 1 independent/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
