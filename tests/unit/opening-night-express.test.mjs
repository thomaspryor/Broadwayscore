// BRO-2402: Opening Night Express must retry when it finds 0 real reviews,
// including when the run itself dies in gather/collect (the likeliest outcome
// when it fires hours before an evening curtain).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  shouldRetryExpress,
  enqueueRetry,
  computeDueAt,
  DEFAULT_RETRY_DELAY_HOURS,
} = require('../../scripts/lib/express-retry-decision.js');

const WORKFLOW = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../.github/workflows/opening-night-express.yml'),
  'utf8'
);

test('first run with zero review records queues a retry', () => {
  const d = shouldRetryExpress({ reviewFiles: [], show: {}, isRetry: false });
  assert.equal(d.retry, true);
  assert.equal(d.thin, true);
});

test('retry run never re-enqueues, even when still empty', () => {
  const d = shouldRetryExpress({ reviewFiles: [], show: {}, isRetry: true });
  assert.equal(d.retry, false);
  assert.equal(d.thin, true);
});

test('retry from a 5-9am ET fire lands in the evening review window', () => {
  // 08:00 UTC fire (+ up to 3h cron delay) -> due 00:00-03:00 UTC next day,
  // i.e. 8pm-11pm ET (EDT), after an evening curtain.
  const due = new Date(computeDueAt('2026-10-05T08:00:00.000Z', DEFAULT_RETRY_DELAY_HOURS));
  assert.equal(due.toISOString(), '2026-10-06T00:00:00.000Z');
});

test('enqueueRetry is idempotent while one is outstanding', () => {
  const nowIso = '2026-10-05T08:00:00.000Z';
  const a = enqueueRetry([], { showId: 's', market: 'broadway', nowIso });
  const b = enqueueRetry(a.entries, { showId: 's', market: 'broadway', nowIso });
  assert.equal(a.changed, true);
  assert.equal(b.changed, false);
});

test('workflow queues the retry even when gather/collect fail (BRO-2402)', () => {
  const m = WORKFLOW.match(
    /- name: Queue same-night retry after failed run\n([\s\S]*?)\n      - name: /
  );
  assert.ok(m, 'failure-path retry step missing from opening-night-express.yml');
  const step = m[1];
  assert.match(step, /if: \(failure\(\) \|\| cancelled\(\)\) && inputs\.dry_run != true && steps\.show_meta\.outcome == 'success'/);
  assert.match(step, /alert-ledger\.json/);
  assert.match(step, /express-retry-queue\.js evaluate/);
  assert.match(step, /git add data\/audit\/express-retry-queue\.json/);
  assert.match(step, /push-with-retry\.sh/);
});
