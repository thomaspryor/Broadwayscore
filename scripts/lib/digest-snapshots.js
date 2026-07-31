/**
 * digest-snapshots.js — the one place that knows which snapshot files feed
 * the owner's single scheduled morning email (scripts/send-morning-digest.js).
 *
 * Ancestry: cards #364/#497/#511 folded four standalone digest emails into
 * snapshot files consumed by the autonomous loop's morning email. When the
 * loop was retired (2026-07-27, owner decision), the consumer moved here so
 * the digest no longer depends on any loop machinery (ledger, Notion auto
 * states, HMAC approval links). Producers:
 *   health-check.js            → data/audit/health-digest-snapshot.json
 *   send-daily-digest.js       → data/audit/daily-digest-snapshot.json
 *   reddit-engagement-digest.js→ data/audit/reddit-digest-snapshot.json
 *
 * send-opening-digest.js left this registry 2026-07-30 (owner ask): it sends
 * its own standalone daily email again and no longer writes a snapshot.
 *
 * Adding a digest = one row in SNAPSHOTS plus a renderer mapping in
 * send-morning-digest.js. Pure module, no I/O beyond readSnapshot's fs read
 * (CLAUDE.md §15: tests require() these functions directly).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const DEFAULT_AUDIT_DIR = path.join(REPO, 'data', 'audit');
const DEFAULT_DATA_DIR = path.join(REPO, 'data');

// maxAgeH 36 everywhere: every producer runs at least daily, so a snapshot
// older than 36h means the producer cron itself is stuck — the email must
// say so rather than pass off stale data as this morning's (and never
// silently omit it: plan-review finding, a delayed snapshot used to vanish
// without a trace).
const SNAPSHOTS = [
  { key: 'health', label: 'site health', file: 'health-digest-snapshot.json', maxAgeH: 36 },
  { key: 'dailyDigest', label: 'score-drift digest', file: 'daily-digest-snapshot.json', maxAgeH: 36 },
  { key: 'redditDigest', label: 'Reddit engagement', file: 'reddit-digest-snapshot.json', maxAgeH: 36 },
  // scripts/backlog-drain.js (task #654) — Mac-local, NOT committed (unlike
  // the three above, which are CI-produced and pulled via git): both the
  // producer and this consumer run on the same Mac via launchd, so there is
  // no cross-machine gap to bridge with a git commit.
  //
  // optionalIfMissing (ship-check adversarial finding): the launchd plist
  // ships DISABLED by default — until the owner enables it, this file never
  // exists, and a plain "missing" would show up as a permanent false
  // "didn't update overnight" banner line on every single morning digest.
  // 'missing' is suppressed for this entry only; 'stale'/'invalid' still
  // report — those mean the producer EXISTED and then broke, which is real
  // signal worth flagging.
  { key: 'backlogDrain', label: 'backlog drain', file: 'backlog-drain-metric.json', maxAgeH: 36, optionalIfMissing: true },
  // scripts/check-provider-spend.js (Scraping Cost System v2 Sprint 0) —
  // daily billing-API spend vs owner thresholds + 7-day verification streak.
  // CI-produced in data-health-check.yml and committed, like health above.
  // optionalIfMissing until the first daily run lands the file on main.
  { key: 'providerSpend', label: 'scraping spend', file: 'provider-spend-snapshot.json', maxAgeH: 36, optionalIfMissing: true },
];

/**
 * Read one snapshot file. Never throws.
 * @returns {{status:'fresh'|'stale'|'missing'|'invalid', snapshot:object|null, generatedAt:string|null}}
 */
function readSnapshot(filePath, maxAgeH, now = Date.now()) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { status: 'missing', snapshot: null, generatedAt: null }; }
  let snap;
  try { snap = JSON.parse(raw); }
  catch { return { status: 'invalid', snapshot: null, generatedAt: null }; }
  // JSON literal null/number/string parse fine but aren't snapshots — without
  // this guard, `null.generatedAt` throws and kills the whole send (ship-check
  // QA P0: a truncated producer write must degrade to one missing section,
  // never zero email).
  if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) {
    return { status: 'invalid', snapshot: null, generatedAt: null };
  }
  const t = new Date(snap.generatedAt).getTime();
  if (!Number.isFinite(t)) return { status: 'invalid', snapshot: null, generatedAt: null };
  const ageH = (now - t) / 3600e3;
  // A future generatedAt (beyond 1h of clock skew) is a producer clock/config
  // bug, not fresh data — without this it would render as "fresh" until the
  // wall clock caught up (ship-check codex P1).
  if (ageH < -1) return { status: 'invalid', snapshot: null, generatedAt: snap.generatedAt };
  if (!(ageH < maxAgeH)) return { status: 'stale', snapshot: null, generatedAt: snap.generatedAt };
  return { status: 'fresh', snapshot: snap, generatedAt: snap.generatedAt };
}

