import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { isMainRedBranch } = require('./land-main-red.js');
const { decideSweep } = require('./land-queue-backoff.js');

const NOW = Date.parse('2026-10-11T22:00:00Z');
const min = (m) => new Date(NOW - m * 60000).toISOString();
const run = (id, branch, o = {}) => ({ id, head_branch: branch, head_sha: `sha${id}`, status: 'completed', conclusion: 'success', run_attempt: 1, created_at: min(30), updated_at: min(30), path: '.github/workflows/land.yml', ...o });
const MR = 'land/main-red-bro-5079-test-fix';

test('isMainRedBranch only matches land/** branches naming main-red', () => {
  assert.equal(isMainRedBranch(MR), true);
  assert.equal(isMainRedBranch('land/bro-5079-fix'), false);
  assert.equal(isMainRedBranch('main-red'), false);
});

// Replay of 2026-10-11: BRO-5079's main-red lane was stranded behind ordinary
// lanes; the sweep must re-run it first.
test('replay 2026-10-11: sweep prefers the stranded main-red lane', () => {
  const stranded = run(38171633112, MR, { conclusion: 'cancelled', updated_at: min(40), created_at: min(100) });
  const ordinary = run(555, 'land/bro-5000-old', { conclusion: 'cancelled', updated_at: min(90), created_at: min(200) });
  const refs = new Map([[MR, stranded.head_sha], ['land/bro-5000-old', ordinary.head_sha]]);
  const d = decideSweep({ cancelledRuns: [ordinary, stranded], refs, now: NOW });
  assert.equal(d.action, 'inspect');
  assert.equal(d.candidates[0].id, stranded.id, 'main-red lane is re-run before an older ordinary lane');
});

// BRO-5194: an in-runner sleep-poll job between Checks and Land held ~6 runners
// and starved test.yml on main. Main-red priority lives in the mutex ticket.
test('workflow wiring: no sleep-poll admit job; Land needs only checks; main-red tickets sort first', () => {
  const y = readFileSync(new URL('../../.github/workflows/land.yml', import.meta.url), 'utf8');
  assert.ok(!/\n  admit:/.test(y), 'no admit job (BRO-5194)');
  assert.ok(!/land-admit/.test(y));
  assert.match(y, /\n  land:\n    name: Land\n    needs: checks\n    if: \$\{\{ !cancelled\(\) && needs\.checks\.result == 'success' \}\}/);
  const { ticketName } = require('./land-mutex.js');
  const t = (mainRed) => ticketName({ mainRed, enqueuedAt: 1, runId: '1', attempt: 1 });
  assert.ok(t(true) < t(false), 'main-red ticket sorts ahead of an ordinary one');
});
