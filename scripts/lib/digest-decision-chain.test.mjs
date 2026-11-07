// BRO-5099: a queued alert must survive the whole trip to the morning email —
// queueDigestLine -> alert-digest-queue.json -> health-check.js snapshot ->
// planAutofix -> keepDecisionQueued. The snapshot step used to drop
// conditionKey/decision, so no decision row ever reached "Needs your
// attention" and every one went to the auto-fix path instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-chain-'));
process.env.ALERT_DIGEST_QUEUE_PATH = path.join(tmp, 'alert-digest-queue.json');

const router = require('./owner-alert-router.js');
const { planAutofix, keepDecisionQueued } = require('./digest-autofix.js');

const MEZZ_TITLE = 'Mezzanine Scraper Failed — Session Token Expired';

function queueThreeRows() {
  router.clearDigestQueue();
  router.queueDigestLine({
    conditionKey: 'mezzanine:session-token-expired', title: MEZZ_TITLE,
    description: 'The Mezzanine audience update failed with an authentication error.',
    severity: 'error', decision: true,
    decisionPrompt: `${MEZZ_TITLE}: renew MEZZANINE_SESSION_TOKEN.`,
  });
  router.queueDigestLine({
    conditionKey: 'review-gap:some-show', title: 'Review gap on Some Show',
    description: 'Aggregator lists 9 reviews, we have 7.', severity: 'warn',
  });
  router.queueDigestLine({
    conditionKey: 'review-gap:other-show', title: 'Review gap on Other Show (still open — BRO-1234)',
    description: 'Still firing after 20 notifications since it was filed.', severity: 'warn',
    tracked: 'BRO-1234',
  });
  // What health-check.js writes into health-digest-snapshot.json and
  // send-morning-digest.js reads back (a JSON round trip, like the real file).
  return JSON.parse(JSON.stringify(router.peekDigestQueue().map(router.toSnapshotQueuedRow)));
}

test('a decision row reaches "Needs your attention"; plain and tracked rows do not', () => {
  const queued = queueThreeRows();
  const plan = planAutofix({ health: { errors: [], warns: [] }, tasks: [], queued });
  const byKey = Object.fromEntries(plan.map(r => [r.conditionKey, r]));

  assert.equal(byKey['mezzanine:session-token-expired'].state, 'decision');
  assert.equal(byKey['review-gap:other-show'].state, 'tracked', 'a router notice for a carded condition files nothing');
  assert.equal(byKey['review-gap:other-show'].taskId, 'linear:BRO-1234');
  assert.ok(!['decision', 'tracked'].includes(byKey['review-gap:some-show'].state), 'an ordinary row still goes to auto-fix');

  const kept = keepDecisionQueued(queued, plan);
  assert.deepEqual(kept.map(q => q.conditionKey), ['mezzanine:session-token-expired']);
  assert.match(kept[0].decisionPrompt, /MEZZANINE_SESSION_TOKEN/);
});

test('the snapshot row keeps every field queueDigestLine writes (except queuedAt)', () => {
  queueThreeRows();
  const raw = router.peekDigestQueue()[0];
  const snap = router.toSnapshotQueuedRow(raw);
  for (const k of Object.keys(raw).filter(k => k !== 'queuedAt')) {
    assert.ok(router.DIGEST_ROW_FIELDS.includes(k), `DIGEST_ROW_FIELDS is missing "${k}"`);
    assert.deepEqual(snap[k], raw[k], `snapshot dropped or changed "${k}"`);
  }
});

test('health-check.js builds the snapshot rows with toSnapshotQueuedRow', () => {
  const src = fs.readFileSync(new URL('../health-check.js', import.meta.url), 'utf8');
  assert.match(src, /queued:\s*queuedDigestItems\.map\(toSnapshotQueuedRow\)/,
    'health-check.js must not hand-copy queued fields again (the BRO-5099 bug)');
});

test('the Mezzanine token alerts are decisions whose prompt names the alert', () => {
  const yml = fs.readFileSync(new URL('../../.github/workflows/update-mezzanine.yml', import.meta.url), 'utf8');
  const blocks = yml.split("conditionKey: 'mezzanine:session-token-expired'").slice(1);
  assert.equal(blocks.length, 3, 'scraper, resolver and catalog refresh all raise it');
  for (const b of blocks) {
    const title = /title: '([^']+)'/.exec(b)[1];
    assert.match(b.slice(0, 900), /decision: true/, `${title} is not marked decision: true`);
    const prompt = /decisionPrompt: '([^']+)'/.exec(b)[1];
    assert.equal(router.headStandsAlone(prompt, title).ok, true, `${title} prompt would clip without naming the alert`);
  }
});
