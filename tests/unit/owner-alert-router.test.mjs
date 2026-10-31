// BRO-4950: keep the card's acceptance command wired to the real router suite.
// It exercises Linear filing, dedupe logging and ledger persistence without
// making network calls or writing to the production ledger.
import '../../scripts/lib/owner-alert-router.test.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideDigestEscalation } = require('../../scripts/lib/owner-alert-router.js');
const now = Date.parse('2026-10-21T12:00:00Z');

for (const cardId of [null, undefined]) {
  test(`BRO-4950: linearIdentifier tracks repeated alerts when cardId is ${cardId}`, () => {
    const existing = {
      linearIdentifier: 'BRO-4950',
      lastSurfacedAt: new Date(now).toISOString(),
      ...(cardId === undefined ? {} : { cardId }),
    };
    assert.deepEqual(decideDigestEscalation({
      conditionKey: 'review-gap:example', existing, notifyCount: 30, now,
    }), { action: 'quiet' });
    assert.deepEqual(decideDigestEscalation({
      conditionKey: 'review-gap:example',
      existing: { ...existing, linearIdentifier: null }, notifyCount: 30, now,
    }), { action: 'promote' });
    assert.deepEqual(decideDigestEscalation({
      conditionKey: 'bd-circuit-breaker-serp_api1', existing, notifyCount: 30, now,
    }), { action: 'resurface', neverQuiet: true });
  });
}
