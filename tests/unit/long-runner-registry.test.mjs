/**
 * Regression test for the WE long-runner classifier.
 *
 * Motivation: WE long-runner CV hardening card 34c637c5-416f-812b issue #3.
 * CV was flagging legitimate pre-2015 reviews as wrongProduction because
 * publishDate-vs-openingDate distance looked suspicious. The classifier
 * gates a prompt adjustment that tells the LLM "this is continuous-run,
 * don't flag on date math alone."
 *
 * Includes a parity test (see memory/feedback_refactor_parity_test.md): the
 * extracted classifier must match the pre-extraction inline logic in
 * rebuild-all-reviews.js:771 against real shows.json data. Any diff is a
 * behavior change that could silently re-introduce or drop 90-day
 * pre-opening guard rows.
 *
 * Run: node --test tests/unit/long-runner-registry.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  isLongRunningProduction,
  buildLongRunnerSet,
  LONG_RUN_CUTOFF_YEAR,
  ID_YEAR_GAP_THRESHOLD,
} = require('../../scripts/lib/long-runner-registry.js');

test('Mousetrap (opened 1952) is a long-runner', () => {
  const show = { id: 'the-mousetrap-west-end-2021', category: 'west-end', openingDate: '1952-11-25' };
  assert.equal(isLongRunningProduction(show), true);
});

test('Phantom WE (1986 ID, 1986 openingDate post-issue-#1) is a long-runner', () => {
  const show = { id: 'the-phantom-of-the-opera-west-end-1986', category: 'west-end', openingDate: '1986-10-09' };
  assert.equal(isLongRunningProduction(show), true);
});

test('Les Mis WE (2021 ID, 1985 openingDate post-issue-#1) is a long-runner', () => {
  const show = { id: 'les-miserables-west-end-2021', category: 'west-end', openingDate: '1985-12-04' };
  assert.equal(isLongRunningProduction(show), true);
});

test('Mamma Mia WE (1999 opening) is a long-runner', () => {
  const show = { id: 'mamma-mia-west-end-2021', category: 'west-end', openingDate: '1999-04-06' };
  assert.equal(isLongRunningProduction(show), true);
});

test('Phantom WE pre-issue-#1 drift case (ID=1986, openingDate=2021 COVID reopen) still flagged via idYear rule', () => {
  const show = { id: 'the-phantom-of-the-opera-west-end-1986', category: 'west-end', openingDate: '2021-08-10' };
  assert.equal(isLongRunningProduction(show), true,
    'ID-year rule must catch data drift — would have saved us from pre-fix flagging 22 reviews');
});

test('Recent WE show (2023 opening) is NOT a long-runner', () => {
  const show = { id: 'operation-mincemeat-west-end-2023', category: 'west-end', openingDate: '2023-05-18' };
  assert.equal(isLongRunningProduction(show), false);
});

test('Off-West-End shows are eligible under the same rules', () => {
  const show = { id: 'old-ob-show-2014', category: 'off-west-end', openingDate: '2014-03-10' };
  assert.equal(isLongRunningProduction(show), true);
});

test('Broadway long-runners are NOT flagged (classifier is WE-only by design)', () => {
  const show = { id: 'phantom-of-the-opera-1988', category: 'broadway', openingDate: '1988-01-26' };
  assert.equal(isLongRunningProduction(show), false,
    'Broadway revival handling lives elsewhere; do not conflate the two');
});

test('Off-Broadway + NYC shows are NOT flagged', () => {
  const show = { id: 'stomp-1994', category: 'off-broadway', openingDate: '1994-02-27' };
  assert.equal(isLongRunningProduction(show), false);
});

test('Missing openingDate returns false (defensive)', () => {
  const show = { id: 'some-we-show-2010', category: 'west-end', openingDate: null };
  assert.equal(isLongRunningProduction(show), false);
});

test('Null / undefined / malformed inputs return false without throwing', () => {
  assert.equal(isLongRunningProduction(null), false);
  assert.equal(isLongRunningProduction(undefined), false);
  assert.equal(isLongRunningProduction({}), false);
  assert.equal(isLongRunningProduction({ category: 'west-end' }), false);
  assert.equal(isLongRunningProduction({ category: 'west-end', openingDate: 'not-a-date' }), false);
});

test('Constants match what rebuild-all-reviews.js historically used', () => {
  assert.equal(LONG_RUN_CUTOFF_YEAR, 2015);
  assert.equal(ID_YEAR_GAP_THRESHOLD, 5);
});

test('buildLongRunnerSet produces the same Set the old inline loop would have', () => {
  const shows = [
    { id: 'a-west-end-2010', category: 'west-end', openingDate: '2010-01-01' },
    { id: 'b-west-end-2023', category: 'west-end', openingDate: '2023-01-01' },
    { id: 'c-broadway-1960', category: 'broadway', openingDate: '1960-01-01' },
    { id: 'd-off-west-end-1999', category: 'off-west-end', openingDate: '1999-01-01' },
  ];
  const set = buildLongRunnerSet(shows);
  assert.ok(set.has('a-west-end-2010'));
  assert.ok(!set.has('b-west-end-2023'));
  assert.ok(!set.has('c-broadway-1960'));
  assert.ok(set.has('d-off-west-end-1999'));
});

test('parity check against real shows.json (skipped if data symlink missing)', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const showsPath = path.resolve(__dirname, '../../data/shows.json');
  if (!fs.existsSync(showsPath)) {
    // Worktree without data symlink (known gotcha: memory/feedback_worktree_script_data_paths.md)
    return;
  }
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = data.shows || data;

  // Re-implement the OLD inline logic from rebuild-all-reviews.js:771 exactly.
  const { isLondonMarket } = require('../../scripts/lib/venue-classification.js');
  const oldSet = new Set();
  for (const s of shows) {
    if (isLondonMarket(s.category) && s.openingDate) {
      const openYear = new Date(s.openingDate).getFullYear();
      const idYearMatch = s.id.match(/(\d{4})$/);
      const idYear = idYearMatch ? parseInt(idYearMatch[1]) : null;
      if (openYear < 2015 || (idYear && idYear < 2015 && openYear - idYear > 5)) {
        oldSet.add(s.id);
      }
    }
  }
  const newSet = buildLongRunnerSet(shows);

  const onlyOld = [...oldSet].filter((x) => !newSet.has(x));
  const onlyNew = [...newSet].filter((x) => !oldSet.has(x));
  assert.deepEqual(onlyOld, [], `New classifier is missing shows the old logic flagged: ${onlyOld.join(', ')}`);
  assert.deepEqual(onlyNew, [], `New classifier flags shows the old logic did not: ${onlyNew.join(', ')}`);
});
