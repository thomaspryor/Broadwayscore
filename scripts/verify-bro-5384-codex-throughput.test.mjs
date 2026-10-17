// BRO-5384 live acceptance (RECHECK-AFTER probe; not in the unit batches, see
// scripts/lib/unit-test-collection.js): since the parallel Codex slots landed, the runner's
// summaries on BRO-4745 (newest 50, listIssueComments) show >= 4 cards worked per firing and
// >= 40% of worked cards landed. Before: 24 cards in ~11 firings, 5 landed (2026-10-13/15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./lib/load-env').loadEnv();
const linear = require('./lib/linear-client.js');
const { firingThroughput } = require('./lib/codex-runner.js');

// The 07:41 UTC firing on 2026-10-15 is the first with --slots 3 (a50cc9300 landed 06:49).
const SINCE = process.env.CODEX_THROUGHPUT_SINCE || '2026-10-15T07:30:00Z';
// = the card's RECHECK-AFTER: a day of firings first. Land's colocated-tests gate runs every
// changed test file, so the probe skips until then (verify-codex-runner-health.test.mjs pattern).
const CHECKABLE_FROM = Date.parse('2026-10-16T08:00:00Z');

test('Codex runner: >= 4 cards per firing and >= 40% landed since the parallel slots (BRO-5384)', {
  skip: Date.now() < CHECKABLE_FROM && !process.env.CODEX_THROUGHPUT_SINCE ? 'not checkable before 2026-10-16 08:00 UTC (a day of firings)' : false,
}, async () => {
  const comments = ((await linear.listIssueComments(['BRO-4745'])).get('BRO-4745') || []).filter((c) => c.createdAt >= SINCE);
  const t = firingThroughput(comments);
  // Newest 50 comments only (~36 runner summaries a day): run it the day after, not weeks later.
  const facts = `${t.firings} firing(s), ${t.worked} worked, ${t.landed} landed (${t.perFiring.toFixed(1)}/firing, ${Math.round(t.landedShare * 100)}% landed; newest 50 comments)`;
  assert.ok(t.firings >= 3, `too few firings to judge: ${facts}`);
  assert.ok(t.perFiring >= 4, `under 4 cards per firing: ${facts}`);
  assert.ok(t.landedShare >= 0.4, `under 40% landed: ${facts}`);
});
