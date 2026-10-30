import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findWritingWorkflows, extractConcurrencyGroup, checkEntry, findCoreDataWriters as findCDW, checkCoreDataEntry as checkCDE } from './api-fallback-writer-drift.js';
import { CORE_DATA_MERGE_REGISTRY, apiFallbackSafeEntriesFor } from './core-data-merge-registry.js';

test('findWritingWorkflows matches an inline git add', () => {
  const workflows = {
    'foo.yml': 'run: |\n  git add data/audit/health-digest-snapshot.json 2>/dev/null || true\n',
    'bar.yml': 'run: |\n  git add data/audit/unrelated.json\n',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/health-digest-snapshot.json', workflows), ['foo.yml']);
});

test('findWritingWorkflows resolves a dir/*.json entry staged through a variable (BRO-6615 press-night shape)', () => {
  const wf = 'run: |\n  F="data/audit/press-night/${SHOW_ID}-${NIGHT}.json"\n  git add "$F"\n';
  assert.deepEqual(findWritingWorkflows('data/audit/press-night/*.json', { 'press-night-probe.yml': wf, 'other.yml': 'run: git add data/audit/press.json\n' }), ['press-night-probe.yml']);
  // a variable under the dir that is never git-added is not a writer
  assert.deepEqual(findWritingWorkflows('data/audit/press-night/*.json', { 'reader.yml': 'run: |\n  F="data/audit/press-night/x.json"\n  cat "$F"\n' }), []);
  // a direct git add of the directory counts
  assert.deepEqual(findWritingWorkflows('data/audit/press-night/*.json', { 'bulk.yml': 'run: git add data/audit/press-night/\n' }), ['bulk.yml']);
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

test('sanity: CORE_DATA_MERGE_REGISTRY has exactly the seeded apiFallbackSafe entries (141 as of BRO-4861 2026-10-16: the BRO-5358 140 PLUS audit/coverage-holes.json (data-health-check.yml coverage-holes counts, sole writer scripts/audit-coverage-holes.js --counts); 140 as of BRO-5358 2026-10-14: the BRO-3011 139 PLUS audit/outlet-feed-reconcile.json (audit-aggregator-gap.yml advisory feed-vs-corpus reconcile, sole writer scripts/outlet-feed-reconcile.js); 139 as of BRO-3011 2026-10-13: the BRO-3010 138 PLUS audit/guard-audit-snapshot.json (data-health-check.yml spend-guard audit, sole writer scripts/guard-audit.js); 138 as of BRO-3010 2026-10-13: the BRO-3608 137 PLUS audit/sb-circuit-breaker.json (commercial-rss-poll.yml ScrapingBee breaker, sole writer scripts/check-sb-breaker.js); 137 as of BRO-3608 2026-10-12: the BRO-5027 136 PLUS audit/playbill-verdict-rejected-pages.json (scrape-new-aggregators.yml, sole writer scripts/scrape-playbill-verdict.js Step 3 rejected-page ledger); 136 as of BRO-5027 2026-10-11: the BRO-4656 135 PLUS audit/waltz-model-fit.json (scrape-waltz-costs.yml weekly Boring Waltz fit aggregate, sole writer scripts/scrape-boring-waltz-costs.js); 135 as of BRO-4656 2026-10-05: the BRO-4603 134 PLUS audit/tour-stop-discovery.json (discover-tour-stop-reviews.yml\'s per-stop search state, sole writer scripts/discover-tour-stop-reviews.js); 134 as of BRO-4603 2026-10-04: the BRO-4523 133 PLUS audit/wrong-article-adjudicated.json (data-health-check.yml\'s wrong-article LLM pass verdicts, sole writer scripts/audit-wrong-article.js --adjudicate); 133 as of BRO-4523 2026-10-02: the BRO-4381 132 PLUS audit/stuck-card-closer.json (data-health-check.yml\'s stuck verified card closer report, sole writer scripts/close-stuck-verified-cards.js); 132 as of BRO-4381 2026-09-29: the BRO-4268 130 PLUS audit/off-broadway-source-coverage-gaps.json and audit/off-broadway-source-coverage-state.json (update-show-status.yml\'s OB coverage guard, sole writer scripts/check-off-broadway-source-coverage.js); 130 as of BRO-4268 2026-09-29: the S4-T12 131 MINUS audit/owe-venue-candidates.json — its apiFallbackSafe claim was wrong: a hand --stage-only merge lands through land.yml, outside shows-json-writer, and on 2026-09-29 a stale Update Shows push overwrote 53 landed rows; it is now an active union-by-candidateHash merge (merge-owe-venue-candidates.js), not a single-writer bypass; 131 as of BRO-4204 S4-T12 2026-09-28: the S4-T9 129 PLUS audit/owe-last-promotion-ids.json and audit/owe-promotion-log.jsonl (promote-owe-venue-candidates.yml\'s state file + append-only audit log, sole writer scripts/promote-owe-venue-candidates.js, committed by its "Commit OWE promotion audit log + pruned staging" step, group shows-json-writer; audit/owe-venue-candidates.json itself stays registered — its two writers, update-show-status.yml and promote-owe-venue-candidates.yml, share that group); 129 as of BRO-4204 2026-09-28: the BRO-4149 128 PLUS audit/we-rejected-candidates.json (promote-we-aggregator.yml\'s remembered-rejection store, sole writer scripts/promote-we-aggregator-candidates.js via lib/we-rejected-candidates.js, same "Commit WE promotion audit log" step as we-last-promotion-ids.json); 128 as of BRO-4149 2026-09-25: the BRO-2722 127 PLUS audit/open-backlog-acceptance-sweep.json (data-health-check.yml\'s BRO-4135 sweep report, sole writer scripts/sweep-open-backlog-acceptance.js); 127 as of BRO-2722 2026-09-21: the ci-green-rate 126 PLUS audit/progress-watch-state.json (llm-ensemble-score.yml\'s scheduled-run liveness snapshot, sole writer scripts/check-progress-stalls.js — was staged unregistered via the workflow\'s broad `data/audit/` git-add glob, disqualifying its "Commit and push changes" step\'s Git Data API fallback and causing the repeat push-retry-exhaustion failure the card reported); 126 as of ci-green-rate 2026-09-20: the BRO-3670 125 PLUS ci-green-rate.jsonl (data-health-check.yml\'s nightly CI green-rate ledger, same apiFallbackSafe commit step as health-digest-snapshot.json); 125 as of BRO-3670 2026-09-16: the BRO-3431 126, MINUS the ticket-ab-monitor-state entry this fix froze (BRO-3456, 912f84e7d43, removed monitor-gate-ab.yml\'s write step); 126 as of BRO-3431 2026-09-15: the BRO-3426 125 PLUS notion-schedule-coupling.json (data-health-check.yml\'s new BRO-3431-reopen shadow audit); 125 as of BRO-3426 2026-09-15: the BRO-3071 124, MINUS the gate-cold-start-monitor-state entry BRO-3422 froze, PLUS the two done-evidence audit files data-health-check.yml writes; 124 as of BRO-3071 2026-09-14 what-else sweep -- see that registry file\'s own BRO-3071 comment block for the full per-workflow breakdown of the 85 newly added on top of the prior 39), not an accidental duplicate or drop', () => {
  const publicSafe = CORE_DATA_MERGE_REGISTRY.filter((e) => e.surface === 'public-repo' && e.apiFallbackSafe === true);
  const files = publicSafe.map((e) => e.file).sort();
  assert.equal(publicSafe.length, 148); // 146 PLUS audit/press-night-grade-snapshot.json and audit/press-night-grade-filed.json (BRO-6645, sole writer press-night-grade.yml); was 146 = 145 PLUS audit/press-night/*.json (BRO-6615, one file per show-night, sole writer press-night-probe.yml); was 145 = 143 PLUS audit/new-show-types-snapshot.json and audit/new-show-types-seen.json (BRO-6542); was 143 = 142 PLUS audit/related-shows-ab-monitor-state.json (BRO-6271); was 142 = 143 MINUS audit/opening-night-express-completed.json (BRO-5955: a second writer, opening-night-express.yml, races per show; now an active keyed merge); was 142 + audit/early-publish-dates.json (BRO-5769); was 141 + audit/star-band-drift.json (BRO-4840); was 140 + audit/coverage-holes.json (BRO-4861); was 139 + audit/outlet-feed-reconcile.json (BRO-5358); was 138 + audit/guard-audit-snapshot.json (BRO-3011); was 137 + audit/sb-circuit-breaker.json (BRO-3010); was 136 + audit/playbill-verdict-rejected-pages.json (BRO-3608); was 135 + audit/waltz-model-fit.json (BRO-5027); was 134 + audit/tour-stop-discovery.json (BRO-4656); was 133 + audit/wrong-article-adjudicated.json (BRO-4603); was 132 + audit/stuck-card-closer.json (BRO-4523); was 130 (BRO-4268) + 2 OB coverage guard files (BRO-4381); was 131 (BRO-4204 S4-T12) - audit/owe-venue-candidates.json (BRO-4268, 2026-09-29: withdrawn, now an active union merge)
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
    'audit/coverage-holes.json',
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
    'audit/early-publish-dates.json',
    'audit/email-gate-funnel-monitor-state.json',
    'audit/enrich-off-broadway-dates-aborted.json',
    'audit/flag-parity-monitor-state.json',
    'audit/follow-send-checkpoint.json',
    'audit/fulltext-mentions-show-lifetime.json',
    'audit/gap-audit-checkpoint.json',
    'audit/guard-audit-snapshot.json',
    'audit/health-check-history.json',
    'audit/health-digest-snapshot.json',
    'audit/imageless-scored-shows.json',
    'audit/linear-archive-done.jsonl',
    'audit/missed-broadcasts.json',
    'audit/needs-human-review.json',
    'audit/new-show-types-seen.json',
    'audit/new-show-types-snapshot.json',
    'audit/non-review-audit.json',
    'audit/notion-schedule-coupling.json',
    'audit/ob-closing-candidates.json',
    'audit/ob-todaytix-missing-state.json',
    'audit/ob-venue-counts.json',
    'audit/off-broadway-source-coverage-gaps.json',
    'audit/off-broadway-source-coverage-state.json',
    'audit/open-backlog-acceptance-sweep.json',
    'audit/opening-night-completeness-state.json',
    'audit/opening-night-history.json',
    'audit/opening-night-live-state.json',
    'audit/opening-night-sla-state.json',
    'audit/orphan-rescore-requeue-state.json',
    'audit/outlet-feed-reconcile.json',
    'audit/outlet-heartbeat-state.json',
    'audit/outlet-heartbeat.json',
    'audit/outlet-registry-baseline.json',
    'audit/outlet-registry-junk-baseline.json',
    'audit/owe-last-promotion-ids.json',
    'audit/owe-promotion-log.jsonl',
    'audit/pending-bug-diagnoses.json',
    'audit/playbill-broadway-last-success.json',
    'audit/playbill-verdict-rejected-pages.json',
    'audit/playbill-verdict-sitemap-seen.json',
    'audit/playbill-verdict-unmatched.json',
    'audit/possible-venue-transfers.json',
    'audit/press-night-grade-filed.json',
    'audit/press-night-grade-snapshot.json',
    'audit/press-night/*.json',
    'audit/processed-feedback.json',
    'audit/processed-review-submissions.json',
    'audit/progress-watch-state.json',
    'audit/provider-spend-daily.jsonl',
    'audit/provider-spend-snapshot.json',
    'audit/rebuild-score-drift.json',
    'audit/reddit-digest-snapshot.json',
    'audit/regional-serp-discovery.json',
    'audit/related-shows-ab-monitor-state.json',
    'audit/remediation-log.jsonl',
    'audit/reverse-discovery-candidates.json',
    'audit/reverse-discovery-state.json',
    'audit/review-evidence.json',
    'audit/revival-unverified-lifetime.json',
    'audit/roundup-url-mismatch-lifetime.json',
    'audit/same-title-confusion.json',
    'audit/sb-circuit-breaker.json',
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
    'audit/star-band-drift.json',
    'audit/stuck-card-closer.json',
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
    'audit/tour-stop-discovery.json',
    'audit/trunk-status-snapshot.json',
    'audit/uncollected-live-reviews.json',
    'audit/unknown-aggregator-outlets.json',
    'audit/venue-date-mismatches.json',
    'audit/video-review-audit.json',
    'audit/waltz-model-fit.json',
    'audit/we-gate-proving.json',
    'audit/we-last-promotion-ids.json',
    'audit/we-promotion-log.jsonl',
    'audit/we-rejected-candidates.json',
    'audit/workflow-run-coverage.json',
    'audit/wrong-article-adjudicated.json',
    'recoupment-calibration-anchors.json',
  ]);
});

// ── BRO-3514: private-core-data writer scan (fixtures only; the live-repo
// comparison is the advisory scripts/audit-core-data-writers.js) ───────────
{
  const SRC = {
    'scripts/generate-critic-consensus.js': "const CONSENSUS_FILE = path.join(ROOT, 'data', 'critic-consensus.json');\nfs.writeFileSync(CONSENSUS_FILE, out);\n",
    'scripts/reads-consensus.js': "const x = JSON.parse(fs.readFileSync('data/critic-consensus.json'));\nfs.writeFileSync(OTHER_OUT, x);\n",
    'scripts/via-lib.js': "const store = require('./lib/store');\nstore.save();\n",
    'scripts/lib/store.js': "fs.writeFileSync(path.join(DATA, 'subscribers.json'), body);\n",
    'scripts/scrape-grosses.ts': "const GROSSES_PATH = path.join(DATA_DIR, 'grosses.json');\nfs.writeFileSync(GROSSES_PATH, s);\n",
  };
  const readFile = (p) => SRC[p] ?? null;
  const wf = (run, group = 'g') => `name: x\nconcurrency:\n  group: ${group}\njobs:\n  j:\n    steps:\n      - run: ${run}\n      - uses: ./.github/actions/push-core-data\n`;

  test('findCoreDataWriters: a workflow that runs a writer AND pushes core data is a writer; readers and non-pushers are not', () => {
    const workflows = {
      'update-critic-consensus.yml': wf('node scripts/generate-critic-consensus.js'),
      'recreate-broadcast-draft.yml': wf('node scripts/generate-critic-consensus.js --show=x'),
      'reader.yml': wf('node scripts/reads-consensus.js'),
      'no-push.yml': 'jobs:\n  j:\n    steps:\n      - run: node scripts/generate-critic-consensus.js\n',
    };
    assert.deepEqual(Object.keys(findCDW('critic-consensus.json', workflows, readFile)).sort(), ['recreate-broadcast-draft.yml', 'update-critic-consensus.yml']);
  });

  test('findCoreDataWriters follows a ./lib require and reads .ts scripts', () => {
    assert.deepEqual(findCDW('subscribers.json', { 'a.yml': wf('node scripts/via-lib.js') }, readFile), { 'a.yml': ['scripts/via-lib.js'] });
    assert.deepEqual(findCDW('grosses.json', { 'g.yml': wf('npx tsx scripts/scrape-grosses.ts') }, readFile), { 'g.yml': ['scripts/scrape-grosses.ts'] });
  });

  test('checkCoreDataEntry: an undocumented extra writer is drift (the critic-consensus.json shape BRO-3514 found)', () => {
    const workflows = { 'update-critic-consensus.yml': wf('node scripts/generate-critic-consensus.js', 'a'), 'recreate-broadcast-draft.yml': wf('node scripts/generate-critic-consensus.js', 'b') };
    const derived = findCDW('critic-consensus.json', workflows, readFile);
    const r = checkCDE({ file: 'critic-consensus.json', writers: ['update-critic-consensus.yml'] }, derived, workflows);
    assert.equal(r.status, 'drift');
    assert.deepEqual(r.undeclared, ['recreate-broadcast-draft.yml']);
  });

  test('checkCoreDataEntry: concurrent declared writers need a documented mitigation; a shared group does not', () => {
    const two = { 'a.yml': wf('node scripts/generate-critic-consensus.js', 'a'), 'b.yml': wf('node scripts/generate-critic-consensus.js', 'b') };
    const derived = findCDW('critic-consensus.json', two, readFile);
    assert.equal(checkCDE({ writers: ['a.yml', 'b.yml'] }, derived, two).status, 'drift');
    assert.equal(checkCDE({ writers: ['a.yml', 'b.yml'], multiWriterMitigation: 'lost take regenerates' }, derived, two).status, 'ok');
    const shared = { 'a.yml': wf('node scripts/generate-critic-consensus.js', 'same'), 'b.yml': wf('node scripts/generate-critic-consensus.js', 'same') };
    assert.equal(checkCDE({ writers: ['a.yml', 'b.yml'] }, findCDW('critic-consensus.json', shared, readFile), shared).status, 'ok');
  });

  test('checkCoreDataEntry: a single writer on a per-run group needs a mitigation (update-lbo shape); no list is "undeclared"; nothing found is "unverifiable"', () => {
    const perRun = { 'lbo.yml': wf('node scripts/generate-critic-consensus.js', 'lbo-${{ github.run_id }}') };
    assert.equal(checkCDE({ writers: ['lbo.yml'] }, findCDW('critic-consensus.json', perRun, readFile), perRun).status, 'drift');
    assert.equal(checkCDE({}, {}, {}).status, 'undeclared');
    const helperOnly = { 'p.yml': wf('node scripts/unknown.js') };
    assert.equal(checkCDE({ writers: ['p.yml'], writersUnverifiable: 'path passed as a parameter' }, {}, helperOnly).status, 'unverifiable');
  });
}
