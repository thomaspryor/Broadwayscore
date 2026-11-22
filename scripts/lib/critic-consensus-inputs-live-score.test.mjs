// The Critics' Take is written from the score the site shows, not the review-text
// file's raw assignedScore. the-dead-1904-off-broadway-2026 (2026-11-22): three
// 4/5-star reviews (live 81/80/80) produced "Critics are split ... leaves some cold"
// because one file still said 59 (the rebuild's star-band clamp lifts it to 80).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadReviewTexts, consensusFingerprint, shouldRegenerate } = require('./critic-consensus-inputs.js');

const SHOW = 'demo-show-2026';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-'));
  fs.mkdirSync(path.join(dir, SHOW));
  const files = [
    { outletId: 'culturesauce', outlet: 'Culture Sauce', criticName: 'A Critic', url: 'https://ex.com/a', assignedScore: 81 },
    { outletId: 'nysr', outlet: 'New York Stage Review', criticName: 'B Critic', url: 'https://ex.com/b', assignedScore: 79 },
    { outletId: 'nysr', outlet: 'New York Stage Review', criticName: 'C Critic', url: 'https://ex.com/c', assignedScore: 59 },
    { outletId: 'other', outlet: 'Other', criticName: 'D Critic', url: 'https://ex.com/d', assignedScore: 70 },
  ];
  for (const f of files) {
    fs.writeFileSync(path.join(dir, SHOW, `${f.outletId}--${f.criticName.toLowerCase().replace(/ /g, '-')}.json`),
      JSON.stringify({ showId: SHOW, fullText: 'Review text.', contentTier: 'complete', ...f }));
  }
  return dir;
}
const liveRows = [
  { showId: SHOW, outletId: 'culturesauce', criticName: 'A Critic', url: 'https://ex.com/a', assignedScore: 81 },
  { showId: SHOW, outletId: 'nysr', criticName: 'B Critic', url: 'https://ex.com/b', assignedScore: 80 },
  // URL changed on the live row: falls back to outlet + critic.
  { showId: SHOW, outletId: 'nysr', criticName: 'C Critic', url: 'https://ex.com/c-moved', assignedScore: 80 },
  { showId: 'another-show', outletId: 'other', criticName: 'D Critic', url: 'https://ex.com/d', assignedScore: 10 },
];

test('inputs carry the live (site) score, matched by URL then outlet+critic', () => {
  const dir = fixture();
  const rows = loadReviewTexts(SHOW, null, { reviewTextsDir: dir, liveRows });
  const by = Object.fromEntries(rows.map(r => [r.critic, r]));
  assert.equal(by['A Critic'].score, 81);
  assert.equal(by['B Critic'].score, 80);
  assert.equal(by['C Critic'].score, 80, 'the 59 file score must not reach the prompt');
  assert.equal(by['C Critic'].fileScore, 59);
  assert.equal(by['D Critic'].score, 70, 'no live twin for this show: file score kept, other shows ignored');
  const fp = consensusFingerprint(rows);
  assert.deepEqual(fp.bucketBreakdown, { positive: 4, mixed: 0, negative: 0 });
});

test('a take stored from the raw scores regenerates once live scores apply', () => {
  const dir = fixture();
  const stored = consensusFingerprint(loadReviewTexts(SHOW, null, { reviewTextsDir: dir }));
  assert.equal(stored.bucketBreakdown.mixed, 1);
  const res = shouldRegenerate(stored, loadReviewTexts(SHOW, null, { reviewTextsDir: dir, liveRows }));
  assert.equal(res.should, true, res.reason);
});

test('the generator passes reviews.json rows as liveRows', () => {
  const src = fs.readFileSync(new URL('../generate-critic-consensus.js', import.meta.url), 'utf8');
  assert.match(src, /liveRows:\s*liveReviewRows/);
});

test('ambiguous identities keep the file score (shared roundup URL, unnamed critics, excluded rows)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-amb-'));
  fs.mkdirSync(path.join(dir, SHOW));
  const files = [
    { outletId: 'wet', outlet: 'WET', criticName: 'E Critic', url: 'https://ex.com/roundup', assignedScore: 50 },
    { outletId: 'variety', outlet: 'Variety', criticName: 'Unknown', url: null, assignedScore: 42 },
    { outletId: 'nyt', outlet: 'NYT', criticName: 'F Critic', url: 'https://ex.com/f', assignedScore: 66 },
  ];
  for (const f of files) {
    fs.writeFileSync(path.join(dir, SHOW, `${f.outletId}--x.json`), JSON.stringify({ showId: SHOW, fullText: 'T.', contentTier: 'complete', ...f }));
  }
  const live = [
    // two critics share the roundup URL with different scores: ambiguous
    { showId: SHOW, outletId: 'wet', criticName: 'E Critic', url: 'https://ex.com/roundup', assignedScore: 90 },
    { showId: SHOW, outletId: 'wet', criticName: 'G Critic', url: 'https://ex.com/roundup', assignedScore: 20 },
    // two unnamed Variety rows
    { showId: SHOW, outletId: 'variety', criticName: null, url: 'https://ex.com/v1', assignedScore: 35 },
    { showId: SHOW, outletId: 'variety', criticName: null, url: 'https://ex.com/v2', assignedScore: 80 },
    // an excluded row must not claim the URL
    { showId: SHOW, outletId: 'nyt', criticName: 'F Critic', url: 'https://ex.com/f', assignedScore: 10, wrongProduction: true },
  ];
  const by = Object.fromEntries(loadReviewTexts(SHOW, null, { reviewTextsDir: dir, liveRows: live }).map(r => [r.outlet, r.score]));
  assert.equal(by.WET, 90, 'shared URL is ambiguous, but outlet+critic names E Critic uniquely');
  assert.equal(by.Variety, 42);
  assert.equal(by.NYT, 66);
});
