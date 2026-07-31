import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSeed } = require('../../scripts/bsc-next.js');

// Owner mandate (task #672, 2026-07-30): every review gate (finish-line-gate,
// pre-push-review-gate) fires at Stop/push, AFTER the code already exists —
// sunk cost then argues for shipping instead of rethinking. A PreToolUse hook
// can't fix this: it can't tell "user asked for X" from "agent noticed X"
// (see card #672 for why that approach was rejected). The only place session
// provenance is known is at dispatch time, so the rule has to live in the
// seed prompt buildSeed() produces — this test proves it's actually there.
const TASK = { id: '672', subject: 'Some card', status: 'pending', description: '[notion:aaa] x' };
const CARD = { url: 'https://n/x', notes: 'card notes', priority: 'P0' };

test('dispatch prompt tells the session to run /second-opinion or /plan-review before implementing a self-discovered follow-on', () => {
  const seed = buildSeed(TASK, CARD, 'Infra', 'sonnet');
  assert.match(seed, /\/second-opinion/);
  assert.match(seed, /\/plan-review/);
  assert.match(seed, /before implementing it, not after/i);
});

test('dispatch prompt explicitly exempts the work directly requested on the card', () => {
  const seed = buildSeed(TASK, CARD, 'Infra', 'sonnet');
  assert.match(seed, /work on THIS card is pre-scoped/i);
});

test('review rule survives across card/no-card and project/no-project variants', () => {
  const withCard = buildSeed(TASK, CARD, 'Infra', 'sonnet');
  const withoutCard = buildSeed({ id: '9', subject: 'S', status: 'pending', description: 'd' }, null);
  for (const seed of [withCard, withoutCard]) {
    assert.match(seed, /\/second-opinion/);
    assert.match(seed, /pre-scoped/i);
  }
});
