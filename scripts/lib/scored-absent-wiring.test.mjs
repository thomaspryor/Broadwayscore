// BRO-8093 audit of BRO-7945: the scored-absent class guard (scripts/lib/scored-absent.js, tested with fixtures in
// pending-drain-bro-7930.test.mjs) is only as good as its wiring. If rebuild-all-reviews.js stops taking its
// whole-show skip from wholeShowSkipReason (a private copy drifts and drops files with no recorded reason) or stops
// running the scored-absent audit at the end of a full rebuild with its own ledgers, nothing else notices.
// No live data: runs in test.yml's blocking unit batch on every push.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { wholeShowSkipReason } = require('./scored-absent.js');

const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../rebuild-all-reviews.js'), 'utf8');

test('rebuild takes whole-show skips from the shared wholeShowSkipReason', () => {
  assert.match(src, /require\('\.\/lib\/scored-absent'\)/);
  assert.match(src, /const wholeShowSkip = wholeShowSkipReason\(/);
  assert.match(src, /wholeShowSkip === 'skippedPreviewsShows'/);
  assert.match(src, /wholeShowSkip === 'skippedUpcomingShows'/);
  assert.doesNotMatch(src, /showStatusMap\[showId\] === ['"](previews|upcoming)['"]/, 'a private status check bypasses wholeShowSkipReason');
  assert.equal(wholeShowSkipReason({ status: 'upcoming', category: 'west-end' }), 'skippedUpcomingShows');
});

test('full rebuild runs the scored-absent audit with its own ledgers and corpus', () => {
  const call = src.match(/require\('\.\/audit-scored-absent'\)\.run\(\{([^}]*)\}\)/);
  assert.ok(call, 'rebuild-all-reviews.js no longer calls audit-scored-absent run()');
  assert.match(call[1], /\bledgers\b/);
  assert.match(call[1], /textsDir: reviewTextsDir/);
});