/**
 * Read every registered snapshot.
 * @returns {{sections: Record<string, object|null>, problems: Array<{key,label,status,generatedAt}>}}
 *   sections — fresh snapshot per key, null otherwise (render input)
 *   problems — every non-fresh source, for the "no fresh data from" banner
 */
function readAllSnapshots({ auditDir = DEFAULT_AUDIT_DIR, now = Date.now() } = {}) {
  const sections = {};
  const problems = [];
  for (const s of SNAPSHOTS) {
    const r = readSnapshot(path.join(auditDir, s.file), s.maxAgeH, now);
    sections[s.key] = r.snapshot;
    if (r.status !== 'fresh' && !(r.status === 'missing' && s.optionalIfMissing)) {
      problems.push({ key: s.key, label: s.label, status: r.status, generatedAt: r.generatedAt });
    }
  }
  return { sections, problems };
}

// One amber banner line naming every source that didn't deliver, with the
// last-write time when one exists — "stale silently vanishes" was the exact
// failure the plan review flagged. Plain-recipient wording ("didn't update
// overnight", not "snapshot"): the reader is not an engineer (ship-check
// fresh-eyes review).
function describeProblems(problems) {
  if (!problems || !problems.length) return null;
  const bits = problems.map((p) => {
    if (p.status === 'stale' && p.generatedAt) {
      return `${p.label} (last update ${String(p.generatedAt).slice(0, 16).replace('T', ' ')} UTC)`;
    }
    return `${p.label} (no data)`;
  });
  return `didn't update overnight: ${bits.join(', ')}`;
}

// data/freshness-report.json (task #689) — check-show-freshness.js's daily
// data-quality report, committed by the Auto-Maintain Show Data cron. It
// lives in data/, not data/audit/, so it isn't a row in SNAPSHOTS above; read
// it with its own small helper instead of bending readAllSnapshots' one
// auditDir contract around a single outlier.
function readFreshnessReport({ dataDir = DEFAULT_DATA_DIR, now = Date.now() } = {}) {
  return readSnapshot(path.join(dataDir, 'freshness-report.json'), 36, now);
}

// Flattens the report to the {generatedAt, bannerText, items, moreCount}
// shape renderNamedDigestBlock already knows how to render (same shape as
// backlogDrain/providerSpend) — no new render code needed. Keeps only what
// nobody read before this fix: 'high' severity issues (missing_poster,
// missing_tickets, missing/placeholder/stale synopsis) on OPEN shows, by show
// ID. report.dataQuality.byIssueType only lists titles, not IDs — this reads
// dataQuality.hasIssues instead so the digest can name the actual show.
// Returns null when there's nothing high-severity to show (quiet day).
function summarizeFreshnessHighSeverity(report, { maxItems = 8 } = {}) {
  if (!report || !Array.isArray(report.dataQuality?.hasIssues)) return null;
  const rows = [];
  for (const show of report.dataQuality.hasIssues) {
    // A malformed entry (null, issues not an array, or no id/title to
    // display) must degrade this show silently, not throw and kill the
    // whole digest send — same fail-soft contract as readSnapshot's
    // null/array guards above. Requiring id+title also stops a bare
    // "undefined — poster, tickets" line leaking into the owner's inbox
    // (ship-check finding: the old guard let a missing id/title through).
    if (!show || typeof show !== 'object' || !show.id || !show.title) continue;
    const highTypes = (Array.isArray(show.issues) ? show.issues : [])
      .filter((i) => i && i.severity === 'high')
      .map((i) => String(i.type || '').replace(/^missing_/, '').replace(/_/g, ' '));
    if (highTypes.length) rows.push({ id: show.id, title: show.title, highTypes });
  }
  if (!rows.length) return null;
  // Ticket/poster gaps are revenue-impacting (the whole reason task #689
  // exists); synopsis-only gaps are lower stakes. When the list is
  // truncated to maxItems, the most actionable rows must survive the cut
  // instead of being buried by source order (ship-check finding).
  rows.sort((a, b) => {
    const urgency = (r) => (r.highTypes.some((t) => t === 'tickets' || t === 'poster') ? 0 : 1);
    return urgency(a) - urgency(b);
  });
  return {
    generatedAt: report.generatedAt,
    // count: not part of renderNamedDigestBlock's own contract, but read by
    // send-morning-digest.js's top-verdict line so a real revenue-impacting
    // gap (missing tickets/poster) escalates there, not just in the
    // demoted-to-context box below (second-opinion design-blocker finding).
    count: rows.length,
    bannerText: `${rows.length} open show${rows.length === 1 ? '' : 's'} missing critical data (poster/tickets/synopsis)`,
    items: rows.slice(0, maxItems).map((r) => ({
      title: r.title,
      detail: `${r.id} — ${r.highTypes.join(', ')}`,
    })),
    moreCount: Math.max(0, rows.length - maxItems),
  };
}

module.exports = {
  SNAPSHOTS, readSnapshot, readAllSnapshots, describeProblems, DEFAULT_AUDIT_DIR,
  DEFAULT_DATA_DIR, readFreshnessReport, summarizeFreshnessHighSeverity,
};
