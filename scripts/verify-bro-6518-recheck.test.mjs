/**
 * verify-bro-6518-recheck.test.mjs: RECHECK-AFTER acceptance for BRO-6518
 * (Chicago local shows from theatreinchicago.com, 2021 to now).
 *
 * Asserts against LIVE core data, not a fixture. On 2026-11-01 the ingest was
 * complete (753 shows, 5,735 of 5,954 listed reviews in review-texts) but 1,368
 * reviews still waited for the 6-hourly batch scoring, so 595 shows showed a
 * score. Once scoring has caught up, 700+ should: 13 shows have fewer than three
 * usable reviews and stay unscored by design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKABLE_FROM = Date.parse('2026-11-03T00:00:00Z');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

test('Chicago local shows: 700+ carry a score once batch scoring has caught up', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-03',
}, () => {
  const d = read('shows.json');
  const chicago = (Array.isArray(d) ? d : d.shows).filter((s) => s.discoverySource === 'theatreinchicago');
  assert.ok(chicago.length >= 740, `expected ~753 Chicago local shows, found ${chicago.length}`);
  const rv = read('reviews.json');
  const scored = {};
  for (const r of Array.isArray(rv) ? rv : rv.reviews) if (r.assignedScore != null) scored[r.showId] = (scored[r.showId] || 0) + 1;
  const withScore = chicago.filter((s) => (scored[s.id] || 0) >= 3).length;
  assert.ok(withScore >= 700, `only ${withScore} of ${chicago.length} Chicago local shows have 3+ scored reviews`);
});
