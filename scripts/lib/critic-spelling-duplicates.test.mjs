/**
 * Regression guard for the Cheryl Markoski/Markosky class of defect (BRO-4156).
 *
 * INCIDENT: how-the-other-half-loves-west-end-2026 had TWO london-theatre
 * review files for the same critic's same review —
 * london-theatre--cheryl-markoski.json (misspelled; the outlet's own byline
 * reads "Cheryl Markosky") and london-theatre--cheryl-markosky.json (correct
 * spelling, sourced from Theatre Record) — silently double-counting that
 * one critic's verdict in the show's composite score. Fixed by merging into
 * a single london-theatre--cheryl-markosky.json.
 *
 * PART 1 (static, always runs): a synthetic-fixture unit test proving
 * findSpellingDuplicates() actually catches this shape of defect (same show
 * + same outlet, near-duplicate criticName spelling) without needing the
 * corpus checked out.
 *
 * PART 2 (the live corpus scan + KNOWN_BACKLOG) moved to
 * tests/unit/critic-spelling-duplicates-live-data.test.mjs (BRO-5729) and runs in
 * check-corpus-drift.yml.
 *
 * Run: node --test scripts/lib/critic-spelling-duplicates.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  isNearDuplicateCriticName,
  findSpellingDuplicates,
  scanReviewTextsForCriticDuplicates,
} = require('./critic-spelling-duplicates.js');

// --------------------------------------------------------- Part 1: unit tests

test('isNearDuplicateCriticName catches the Markoski/Markosky shape', () => {
  assert.equal(isNearDuplicateCriticName('Cheryl Markoski', 'Cheryl Markosky'), true);
});

test('isNearDuplicateCriticName rejects identical names', () => {
  assert.equal(isNearDuplicateCriticName('Cheryl Markosky', 'Cheryl Markosky'), false);
});

test('isNearDuplicateCriticName rejects different critics who share a surname', () => {
  assert.equal(isNearDuplicateCriticName('Markos Papadatos', 'Cheryl Markosky'), false);
  assert.equal(isNearDuplicateCriticName('Sara Holdren', 'Sara Holdren-Jones'), false);
});

test('isNearDuplicateCriticName rejects short names below the edit-distance floor', () => {
  assert.equal(isNearDuplicateCriticName('Al Ng', 'Ed Ng'), false);
});

test('findSpellingDuplicates flags a same-show/same-outlet pair but not a cross-show or cross-outlet one', () => {
  const records = [
    { showId: 'how-the-other-half-loves-west-end-2026', outletId: 'london-theatre', criticName: 'Cheryl Markoski', file: 'london-theatre--cheryl-markoski.json' },
    { showId: 'how-the-other-half-loves-west-end-2026', outletId: 'london-theatre', criticName: 'Cheryl Markosky', file: 'london-theatre--cheryl-markosky.json' },
    // Same near-duplicate spelling, but a DIFFERENT show — not a duplicate file, must not be flagged.
    { showId: 'some-other-show-west-end-2026', outletId: 'london-theatre', criticName: 'Cheryl Markosky', file: 'london-theatre--cheryl-markosky.json' },
    // Same near-duplicate spelling, same show, but a DIFFERENT outlet — must not be flagged.
    { showId: 'how-the-other-half-loves-west-end-2026', outletId: 'standard', criticName: 'Cheryl Markoski', file: 'standard--cheryl-markoski.json' },
  ];
  const findings = findSpellingDuplicates(records);
  assert.deepEqual(
    findings.map((f) => [f.showId, f.outletId, f.nameA, f.nameB]),
    [['how-the-other-half-loves-west-end-2026', 'london-theatre', 'Cheryl Markoski', 'Cheryl Markosky']],
  );
});

test('findSpellingDuplicates honors the allow list', () => {
  const records = [
    { showId: 'show-a', outletId: 'ew', criticName: 'Dave Quinn', file: 'ew--dave-quinn.json' },
    { showId: 'show-a', outletId: 'ew', criticName: 'David Quinn', file: 'ew--david-quinn.json' },
  ];
  assert.equal(findSpellingDuplicates(records).length, 1);
  const allow = new Set(['show-a::ew::Dave Quinn::David Quinn']);
  assert.equal(findSpellingDuplicates(records, { allow }).length, 0);
});

// Part 2 (the live corpus scan + KNOWN_BACKLOG) moved to
// tests/unit/critic-spelling-duplicates-live-data.test.mjs (BRO-5729): it runs in
// check-corpus-drift.yml, not the scripts/lib glob step.

test('scanReviewTextsForCriticDuplicates skips _-prefixed holding dirs (BRO-5740)', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'csd-'));
  const write = (dir, file, criticName) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, file), JSON.stringify({ outletId: 'timeout-london', criticName }));
  };
  // Two different shows' files parked in the graveyard: not one show's duplicates.
  write('_superseded-misattributed', 'show-a--timeout-london--andrjez-lukowski.json', 'Andrjez Lukowski');
  write('_superseded-misattributed', 'show-b--timeout-london--andrzej-lukowski.json', 'Andrzej Lukowski');
  // A real duplicate in a real show dir is still caught.
  write('show-c', 'timeout-london--andrjez-lukowski.json', 'Andrjez Lukowski');
  write('show-c', 'timeout-london--andrzej-lukowski.json', 'Andrzej Lukowski');
  const { findings } = scanReviewTextsForCriticDuplicates(root);
  assert.deepEqual(findings.map((f) => f.showId), ['show-c']);
  fs.rmSync(root, { recursive: true, force: true });
});
