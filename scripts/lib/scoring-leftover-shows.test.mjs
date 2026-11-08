// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { showsWithUnscored } = require('./scoring-leftover-shows.js');

const FULL = 'The cast of this ghost story is superb, and the staging builds dread with real craft. '.repeat(30);
function review(showId, extra = {}) {
  return { showId, outletId: 'nytg', outlet: 'New York Theatre Guide', criticName: 'A Critic',
    url: `https://example.com/${showId}`, publishDate: '2026-11-05', fullText: FULL, isFullReview: true,
    contentTier: 'complete', textStatus: 'complete', wordCount: 400, ...extra };
}
test('flags only shows with an unscored review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-'));
  for (const id of ['unscored-show', 'scored-show', 'empty-show']) fs.mkdirSync(path.join(dir, id));
  fs.writeFileSync(path.join(dir, 'unscored-show', 'nytg--a-critic.json'), JSON.stringify(review('unscored-show')));
  fs.writeFileSync(path.join(dir, 'scored-show', 'nytg--a-critic.json'),
    JSON.stringify(review('scored-show', { llmScore: { score: 70 }, assignedScore: 70 })));
  const shows = new Map(['unscored-show', 'scored-show', 'empty-show'].map(id => [id, { id, title: id, category: 'off-broadway', status: 'open' }]));
  assert.deepEqual(showsWithUnscored(dir, ['scored-show', 'unscored-show', 'empty-show', 'missing-dir'], shows), ['unscored-show']);
});
