/**
 * duplicate-text-cycle.test.mjs — BRO-5907.
 *
 * A cycle made only of duplicateTextOf pointers (A -> B -> C -> A) had two
 * blind spots:
 *  - rebuild-all-reviews.js only had a one-hop tiebreak for duplicateTextOf,
 *    so in a 3-cycle every member took the plain "duplicate of an includable
 *    reference" branch and was skipped as skippedDuplicateText: the review
 *    vanished from the site.
 *  - audit-duplicate-of-url-mismatch.js walked cycles only from files with a
 *    duplicateOf, so a pure duplicateTextOf cycle was never reported.
 *
 * Requires the REAL scripts/lib modules (CLAUDE.md rule 15) and runs the real
 * rebuild and audit on a fixture show dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const { duplicateTextOfDecision } = require('../lib/duplicate-of-exclusion.js');
const { cycleTiebreakFor } = require('../lib/duplicate-cycle.js');
const { computeContentFingerprint } = require('../lib/content-quality.js');

const SHOW = 'paranormal-activity-2026';
const TEXT = Array.from({ length: 16 }, (_, i) =>
  `The haunted house at the August Wilson Theatre keeps finding new ways to unsettle its audience, and paragraph ${i} of this syndicated review of Paranormal Activity on Broadway describes how the stagecraft builds dread.`).join('\n\n');
const rec = (outletId, outlet, critic, next) => ({
  showId: SHOW, outletId, outlet, criticName: critic, publishDate: '2026-08-25', source: 'web-search',
  url: `https://www.${outletId}.com/2026/08/25/review-paranormal-activity/`,
  fullText: TEXT, assignedScore: 80, llmScore: { score: 80, confidence: 'high' },
  duplicateTextOf: next,
});
// a -> b -> c -> a, all the same text
const CYCLE3 = {
  'alphareview--ann-alpha.json': rec('alphareview', 'Alpha Review', 'Ann Alpha', 'betareview--bob-beta.json'),
  'betareview--bob-beta.json': rec('betareview', 'Beta Review', 'Bob Beta', 'gammareview--cy-gamma.json'),
  'gammareview--cy-gamma.json': rec('gammareview', 'Gamma Review', 'Cy Gamma', 'alphareview--ann-alpha.json'),
};

const reader = (files) => (n) => (files[n] ? files[n] : null);
const decide = (file, files, extra = {}) => {
  const data = files[file];
  const ref = files[data.duplicateTextOf];
  const isCircular = ref.duplicateTextOf === file;
  return duplicateTextOfDecision({
    staleFlag: false, refAlsoDupe: !!ref.duplicateOf, refExcluded: false, isCircular,
    circularSameText: isCircular, refInheritedFlag: null, file, target: data.duplicateTextOf,
    nCycle: isCircular ? null : cycleTiebreakFor(file, data, reader(files), Object.keys(files).length, computeContentFingerprint),
    ...extra,
  });
};

// ---- pure decision ---------------------------------------------------------

test('3-cycle: exactly one member survives, the others take the circular tiebreak', () => {
  const out = Object.keys(CYCLE3).map(f => [f, decide(f, CYCLE3)]);
  assert.deepEqual(out, [
    ['alphareview--ann-alpha.json', null],
    ['betareview--bob-beta.json', 'skippedCircularDuplicateTiebreak'],
    ['gammareview--cy-gamma.json', 'skippedCircularDuplicateTiebreak'],
  ]);
});

test('3-cycle with different texts is not collapsed: members stay plain duplicates', () => {
  const files = structuredClone(CYCLE3);
  files['gammareview--cy-gamma.json'].fullText = TEXT.replace(/haunted/g, 'cursed').replace(/dread/g, 'terror');
  const t = cycleTiebreakFor('alphareview--ann-alpha.json', files['alphareview--ann-alpha.json'], reader(files), 3, computeContentFingerprint);
  assert.equal(t.inCycle, true);
  assert.equal(t.sameText, false);
  assert.equal(decide('alphareview--ann-alpha.json', files), 'skippedDuplicateText');
});

test('a tail pointing into a cycle stays a plain duplicate', () => {
  const files = { ...structuredClone(CYCLE3), 'deltareview--dee-delta.json': rec('deltareview', 'Delta Review', 'Dee Delta', 'alphareview--ann-alpha.json') };
  const t = cycleTiebreakFor('deltareview--dee-delta.json', files['deltareview--dee-delta.json'], reader(files), 4, computeContentFingerprint);
  assert.equal(t.cycleFound, true);
  assert.equal(t.inCycle, false);
  assert.equal(decide('deltareview--dee-delta.json', files), 'skippedDuplicateText');
});

test('2-cycle keeps its one-hop tiebreak (lexicographically larger name drops)', () => {
  const files = {
    'alphareview--ann-alpha.json': rec('alphareview', 'Alpha Review', 'Ann Alpha', 'betareview--bob-beta.json'),
    'betareview--bob-beta.json': rec('betareview', 'Beta Review', 'Bob Beta', 'alphareview--ann-alpha.json'),
  };
  assert.equal(decide('alphareview--ann-alpha.json', files), null);
  assert.equal(decide('betareview--bob-beta.json', files), 'skippedCircularDuplicateTiebreak');
});

test('a plain one-way duplicate is still skipped, and a stale pointer still passes', () => {
  const files = {
    'alphareview--ann-alpha.json': { ...rec('alphareview', 'Alpha Review', 'Ann Alpha', undefined) },
    'betareview--bob-beta.json': rec('betareview', 'Beta Review', 'Bob Beta', 'alphareview--ann-alpha.json'),
  };
  assert.equal(decide('betareview--bob-beta.json', files), 'skippedDuplicateText');
  assert.equal(decide('betareview--bob-beta.json', files, { staleFlag: true }), null);
});

// ---- end to end: the real rebuild and audit --------------------------------

function mkTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5907-'));
  const dir = path.join(root, 'review-texts', SHOW);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), JSON.stringify(d, null, 2));
  return { root, texts: path.join(root, 'review-texts') };
}

const showsJson = path.join(ROOT, 'data', 'shows.json');
const haveShow = fs.existsSync(showsJson) && fs.readFileSync(showsJson, 'utf8').includes(`"${SHOW}"`);

test('rebuild: a pure duplicateTextOf 3-cycle ships exactly one review', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const { root, texts } = mkTree(CYCLE3);
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), `--show=${SHOW}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REBUILD_REVIEW_TEXTS_DIR: texts, REBUILD_EXCLUSION_AUDIT_DIR: path.join(root, 'audit') },
  });
  const included = Number((/(\d+) review\(s\) would be included/.exec(out) || [])[1]);
  const excluded = (out.match(/\[EXCLUSION\] (\{.*\})/g) || []).map(l => JSON.parse(l.slice(12)));
  assert.equal(included, 1);
  assert.deepEqual(excluded.map(e => [e.file, e.reason]).sort(), [
    ['betareview--bob-beta.json', 'skippedCircularDuplicateTiebreak'],
    ['gammareview--cy-gamma.json', 'skippedCircularDuplicateTiebreak'],
  ]);
});

test('audit: a pure duplicateTextOf cycle is reported for every member', () => {
  const { texts } = mkTree(CYCLE3);
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'audit-duplicate-of-url-mismatch.js'), '--json'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, REVIEW_TEXTS_DIR: texts },
  });
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  const cycles = json.mismatches.filter(m => m.reason === 'duplicateOf-cycle');
  assert.deepEqual(cycles.map(m => [m.file, m.field]).sort(), Object.keys(CYCLE3).map(f => [f, 'duplicateTextOf']));
});

test('audit: a duplicateTextOf tail into a cycle is not reported as a cycle member', () => {
  const { texts } = mkTree({ ...CYCLE3, 'deltareview--dee-delta.json': rec('deltareview', 'Delta Review', 'Dee Delta', 'alphareview--ann-alpha.json') });
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'audit-duplicate-of-url-mismatch.js'), '--json'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, REVIEW_TEXTS_DIR: texts },
  });
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  const files = json.mismatches.filter(m => m.reason === 'duplicateOf-cycle').map(m => m.file).sort();
  assert.deepEqual(files, Object.keys(CYCLE3));
});
