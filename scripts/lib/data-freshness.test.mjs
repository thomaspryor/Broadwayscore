// Guards the 2026-09-05 incident (PR #793): a 30-minute-old core-data clone
// that was 8 commits behind origin reported "Data healthy", and ~10,700 local
// tests passed against data CI would never see.
//
// CLAUDE.md §15: requires the real function — no logic copied here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BEHIND_WARN, BEHIND_LOUD, classifyDataFreshness } = require('./data-freshness.js');

test('level with origin, refs freshly fetched → trustworthy', () => {
  const r = classifyDataFreshness({ behindCount: 0, refsFetched: true });
  assert.equal(r.level, 'ok');
  assert.equal(r.trustworthy, true);
  assert.equal(r.remedy, null);
});

test('level with origin but refs NOT fetched → not trustworthy', () => {
  // The exact shape of the incident: nothing looked wrong locally because
  // nobody had asked origin. behindCount is only ever a lower bound.
  const r = classifyDataFreshness({ behindCount: 0, refsFetched: false });
  assert.equal(r.level, 'unknown');
  assert.equal(r.trustworthy, false);
  assert.match(r.message, /refs were not\s+refreshed|origin may have moved/);
  assert.ok(r.remedy);
});

test('behind by one commit is already untrustworthy', () => {
  const r = classifyDataFreshness({ behindCount: BEHIND_WARN, refsFetched: true });
  assert.equal(r.level, 'behind');
  assert.equal(r.trustworthy, false);
  assert.match(r.message, /1 commit/);
});

test('the incident distance (8 behind) reads as far-behind and says why', () => {
  const r = classifyDataFreshness({ behindCount: 8, refsFetched: true });
  assert.equal(r.level, 'far-behind');
  assert.equal(r.trustworthy, false);
  assert.equal(r.behindCount, 8);
  // The message must name the actual trap: green locally proves nothing.
  assert.match(r.message, /GREEN local test run proves nothing/);
  assert.ok(r.remedy.includes('merge --ff-only'));
});

test('BEHIND_LOUD is the far-behind boundary', () => {
  assert.equal(classifyDataFreshness({ behindCount: BEHIND_LOUD - 1, refsFetched: true }).level, 'behind');
  assert.equal(classifyDataFreshness({ behindCount: BEHIND_LOUD, refsFetched: true }).level, 'far-behind');
});

test('undeterminable distance is never reported as healthy', () => {
  for (const behindCount of [null, undefined, NaN]) {
    const r = classifyDataFreshness({ behindCount, refsFetched: true });
    assert.equal(r.level, 'unknown', `behindCount=${String(behindCount)}`);
    assert.equal(r.trustworthy, false);
  }
  // Called with no argument at all.
  assert.equal(classifyDataFreshness().level, 'unknown');
  assert.equal(classifyDataFreshness().trustworthy, false);
});
