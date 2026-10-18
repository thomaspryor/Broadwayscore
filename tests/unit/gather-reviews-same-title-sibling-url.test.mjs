// TESTS-VS-DERIVED-DATA-EXEMPT: reads data/shows.json only for the set of show ids to skip when absent; asserts nothing about its contents
// BRO-5298: gather-reviews createReviewFile (its own write chokepoint, not a
// caller of review-file-writer) refuses an UNDATED review whose url a
// same-title sibling production already holds, through the same
// sameTitleSiblingUrlRefusal verdict the writer's Guard A2 uses.
//
// Real ids (leopoldstadt-west-end-2020 / -2021, the incident pair) because
// gather builds its sibling index from data/shows.json; skipped when the
// core data is absent. All writes go to a temp REVIEW_TEXTS_DIR (BRO-3112).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OLD = 'leopoldstadt-west-end-2020';
const NEW = 'leopoldstadt-west-end-2021';
let hasPair = false;
try {
  const ids = new Set(require('../../data/shows.json').shows.map((s) => s.id));
  hasPair = ids.has(OLD) && ids.has(NEW);
} catch { /* no core data */ }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5298-gather-'));
process.env.REVIEW_TEXTS_DIR = DIR;
const URL = 'https://www.thetimes.co.uk/article/theatre-review-leopoldstadt-wyndhams-theatre-g7nzn7tcv';
const OPTS = { allowWestEnd: true };

function seed(extra = {}) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, OLD), { recursive: true });
  fs.writeFileSync(path.join(DIR, OLD, 'times-uk--clive-davis.json'), JSON.stringify({
    showId: OLD, outletId: 'times-uk', outlet: 'The Times', criticName: 'Clive Davis', url: URL, source: 'theatre-record', ...extra,
  }, null, 2));
}
const row = (extra = {}) => ({
  outlet: 'The Times', outletId: 'times-uk', criticName: 'Clive Davis', url: URL, publishDate: null,
  showScoreExcerpt: 'A masterwork.', source: 'show-score-playwright', ...extra,
});
const newFiles = () => { try { return fs.readdirSync(path.join(DIR, NEW)); } catch { return []; } };

test('gather refuses an undated row whose url the same-title sibling holds', { skip: !hasPair && 'core data absent' }, () => {
  const { createReviewFile } = require('../../scripts/gather-reviews.js');
  seed();
  assert.equal(createReviewFile(NEW, row(), OPTS), 'sameTitleSiblingUrl');
  assert.deepEqual(newFiles(), []);
});

test('gather writes a dated row with its own url', { skip: !hasPair && 'core data absent' }, () => {
  const { createReviewFile } = require('../../scripts/gather-reviews.js');
  seed();
  const r = createReviewFile(NEW, row({ criticName: 'Dominic Maxwell', url: 'https://www.thetimes.co.uk/article/leopoldstadt-review-wyndhams-return-zz5298', publishDate: '2021-08-09' }), OPTS);
  assert.equal(r, true);
  assert.deepEqual(newFiles(), ['times-uk--dominic-maxwell.json']);
});

test('gather guard stands aside when the sibling copy is a duplicate pointer', { skip: !hasPair && 'core data absent' }, () => {
  const { createReviewFile } = require('../../scripts/gather-reviews.js');
  seed({ duplicateTextOf: 'times-uk--other.json' });
  // The guard stands aside; gather's older first-writer-wins URL-index check
  // (undated row, so no re-home) is what refuses it, as it did before BRO-5298.
  assert.equal(createReviewFile(NEW, row(), OPTS), 'crossShow');
});

test('gather exempts a sibling in the url-slug reroute chain (_crossShowVisited)', { skip: !hasPair && 'core data absent' }, () => {
  const { createReviewFile } = require('../../scripts/gather-reviews.js');
  seed();
  // Guard stands aside for the reroute origin; the URL-index check then decides.
  assert.equal(createReviewFile(NEW, row(), { ...OPTS, _crossShowVisited: new Set([OLD]) }), 'crossShow');
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
