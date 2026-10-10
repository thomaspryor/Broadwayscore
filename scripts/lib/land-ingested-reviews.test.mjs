// BRO-4908: a single-URL ingest left reviews unscored because nothing pushed
// the file or dispatched scoring. Locks push-before-dispatch and that a failed
// push never dispatches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { landIngestedReviews } = require('./land-ingested-reviews.js');

const base = { showId: 'rent-west-end-2026', reviewTextsDir: '/rt', touchedPaths: ['/rt/rent-west-end-2026/a.json'], newReviews: 1, message: 'm', log: () => {} };

test('pushes before dispatching scoring, scoped to the show', () => {
  const calls = [];
  const exec = (cmd) => { calls.push(cmd); return cmd.includes('status --porcelain') ? 'A  x' : ''; };
  const r = landIngestedReviews({ ...base, exec, only: ['llm-ensemble-score.yml'] });
  const pushIdx = calls.findIndex((c) => c.includes(' push origin main'));
  const dispIdx = calls.findIndex((c) => c.startsWith('gh workflow run llm-ensemble-score.yml -f show_id=rent-west-end-2026'));
  assert.ok(pushIdx >= 0 && dispIdx > pushIdx);
  assert.equal(calls.filter((c) => c.startsWith('gh workflow run')).length, 1);
  assert.deepEqual(r.dispatched.map((d) => d.ok), [true]);
});

test('failed push never dispatches', () => {
  const exec = (cmd) => { if (cmd.includes(' push origin main')) throw new Error('rejected'); return 'A  x'; };
  const calls = [];
  const r = landIngestedReviews({ ...base, exec: (c, o) => { calls.push(c); return exec(c, o); } });
  assert.equal(r.push.pushed, false);
  assert.equal(r.dispatched.length, 0);
  assert.ok(!calls.some((c) => c.startsWith('gh workflow run')));
});

test('clean tree with an earlier unpushed local commit still pushes', () => {
  const calls = [];
  const exec = (cmd) => { calls.push(cmd); if (cmd.includes('status --porcelain')) return ''; if (cmd.includes('rev-list')) return '1\n'; return ''; };
  const r = landIngestedReviews({ ...base, exec, only: ['llm-ensemble-score.yml'] });
  assert.ok(calls.some((c) => c.includes(' push origin main')));
  assert.equal(r.dispatched.length, 1);
});

test('multi-show fan-out dispatches scoring per child show', () => {
  const calls = [];
  const exec = (cmd) => { calls.push(cmd); return cmd.includes('status --porcelain') ? 'A  x' : ''; };
  const r = landIngestedReviews({ ...base, exec, extraShowIds: ['other-show'], only: ['llm-ensemble-score.yml'] });
  assert.equal(r.dispatched.length, 2);
  assert.ok(calls.some((c) => c.includes('show_id=other-show')));
});
