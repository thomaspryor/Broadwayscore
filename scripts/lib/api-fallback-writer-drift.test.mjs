import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findWritingWorkflows, extractConcurrencyGroup, checkEntry } from './api-fallback-writer-drift.js';
import { CORE_DATA_MERGE_REGISTRY, apiFallbackSafeEntriesFor } from './core-data-merge-registry.js';

test('findWritingWorkflows matches an inline git add', () => {
  const workflows = {
    'foo.yml': 'run: |\n  git add data/audit/health-digest-snapshot.json 2>/dev/null || true\n',
    'bar.yml': 'run: |\n  git add data/audit/unrelated.json\n',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/health-digest-snapshot.json', workflows), ['foo.yml']);
});

test('findWritingWorkflows matches the git-add-existing.sh helper shape', () => {
  const workflows = {
    'foo.yml': 'run: |\n  bash scripts/lib/git-add-existing.sh data/audit/a.jsonl data/audit/b.json\n',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/b.json', workflows), ['foo.yml']);
});

test('findWritingWorkflows matches the git-add-existing.sh helper shape with backslash line continuations (BRO-3455 drift workflow)', () => {
  const text = 'run: |\n  bash scripts/lib/git-add-existing.sh \\\n    data/audit/drift-state.json \\\n    data/audit/alert-ledger.json\n';
  assert.deepEqual(findWritingWorkflows('data/audit/drift-state.json', { 'drift.yml': text }), ['drift.yml']);
  assert.deepEqual(findWritingWorkflows('data/audit/alert-ledger.json', { 'drift.yml': text }), ['drift.yml']);
  // A path on a later line that is NOT joined by a continuation is a different command — still no match.
  const broken = 'run: |\n  bash scripts/lib/git-add-existing.sh data/audit/x.json\n  echo data/audit/drift-state.json\n';
  assert.deepEqual(findWritingWorkflows('data/audit/drift-state.json', { 'drift.yml': broken }), []);
});

test('findWritingWorkflows finds every distinct writer, order-independent of glob order', () => {
  const workflows = {
    'a.yml': 'git add data/audit/shared.json',
    'b.yml': 'git add data/audit/shared.json',
    'c.yml': 'git add data/audit/other.json',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/shared.json', workflows), ['a.yml', 'b.yml']);
});

test('findWritingWorkflows matches the loop-staged idiom (BRO-3071)', () => {
  const workflows = {
    'foo.yml': 'run: |\n  for f in data/audit/a.json data/audit/b.json; do\n    [ -e "$f" ] && git add "$f" || echo skip\n  done\n',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/a.json', workflows), ['foo.yml']);
  assert.deepEqual(findWritingWorkflows('data/audit/b.json', workflows), ['foo.yml']);
});

test('findWritingWorkflows matches the loop-staged idiom with backslash line continuations', () => {
  const workflows = {
    'foo.yml': 'run: |\n  for f in data/audit/a.json \\\n           data/audit/b.json; do\n    git add "$f"\n  done\n',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/b.json', workflows), ['foo.yml']);
});

test('findWritingWorkflows ignores an unrelated for-loop that never git-adds its own variable', () => {
  const workflows = {
    'foo.yml': 'run: |\n  for f in data/audit/a.json; do\n    echo "$f"\n  done\n  git add data/audit/unrelated.json\n',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/a.json', workflows), []);
});

test('extractConcurrencyGroup reads a plain top-level group', () => {
  const yaml = 'name: X\nconcurrency:\n  group: data-health-check\n  cancel-in-progress: false\n';
  assert.equal(extractConcurrencyGroup(yaml), 'data-health-check');
});

test('extractConcurrencyGroup treats a run_id-templated group as no real protection', () => {
  const yaml = 'concurrency:\n  group: ${{ github.workflow }}-${{ github.run_id }}\n';
  assert.equal(extractConcurrencyGroup(yaml), null);
});

test('extractConcurrencyGroup returns null when absent', () => {
  assert.equal(extractConcurrencyGroup('name: X\non: push\n'), null);
});

test('checkEntry: single real writer is ok', () => {
  const entry = { file: 'audit/health-digest-snapshot.json', concurrencyGroup: 'data-health-check' };
  const workflows = { 'data-health-check.yml': 'git add data/audit/health-digest-snapshot.json' };
  const result = checkEntry(entry, workflows);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writers, ['data-health-check.yml']);
});

test('checkEntry: zero writers found is a gap (path moved / dynamic write invisible to this check)', () => {
  const entry = { file: 'audit/nowhere.json', concurrencyGroup: 'x' };
  const result = checkEntry(entry, { 'a.yml': 'git add data/audit/something-else.json' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no writer found/);
});

test('checkEntry: two writers sharing the claimed concurrency group is NOT a gap (the grosses.json shape)', () => {
  // Synthetic fixture reproducing the real grosses.json precedent
  // (core-data-merge-registry.js: "both writers share concurrency group
  // data-grosses-writers — mutually exclusive, no real race") — proves the
  // detector does not repeat the naive "2+ writers = gap" mistake the
  // plan-review design reviewer flagged against exactly this shape.
  const entry = { file: 'audit/grosses-fixture.json', concurrencyGroup: 'data-grosses-writers' };
  const workflows = {
    'weekly-grosses.yml': 'concurrency:\n  group: data-grosses-writers\nrun: |\n  git add data/audit/grosses-fixture.json\n',
    'scrape-alltime-grosses.yml': 'concurrency:\n  group: data-grosses-writers\nrun: |\n  git add data/audit/grosses-fixture.json\n',
  };
  const result = checkEntry(entry, workflows);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.writers.length, 2);
});

test('checkEntry: two writers NOT sharing a concurrency group IS a gap', () => {
  // Reproduces the real alert-digest-queue.json mistake caught during this
  // task's own plan-review: two independent, unserialized writers.
  const entry = { file: 'audit/alert-digest-queue.json', concurrencyGroup: 'data-health-check' };
  const workflows = {
    'data-health-check.yml': 'concurrency:\n  group: data-health-check\nrun: |\n  git add data/audit/alert-digest-queue.json\n',
    'process-feedback.yml': 'concurrency:\n  group: process-feedback\nrun: |\n  git add data/audit/alert-digest-queue.json\n',
  };
  const result = checkEntry(entry, workflows);
  assert.equal(result.ok, false);
  assert.equal(result.writers.length, 2);
});

// ── Live-repo regression: every REAL registered entry still holds ──────────
test('REGRESSION: every real apiFallbackSafe(public-repo) registry entry still passes checkEntry against the actual .github/workflows/*.yml files', () => {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const wfDir = path.join(repoRoot, '.github', 'workflows');
  const workflowTexts = {};
  for (const f of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    workflowTexts[f] = fs.readFileSync(path.join(wfDir, f), 'utf8');
  }

  const entries = apiFallbackSafeEntriesFor('public-repo');
  assert.ok(entries.length > 0, 'expected at least one apiFallbackSafe(public-repo) entry to regression-test');
  for (const entry of entries) {
    const result = checkEntry(entry, workflowTexts);
    assert.equal(result.ok, true, `${entry.file}: drift detected — ${result.reason} (registered apiFallbackSafe:true but no longer verifiable as single-writer; re-verify by hand before trusting the fallback for this file)`);
  }
});

test('sanity: CORE_DATA_MERGE_REGISTRY has exactly the seeded apiFallbackSafe entries (127 as of BRO-2722 2026-09-21: the ci-green-rate 126 PLUS audit/progress-watch-state.json (llm-ensemble-score.yml\'s scheduled-run liveness snapshot, sole writer scripts/check-progress-stalls.js — was staged unregistered via the workflow\'s broad `data/audit/` git-add glob, disqualifying its "Commit and push changes" step\'s Git Data API fallback and causing the repeat push-retry-exhaustion failure the card reported); 126 as of ci-green-rate 2026-09-20: the BRO-3670 125 PLUS ci-green-rate.jsonl (data-health-check.yml\'s nightly CI green-rate ledger, same apiFallbackSafe commit step as health-digest-snapshot.json); 125 as of BRO-3670 2026-09-16: the BRO-3431 126, MINUS the ticket-ab-monitor-state entry this fix froze (BRO-3456, 912f84e7d43, removed monitor-gate-ab.yml\'s write step); 126 as of BRO-3431 2026-09-15: the BRO-3426 125 PLUS notion-schedule-coupling.json (data-health-check.yml\'s new BRO-3431-reopen shadow audit); 125 as of BRO-3426 2026-09-15: the BRO-3071 124, MINUS the gate-cold-start-monitor-state entry BRO-3422 froze, PLUS the two done-evidence audit files data-health-check.yml writes; 124 as of BRO-3071 2026-09-14 what-else sweep -- see that registry file\'s own BRO-3071 comment block for the full per-workflow breakdown of the 85 newly added on top of the prior 39), not an accidental duplicate or drop', () => {
  const publicSafe = CORE_DATA_MERGE_REGISTRY.filter((e) => e.surface === 'public-repo' && e.apiFallbackSafe === true);
  const files = publicSafe.map((e) => e.file).sort();
  assert.equal(publicSafe.length, 127); // 126 (ci-green-rate) + audit/progress-watch-state.json (BRO-2722, 2026-09-21)
  assert.deepEqual(files, [
    'audit/affiliate-health.json',
    'audit/affiliate-link-probe.json',
    'audit/alert-sender-inventory.json',
    'audit/arm-yield-ledger.jsonl',
    'audit/autoclear-shadow-report.json',
    'audit/autoclear-shadow.jsonl',
    'audit/autonomous-recheck-ledger.jsonl',
    'audit/bd-circuit-breaker.json',
    'audit/brand-mentions.json',
    'audit/broadway-source-coverage-gaps.json',
    'audit/broadway-source-coverage-state.json',
    'audit/bundle-size-baseline.json',
    'audit/bundle-size-history.json',
    'audit/bww-roundup-unmatched.json',
    'audit/cast-changes-diff.json',
    'audit/census-recall-status.json',
    'audit/churn-merge-coverage.json',
    'audit/ci-green-rate.jsonl',
    'audit/collection-coverage-history.json',
    'audit/collection-coverage.json',
    'audit/commercial-data-audit.json',
    'audit/commercial-data-history.json',
    'audit/corpus-drift.json',
    'audit/coverage-adversarial-probe-status.json',
    'audit/coverage-adversarial-probe.json',
    'audit/coverage-digest-snapshot.json',
    'audit/creative-team-audit.json',
    'audit/critic-coverage-audit.json',
    'audit/critic-coverage-buckets.json',
    'audit/critic-coverage-cooldown.json',
    'audit/cron-health-state.json',
    'audit/cross-outlet-attribution-drift.json',
    'audit/cross-outlet-duplicates.json',
    'audit/cv-wrongproduction-lifetime.json',
    'audit/daily-digest-snapshot.json',
    'audit/daily-snapshot.json',
    'audit/date-enrichment-corrections.json',
    'audit/deploy-watermark.json',
    'audit/deployed-coverage-diff.json',
    'audit/discovery-source-coverage.json',
    'audit/dmarc-report-ledger.jsonl',
    'audit/dmarc-summary.json',
    'audit/done-evidence-audit.json',
    'audit/done-evidence-digest-snapshot.json',
    'audit/drift-state.json',
    'audit/email-gate-funnel-monitor-state.json',
    'audit/enrich-off-broadway-dates-aborted.json',
    'audit/flag-parity-monitor-state.json',
    'audit/follow-send-checkpoint.json',
    'audit/fulltext-mentions-show-lifetime.json',
    'audit/gap-audit-checkpoint.json',
    'audit/health-check-history.json',
    'audit/health-digest-snapshot.json',
    'audit/imageless-scored-shows.json',
    'audit/linear-archive-done.jsonl',
    'audit/missed-broadcasts.json',
    'audit/needs-human-review.json',
    'audit/non-review-audit.json',
    'audit/notion-schedule-coupling.json',
    'audit/ob-closing-candidates.json',
    'audit/ob-todaytix-missing-state.json',
    'audit/ob-venue-counts.json',
    'audit/opening-night-completeness-state.json',
    'audit/opening-night-express-completed.json',
    'audit/opening-night-history.json',
    'audit/opening-night-live-state.json',
    'audit/opening-night-sla-state.json',
    'audit/orphan-rescore-requeue-state.json',
    'audit/outlet-heartbeat-state.json',
    'audit/outlet-heartbeat.json',
    'audit/outlet-registry-baseline.json',
    'audit/outlet-registry-junk-baseline.json',
    'audit/owe-venue-candidates.json',
    'audit/pending-bug-diagnoses.json',
    'audit/playbill-broadway-last-success.json',
    'audit/playbill-verdict-sitemap-seen.json',
    'audit/playbill-verdict-unmatched.json',
    'audit/possible-venue-transfers.json',
    'audit/processed-feedback.json',
    'audit/processed-review-submissions.json',
    'audit/progress-watch-state.json',
    'audit/provider-spend-daily.jsonl',
    'audit/provider-spend-snapshot.json',
    'audit/rebuild-score-drift.json',
    'audit/reddit-digest-snapshot.json',
    'audit/regional-serp-discovery.json',
    'audit/remediation-log.jsonl',
    'audit/reverse-discovery-candidates.json',
    'audit/reverse-discovery-state.json',
    'audit/review-evidence.json',
    'audit/revival-unverified-lifetime.json',
    'audit/roundup-url-mismatch-lifetime.json',
    'audit/same-title-confusion.json',
    'audit/scoring-audit-history.json',
    'audit/scoring-audit.json',
    'audit/scoring-audit.md',
    'audit/scraper-spend-daily-agg.jsonl',
    'audit/sd-circuit-breaker.json',
    'audit/serp-census-recall.json',
    'audit/show-changes-digest.json',
    'audit/show-review-gap.json',
    'audit/show-score-extraction-gaps.json',
    'audit/slug-mismatch-lifetime.json',
    'audit/slug-misroute-audit.json',
    'audit/social-tier-transitions.json',
    'audit/stale-announced-shows.json',
    'audit/t1-coverage-ack.json',
    'audit/t1-coverage-digest-state.json',
    'audit/t1-coverage-ledger.json',
    'audit/t1-coverage-signals.json',
    'audit/t1-coverage-stats.json',
    'audit/t1-outlet-breaker.json',
    'audit/t1-recovery-state.json',
    'audit/t1-silent-gap-alerts.json',
    'audit/t1-silent-gaps.json',
    'audit/theatr-coverage.json',
    'audit/time-to-publish-sla.json',
    'audit/trunk-status-snapshot.json',
    'audit/uncollected-live-reviews.json',
    'audit/unknown-aggregator-outlets.json',
    'audit/venue-date-mismatches.json',
    'audit/video-review-audit.json',
    'audit/we-gate-proving.json',
    'audit/we-last-promotion-ids.json',
    'audit/we-promotion-log.jsonl',
    'audit/workflow-run-coverage.json',
    'recoupment-calibration-anchors.json',
  ]);
});
