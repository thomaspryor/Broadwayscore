/**
 * RECHECK-AFTER acceptance for BRO-5501: the 2026 Times (UK) review of the West End
 * Cherry Orchard was a stub (page not fetchable) when the card paused. Asserts against
 * LIVE data/reviews.json, so a red run means the review is still missing, not a regression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REVIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'reviews.json');

test('the 2026 Times (UK) review of the West End Cherry Orchard is scored in reviews.json', () => {
  const raw = JSON.parse(fs.readFileSync(REVIEWS, 'utf8'));
  const rows = (Array.isArray(raw) ? raw : raw.reviews || []).filter(
    (r) => r.showId === 'the-cherry-orchard-west-end-2026' && /^(times-uk|thetimes|the-times)$/.test(r.outletId || ''));
  assert.ok(rows.length > 0, 'no Times (UK) row for the-cherry-orchard-west-end-2026 in reviews.json');
  assert.ok(rows.some((r) => Number.isFinite(r.assignedScore) && r.assignedScore >= 1 && r.assignedScore <= 100), 'Times row has no score');
});
