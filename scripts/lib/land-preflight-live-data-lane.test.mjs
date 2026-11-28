import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { liveDataLaneCheck, liveDataLaneSkipWarning } from './land-preflight.mjs';

test('preflight invokes the changed-test lane and reports undeclared live reads', () => {
  const root = process.cwd();
  let invocation;
  const result = liveDataLaneCheck({ root, env: {}, budgetMs: 100000, seams: {
    run: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 1, stdout: '::error::scripts/lib/example.test.mjs reads live data (data/shows.json)\n' };
    },
  } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [path.join(root, 'scripts/live-data-lane.js'), '--verify-changed', '--refuse-undeclared', '--base=origin/main']);
  assert.equal(invocation.options.cwd, root);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /example\.test\.mjs reads live data/);
});


test('a skipped live-data-lane check warns with reason and manual command (BRO-8293)', () => {
  const w = liveDataLaneSkipWarning({ status: 'skip', reason: 'uncommitted tracked changes: x\nsecond line' });
  assert.match(w, /NOT checked/);
  assert.match(w, /uncommitted tracked changes: x\)/);
  assert.doesNotMatch(w, /second line/);
  assert.match(w, /live-data-lane\.js --verify-changed --refuse-undeclared --base=origin\/main/);
});

test('silent when off, clean, fail, already refused, or the trace-incomplete warning exists', () => {
  assert.equal(liveDataLaneSkipWarning({ status: 'off', reason: 'x' }), null);
  assert.equal(liveDataLaneSkipWarning({ status: 'clean' }), null);
  assert.equal(liveDataLaneSkipWarning({ status: 'fail', message: 'm' }), null);
  assert.equal(liveDataLaneSkipWarning({ status: 'skip', reason: 'already refused' }), null);
  assert.equal(liveDataLaneSkipWarning({ status: 'skip', reason: 'trace incomplete', warning: 'w' }), null);
  assert.equal(liveDataLaneSkipWarning(null), null);
});

test('reason is trimmed, capped, and never empty; a missing script stays silent (BRO-8293)', () => {
  assert.match(liveDataLaneSkipWarning({ status: 'skip', reason: '\n  errored: boom' }), /skipped \(errored: boom\)/);
  assert.match(liveDataLaneSkipWarning({ status: 'skip', reason: '' }), /skipped \(unknown\)/);
  assert.ok(liveDataLaneSkipWarning({ status: 'skip', reason: 'x'.repeat(500) }).length < 420);
  assert.equal(liveDataLaneSkipWarning({ status: 'skip', reason: 'live-data-lane.js --refuse-undeclared not in this tree' }), null);
  assert.match(liveDataLaneSkipWarning({ status: 'skip', reason: 'r' }, 'origin/dev'), /--base=origin\/dev/);
});
