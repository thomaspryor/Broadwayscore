// BRO-7595: a headless dispatch receipt is posted after the job that wrote the
// RECHECK-AFTER stamp finished, so it must not keep a passing card open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./autonomous-recheck-core.js');

const NOW = new Date('2026-12-10T10:00:00Z');
const stamp = '**Session report (paused)** Landed on main. RECHECK-AFTER: 2026-12-06';
const headless = 'Dispatched 21c0d4c1 to linear:BRO-7504-mwhmqbbv at 2026-11-15T10:30:10.686Z (headless)';
const card = (comments) => ({ id: 'BRO-7504', status: 'Paused', stateType: 'backlog', notes: '', comments });
const target = { cardId: 'BRO-7504', verifyCmd: 'node --test scripts/lib/foo.test.mjs', skip: null };
const pass = { status: 'pass', detail: null };
const decide = (comments) => core.decideAutoClose({ card: card(comments), target, result: pass, now: NOW });

test('BRO-7504 shape: the run\'s own headless receipt after its stamp does not block the close', () => {
  assert.deepEqual(decide(['Claimed by local session x', stamp, headless]), { close: true, reason: 'real test passed on fresh origin/main' });
});

test('a real pickup after the stamp still blocks', () => {
  for (const after of [
    [headless, 'Claimed by https://claude.ai/code/session_x at 2026-12-07'],
    [headless, 'Dispatched 9abc to linear:BRO-7504-zz at 2026-12-08T00:00:00Z (headless)'],
    ['Dispatched 9abc to cmux:workspace:3 at 2026-12-07T00:00:00Z'],
    ['still broken, reopening'],
  ]) {
    assert.equal(decide([stamp, ...after]).close, false, JSON.stringify(after));
  }
});
