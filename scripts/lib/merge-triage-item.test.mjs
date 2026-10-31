// BRO-2782: data/audit/triage/*.json is covered by one glob registry entry
// with an ours-wins merge, so push-with-retry.sh's Git Data API fallback is
// reachable for it, while unregistered data/audit/ paths stay disqualified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeTriageItem } = require('./merge-triage-item.js');
const { registryPathMatches } = require('./registry-path-match.js');
const { apiFallbackMergerFor, API_FALLBACK_SAFE, API_FALLBACK_MERGE, MANAGED } = require('./reconcile-merged-json.js');
const { disqualifyingPath } = require('./api-fallback-disqualifier-core.js');
const { findEntry } = require('./core-data-merge-registry.js');

test('merge: ours wins, remote only when ours is unusable', () => {
  assert.deepEqual(mergeTriageItem({ a: 1 }, { a: 2 }).merged, { a: 1 });
  assert.deepEqual(mergeTriageItem(null, { a: 2 }).merged, { a: 2 });
  assert.deepEqual(mergeTriageItem([], { a: 2 }).merged, { a: 2 });
  assert.equal(mergeTriageItem({ a: 1 }, null).merged.a, 1);
  assert.equal(mergeTriageItem({ a: 1 }, { a: 1 }, { a: 0 }).stats.source, 'ours');
});

test('matcher: direct .json children only, whole-segment dir', () => {
  const g = 'audit/triage/*.json';
  assert.ok(registryPathMatches(g, 'data/audit/triage/alert router.json'));
  assert.ok(registryPathMatches(g, 'data/audit/triage/autofix-cron-rebuild-reviews.json'));
  assert.ok(!registryPathMatches(g, 'data/audit/triage/sub/x.json'));
  assert.ok(!registryPathMatches(g, 'data/audit/triage/x.txt'));
  assert.ok(!registryPathMatches(g, 'data/audit/not-triage/x.json'));
  assert.ok(!registryPathMatches(g, 'data/audit/triage.json'));
  assert.ok(registryPathMatches('data/audit/alert-ledger.json', 'data/audit/alert-ledger.json'));
  assert.ok(!registryPathMatches('audit/alert-ledger.json', 'data/audit/xalert-ledger.json.bak'));
  assert.throws(() => registryPathMatches('audit/*/x.json', 'data/audit/a/x.json'));
});

test('every real triage file resolves to the merge entry and is not disqualifying', () => {
  const reg = { MANAGED, API_FALLBACK_SAFE, API_FALLBACK_MERGE };
  for (const f of fs.readdirSync('data/audit/triage').filter((n) => n.endsWith('.json'))) {
    const p = `data/audit/triage/${f}`;
    assert.ok(apiFallbackMergerFor(p), p);
    assert.ok(findEntry(p, 'public-repo'), p);
    assert.equal(disqualifyingPath([p], reg), null, p);
  }
});

test('unregistered and nested data/audit paths still disqualify', () => {
  const reg = { MANAGED, API_FALLBACK_SAFE, API_FALLBACK_MERGE };
  assert.equal(disqualifyingPath(['data/audit/some-unregistered-thing.json'], reg), 'data/audit/some-unregistered-thing.json');
  assert.equal(disqualifyingPath(['data/audit/triage/sub/x.json'], reg), 'data/audit/triage/sub/x.json');
  assert.equal(disqualifyingPath(['data/audit/triage/x.txt'], reg), 'data/audit/triage/x.txt');
});

test('a bare `git add data/audit/triage/` is classified as merge-covered (rule z)', () => {
  const { classifyPushFallbackSafety } = require('./audit-push-retry-budgets.js');
  assert.equal(classifyPushFallbackSafety('data/audit/triage/').isApiFallbackMerge, true);
  assert.equal(classifyPushFallbackSafety('data/audit/other-dir/').isApiFallbackMerge, false);
});

test('glob entries do not pollute MANAGED_FILE_INFO; dir match is segment-anchored', () => {
  const { managedFileInfo, classifyPushFallbackSafety } = require('./audit-push-retry-budgets.js');
  assert.equal(managedFileInfo('git add data/review-texts/*/*.json').touches, false);
  assert.equal(classifyPushFallbackSafety('data/foo-audit/triage/').isApiFallbackMerge, false);
});
