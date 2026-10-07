/** BRO-4770: a show stays in the roundup-gap scope while it still receives reviews. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { lastNewReviewAt, hasRecentReviewActivity } = require('../../scripts/lib/collection-phase.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const DAY = 86400000;
function showDirWith(firstSeen) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-'));
  firstSeen.forEach((t, i) => fs.writeFileSync(path.join(dir, `r${i}.json`), JSON.stringify({ firstSeenAt: t })));
  return dir;
}

test('newest first-seen across files wins; empty or missing dir is 0', () => {
  const dir = showDirWith(['2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z']);
  assert.equal(lastNewReviewAt(dir), Date.parse('2026-10-15T00:00:00Z'));
  assert.equal(lastNewReviewAt(path.join(dir, 'nope')), 0);
});

test('a late review re-enters the show; a quiet show falls out', () => {
  const late = lastNewReviewAt(showDirWith(['2026-10-01T00:00:00Z', '2026-10-18T00:00:00Z']));
  const quiet = lastNewReviewAt(showDirWith(['2026-10-01T00:00:00Z']));
  assert.equal(hasRecentReviewActivity(late, NOW), true);
  assert.equal(hasRecentReviewActivity(quiet, NOW), false);
  assert.equal(hasRecentReviewActivity(0, NOW), false);
  assert.equal(hasRecentReviewActivity(NOW - 10 * DAY, NOW), true);
  assert.equal(hasRecentReviewActivity(NOW - 11 * DAY, NOW), false);
});
