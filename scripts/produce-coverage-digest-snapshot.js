#!/usr/bin/env node
/**
 * produce-coverage-digest-snapshot.js — Coverage Verdict S3 (task #905): the
 * "small producer on the audit cron" the plan calls for. Reads
 * data/audit/show-review-gap.json (already carries censusVerdict per show as
 * of Coverage Verdict S2) and writes data/audit/coverage-digest-snapshot.json
 * in the same {generatedAt, bannerText, items, moreCount} shape every other
 * named digest uses (scripts/lib/digest-snapshots.js), so
 * send-morning-digest.js needs no new render code.
 *
 * Runs after scripts/audit-show-review-gap.js in the hourly gap-audit
 * workflow — same producer (the audit), no new machinery.
 *
 *   node scripts/produce-coverage-digest-snapshot.js               write the snapshot
 *   node scripts/produce-coverage-digest-snapshot.js --dry-run      print, don't write
 *   node scripts/produce-coverage-digest-snapshot.js --dry-run --fixture=demo
 *     print against a built-in synthetic show-review-gap.json (no live
 *     audit data needed — for verifying the line format offline/in CI).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { coverageDigestItems } = require('./lib/coverage-digest.js');
const { digestItems: feedGapItems } = require('./lib/outlet-feed-reconcile.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { coverageGateDisabled } = require('./lib/coverage-gate.js');
const { loadLiveShowIds, plausibleLiveShowIds } = require('./lib/live-show-ids.js');

const REPO = path.join(__dirname, '..');
const GAP_AUDIT_PATH = path.join(REPO, 'data', 'audit', 'show-review-gap.json');
const FEED_RECONCILE_PATH = path.join(REPO, 'data', 'audit', 'outlet-feed-reconcile.json');
const FEED_RECONCILE_MAX_AGE_H = 36;
const SNAPSHOT_PATH = path.join(REPO, 'data', 'audit', 'coverage-digest-snapshot.json');
const LIMIT = 10;

const FIXTURES = {
  demo: () => ({
    generatedAt: new Date().toISOString(),
    results: [{
      showId: 'the-car-man-west-end-2026',
      title: 'The Car Man',
      censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14 },
      missing: [{ url: 'a' }, { url: 'b' }, { url: 'c', priorRun: true }],
    }],
  }),
};

// BRO-5358: advisory feed-vs-corpus reconcile rows (scripts/outlet-feed-reconcile.js).
// A stale or unreadable reconcile file adds nothing rather than repeating old gaps.
function readFeedReconcile(nowMs = Date.now()) {
  try {
    const r = JSON.parse(fs.readFileSync(FEED_RECONCILE_PATH, 'utf8'));
    const ageH = (nowMs - Date.parse(r.generatedAt)) / 3600000;
    return ageH >= 0 && ageH < FEED_RECONCILE_MAX_AGE_H ? r : null;
  } catch { return null; }
}

// BRO-5349: the gap audit carries rows for retired/merged show ids forward;
// pass liveShowIds (ids in shows.json) so they never reach the digest.
function buildSnapshot(gapAudit, nowIso, feedReconcile = null, liveShowIds = null) {
  const rows = (gapAudit?.results || []).filter((r) => !liveShowIds || (r && liveShowIds.has(r.showId)));
  const items = coverageDigestItems(rows, { limit: LIMIT });
  const feedItems = feedGapItems(feedReconcile?.gaps || [], LIMIT).map((it) => ({ ...it, detail: `${it.detail} (advisory)` }));
  const all = [...items, ...feedItems].slice(0, LIMIT);
  const bannerText = all.length === 0
    ? 'Every censused show has all known reviews live'
    : [items.length && `${items.length} show(s) with known reviews live but incomplete`, feedItems.length && `${feedItems.length} new show(s) with reviews in outlet feeds we have not ingested`].filter(Boolean).join('; ');
  return { generatedAt: nowIso, bannerText, items: all, moreCount: 0 };
}

function removeStaleSnapshot() {
  try {
    fs.unlinkSync(SNAPSHOT_PATH);
    console.log(`[coverage-digest] removed stale ${SNAPSHOT_PATH}`);
  } catch { /* nothing to remove */ }
}

const USAGE = `produce-coverage-digest-snapshot.js — write the coverage digest snapshot
  node scripts/produce-coverage-digest-snapshot.js               write the snapshot
  node scripts/produce-coverage-digest-snapshot.js --dry-run     print, don't write
  node scripts/produce-coverage-digest-snapshot.js --dry-run --fixture=demo
  node scripts/produce-coverage-digest-snapshot.js --help, -h    print this usage and exit — no reads/writes
`;

function main() {
  // --help/-h checked BEFORE any read/write (help-flag safety Rule B, task #498).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const dryRun = process.argv.includes('--dry-run');
  const fixtureArg = process.argv.find((a) => a.startsWith('--fixture='));
  const nowIso = new Date().toISOString();

  let gapAudit;
  if (fixtureArg) {
    const name = fixtureArg.split('=')[1];
    const build = FIXTURES[name];
    if (!build) {
      console.error(`[coverage-digest] unknown fixture "${name}" — known: ${Object.keys(FIXTURES).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    gapAudit = build();
  } else {
    // Fail open: kill switch or missing/unreadable audit → write nothing, AND
    // remove any prior snapshot. readSnapshot() in digest-snapshots.js only
    // checks the age of the last write, not whether its content still
    // reflects current reality — leaving a stale file in place would let a
    // real (possibly outdated) completeness line keep rendering as "fresh"
    // for up to maxAgeH (36h) of skipped runs. Deleting drops it to
    // 'missing', which is optionalIfMissing for this key, so the morning
    // email just omits the section instead of showing stale/wrong data.
    if (coverageGateDisabled()) {
      console.log('[coverage-digest] COVERAGE_GATE_DISABLED — skipping snapshot write');
      removeStaleSnapshot();
      return;
    }
    try {
      gapAudit = JSON.parse(fs.readFileSync(GAP_AUDIT_PATH, 'utf8'));
    } catch (e) {
      console.log(`[coverage-digest] ${GAP_AUDIT_PATH} unreadable (${e.message}) — skipping snapshot write`);
      removeStaleSnapshot();
      return;
    }
  }

  const snapshot = buildSnapshot(gapAudit, nowIso, fixtureArg ? null : readFeedReconcile(), fixtureArg ? null : plausibleLiveShowIds(loadLiveShowIds()));
  console.log(`[coverage-digest] ${snapshot.bannerText}`);
  for (const it of snapshot.items) console.log(`  · ${it.title}: ${it.detail}`);

  if (dryRun) {
    console.log('[coverage-digest] --dry-run, not writing');
    return;
  }
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(`${SNAPSHOT_PATH}.tmp`, JSON.stringify(snapshot, null, 2) + '\n');
  fs.renameSync(`${SNAPSHOT_PATH}.tmp`, SNAPSHOT_PATH);
  console.log(`[coverage-digest] wrote ${SNAPSHOT_PATH}`);
}

if (require.main === module) main();

module.exports = { buildSnapshot, readFeedReconcile };
