import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { applyReviewFieldEdit, executeReviewFieldEditIn } = require('../../scripts/lib/review-field-edit.js');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');
const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOWS = ['benevolent-off-broadway-2026', 'disruption-off-broadway-2026', 'the-pass-off-broadway-2026'];
const FILE = 'la-voce-di-new-york--jk-clarke.json';
const URL = 'https://lavocedinewyork.com/en/new-york/2026/08/29/three-off-broadway-plays-to-consider-for-end-of-summer-theater-experiences/';
const stamp = { fixId: 'bro-4305', at: '2026-10-22T00:00:00.000Z' };

test('approved fixes can enable the existing joint-review fingerprint exception', () => {
  const record = { isCombinedReview: true, combinedWith: [SHOWS[0]] };
  const action = { field: 'allowCrossShowDuplicate', oldValue: null, newValue: true };
  const result = applyReviewFieldEdit(record, action, stamp);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.record.allowCrossShowDuplicate, true);
  for (const newValue of [false, null, 'true', 1]) {
    assert.equal(applyReviewFieldEdit(record, { ...action, newValue }, stamp).ok, false);
  }
  for (const invalid of [{}, { isCombinedReview: true }, { isCombinedReview: true, combinedWith: [] },
    { isCombinedReview: true, combinedWith: [''] }, { isCombinedReview: true, combinedWith: 'other-show' },
    { isCombinedReview: true, showId: SHOWS[0], combinedWith: [SHOWS[0]] },
    { isCombinedReview: false, combinedWith: [SHOWS[0]] }]) {
    assert.equal(applyReviewFieldEdit(invalid, action, stamp).ok, false, 'requires existing multi-show evidence');
  }
  assert.equal(applyReviewFieldEdit({ ...record, _locked: true }, action, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ ...record, allowCrossShowDuplicate: true }, action, stamp).ok, false, 'compare-and-set still applies');
});

test('real rebuild counts the La Voce article once under each of its three shows', { timeout: 180000 }, (t) => {
  const source = path.join(ROOT, 'data/review-texts/');
  if (!SHOWS.every(id => fs.existsSync(path.join(source, id, FILE)))) {
    t.skip('private La Voce source records are unavailable');
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(ROOT, '.bro-4305-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  // Copy code and inputs: the real rebuild normalizes review files and writes
  // derived data. Never run it against the shared private source checkout.
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(sandbox, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src/config'), path.join(sandbox, 'src/config'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
  const data = path.join(sandbox, 'data');
  fs.mkdirSync(data);
  for (const file of fs.readdirSync(path.join(ROOT, 'data'))) {
    const src = path.join(ROOT, 'data', file);
    if (file.endsWith('.json') && fs.statSync(src).isFile() && fs.statSync(src).size < 5_000_000) {
      fs.copyFileSync(src, path.join(data, file));
    }
  }
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  shows.shows = shows.shows.filter(s => SHOWS.includes(s.id));
  fs.writeFileSync(path.join(data, 'shows.json'), JSON.stringify(shows));
  const prior = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8'));
  prior.reviews = prior.reviews.filter(r => SHOWS.includes(r.showId));
  fs.writeFileSync(path.join(data, 'reviews.json'), JSON.stringify(prior));
  for (const id of SHOWS) fs.cpSync(path.join(source, id), path.join(data, 'review-texts', id), { recursive: true });

  const rebuild = () => {
    execFileSync(process.execPath, ['scripts/rebuild-all-reviews.js', '--ignore-pause', '--force-write'], {
      cwd: sandbox, timeout: 60000, maxBuffer: 8_000_000,
      env: { ...process.env, BSC_STAGE_LATENCY_MUTE: '1', REVIEW_TEXTS_DIR: path.join(data, 'review-texts') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(fs.readFileSync(path.join(data, 'reviews.json'), 'utf8')).reviews;
  };
  const before = rebuild();
  console.log(`BRO-4305 real rebuild before: ${before.filter(r => r.url === URL).map(r => `${r.showId}=${r.assignedScore}`).join(', ')}`);
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pending-fixes/bro-4305.json'), 'utf8'));
  assert.equal(plan.plan.actions.length, 3);
  for (const action of plan.plan.actions) {
    const record = JSON.parse(fs.readFileSync(path.join(data, 'review-texts', action.file), 'utf8'));
    // Keep this regression useful after CI applies the plan to private data.
    if (record[action.field] === action.newValue) continue;
    const result = executeReviewFieldEditIn(path.join(data, 'review-texts'), action, stamp);
    assert.equal(result.ok, true, result.reason);
  }
  const after = rebuild();
  for (const id of SHOWS) {
    const rows = after.filter(r => r.showId === id && r.url === URL);
    assert.equal(rows.length, 1, `${id}: expected exactly one counted review`);
    const sourceRecord = JSON.parse(fs.readFileSync(path.join(source, id, FILE), 'utf8'));
    assert.equal(rows[0].assignedScore, getBestScore(sourceRecord).score, 'preserve the source record score');
    console.log(`BRO-4305 real rebuild after: ${id}=${rows[0].assignedScore}`);
  }
  const unrelated = rows => rows.filter(r => r.url !== URL);
  assert.deepEqual(unrelated(after), unrelated(before), 'the targeted corrections must preserve every other review');
  console.log(`BRO-4305 real-data delta: ${after.length - before.length} added reviews; 0 unrelated records changed`);
  const oldScores = new Map(before.filter(r => r.url === URL).map(r => [r.showId, r.assignedScore]));
  for (const row of after.filter(r => r.url === URL)) {
    if (oldScores.has(row.showId)) assert.equal(row.assignedScore, oldScores.get(row.showId));
  }
});
