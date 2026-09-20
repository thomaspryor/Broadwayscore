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
 * send-morning-digest.js. BOTH, always: a row with no renderer is a producer
 * running nightly for nobody, and it fails silently — the file is fresh, the
 * banner says nothing, and the line never appears. digest-snapshots.test.mjs
 * asserts every row has a `sections.<key>` consumer in the sender, so the
 * half-wired case cannot ship. A row that is deliberately banner-only (read
 * for the "didn't update overnight" warning, never rendered as a block) must
 * say so with bannerOnly: true.
 *
 * Pure module, no I/O beyond readSnapshot's fs read (CLAUDE.md §15: tests
 * require() these functions directly).
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
// bannerOnly (task #1003): read for the staleness banner, deliberately NOT
// rendered as a block. dailyDigest/redditDigest/backlogDrain lost their blocks
// in the Digest v3 subtraction (owner mandate 2026-08-02, which cut the "What
// changed" section down to one sentence); their producers still run and their
// staleness still warns. The flag exists so the renderer assertion in
// digest-snapshots.test.mjs can tell "intentionally quiet" from "someone
// forgot the second edit".
const SNAPSHOTS = [
  { key: 'health', label: 'site health', file: 'health-digest-snapshot.json', maxAgeH: 36 },
  { key: 'dailyDigest', label: 'score-drift digest', file: 'daily-digest-snapshot.json', maxAgeH: 36, bannerOnly: true },
  { key: 'redditDigest', label: 'Reddit engagement', file: 'reddit-digest-snapshot.json', maxAgeH: 36, bannerOnly: true },
  // backlogDrain REMOVED 2026-09-15 (BRO-3390). Its producer,
  // scripts/backlog-drain.js, was deliberately decommissioned on 2026-08-31
  // when the board moved to Linear — so data/audit/backlog-drain-metric.json
  // froze that day and this entry has been emitting a "backlog drain snapshot
  // is stale" line into the owner's morning digest every day since. 'stale'
  // is supposed to mean "the producer existed and then broke", which is real
  // signal; here the producer was retired on purpose, so the warning was
  // permanent, unactionable and exactly the kind of chronic false alarm that
  // teaches an owner to stop reading the digest. The continuous drain now
  // lives in dispatch-watchdog.js; surfacing ITS numbers here is tracked in
  // BRO-3431 along with the other Notion-sourced digest blocks.
  // scripts/check-provider-spend.js (Scraping Cost System v2 Sprint 0) —
  // daily billing-API spend vs owner thresholds + 7-day verification streak.
  // CI-produced in data-health-check.yml and committed, like health above.
  // optionalIfMissing until the first daily run lands the file on main.
  { key: 'providerSpend', label: 'scraping spend', file: 'provider-spend-snapshot.json', maxAgeH: 36, optionalIfMissing: true },
  // Coverage Verdict digest line (Coverage Verdict S3, task #905) —
  // scripts/produce-coverage-digest-snapshot.js formats show-review-gap.json's
  // censusVerdict into plain-English "N of M known reviews live" lines via
  // scripts/lib/coverage-digest.js. optionalIfMissing: a quiet day (nothing
  // incomplete) is the common case, not a producer failure.
  { key: 'coverageVerdict', label: 'coverage verdict', file: 'coverage-digest-snapshot.json', maxAgeH: 36, optionalIfMissing: true },
  // scripts/produce-trunk-snapshot.js (task #1003) — is test.yml green on
  // main, how long has it been red, which files are named in the failures.
  // The standing line exists because on 2026-08-04 main was red on ~96% of
  // runs from four independent failures and NOBODY noticed the aggregate:
  // three sessions each fixed the one failure they happened to see. Rendered
  // by send-morning-digest.js via renderTrunkDigestLine, and promoted to the
  // email HEADLINE once trunk has been red more than 24h.
  // optionalIfMissing: the producer needs gh auth, which CI runners and the
  // Mac both have but a partial checkout may not — a missing file must not
  // become a permanent false "didn't update overnight" banner.
  { key: 'trunk', label: 'trunk status', file: 'trunk-status-snapshot.json', maxAgeH: 36, optionalIfMissing: true },
  // scripts/audit-card-relevance.js (task #1719) — the P1 backlog relevance
  // sweep: is this open P1 still real, or LIKELY-DONE/DUPLICATE/STALE.
  // Shadow mode, run on demand (not cron-wired yet — the owner reviews the
  // first pass before any automation touches Notion), so maxAgeH is wide
  // (14 days) rather than the 36h every nightly producer uses; a narrower
  // window would falsely flag "didn't update overnight" for a report that
  // was never meant to run overnight. optionalIfMissing until the first run
  // lands the snapshot file.
  { key: 'p1RelevanceAudit', label: 'P1 backlog relevance audit', file: 'card-relevance-digest-snapshot.json', maxAgeH: 336, optionalIfMissing: true },
  // scripts/predispatch-queue-audit.js (task #1801) — tallies
  // predispatch-guard's (task #1800) verdicts across every queued card, so a
  // REOPEN-SUSPECT/DO-NOT-DISPATCH backlog spike (e.g. a
  // reconcile-dead-completions misfire) is visible in aggregate instead of
  // only as scattered individual dispatch refusals. Mac-local, same as
  // backlogDrain above — cron'd via com.broadwayscore.predispatch-queue-audit
  // (launchd), not committed. optionalIfMissing until the plist's first run
  // lands the file.
  { key: 'predispatchQueue', label: 'predispatch queue backlog', file: 'predispatch-queue-audit-snapshot.json', maxAgeH: 36, optionalIfMissing: true },
  // scripts/predispatch-queue-audit.js's second tally (task #1802) —
  // generalizes the row above from predispatch-guard alone to all 8 sibling
  // dispatch-guards.js predicates (deadDispatchGuard, parkedGuard,
  // staleOutcomeGuard, closedCardGuard, workBranchCollisionGuard,
  // exactTitleOverlapGuard, sessionTrackingCloneGuard, linearMirrorGuard), so
  // a spike in any ONE of them (e.g. a bad Linear mirror sync flagging many
  // cards) is visible instead of only as scattered individual dispatch
  // refusals. Same producer/run/plist as predispatchQueue above — one script,
  // two snapshot files. optionalIfMissing until the plist's first run after
  // this change lands the file.
  { key: 'dispatchGuardQueue', label: 'dispatch guard queue backlog', file: 'dispatch-guard-queue-audit-snapshot.json', maxAgeH: 36, optionalIfMissing: true },
  // scripts/audit-done-evidence.js (BRO-3426) — the daily evidence
  // re-verification sweep: every Done(14d)/In Review/In Progress card's own
  // claimed evidence (a PR-EVIDENCE commit/PR, or its acceptance command)
  // re-proved against a fresh origin/main. Exists because completion on this
  // board is self-certified and nothing re-checked it: over 2026-09-13/15 the
  // owner closed 26+ cards BY HAND whose state was wrong. A STANDING line,
  // green or not, for the same reason as trunk above — a block that only
  // appears when it is angry teaches the reader that silence means "fine",
  // which is indistinguishable from a dead producer, and a dead producer is
  // the exact failure this sweep exists to catch in other people's work.
  // CI-produced in data-health-check.yml and committed, like health.
  // optionalIfMissing until the first daily run lands the file on main.
  { key: 'doneEvidence', label: 'done-evidence audit', file: 'done-evidence-digest-snapshot.json', maxAgeH: 36, optionalIfMissing: true },
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

// Flattens report.closingSoon (task #690) to the same {generatedAt,
// bannerText, items, moreCount} shape renderNamedDigestBlock already knows
// how to render — sibling field of the same freshness-report.json, same
// "computed daily and thrown away" bug class summarizeFreshnessHighSeverity
// above fixed for dataQuality.hasIssues (task #689). Only shows closing
// within urgentDays escalate the top verdict — a 60-day-out closing is a
// routine watch item, not something the owner needs to act on this morning.
// Returns null when there's nothing to show (no open show closes within 60
// days — the producer's own window).
function summarizeClosingSoon(report, { maxItems = 8, urgentDays = 14 } = {}) {
  if (!report || !Array.isArray(report.closingSoon)) return null;
  const rows = [];
  for (const show of report.closingSoon) {
    // Same fail-soft contract as summarizeFreshnessHighSeverity: a malformed
    // entry must degrade silently, not throw and kill the whole digest send,
    // and must not render a literal "undefined" line. closingDate is
    // validated here too (adversarial ship-check finding) — it's the one
    // field summarizeFreshnessHighSeverity doesn't have an analog for, and
    // without this guard a malformed producer row renders "closes undefined"
    // straight into the owner's inbox.
    if (!show || typeof show !== 'object' || !show.id || !show.title || !show.closingDate) continue;
    const daysLeft = Number(show.daysLeft);
    if (!Number.isFinite(daysLeft) || daysLeft <= 0) continue;
    rows.push({ id: show.id, title: show.title, closingDate: show.closingDate, daysLeft });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.daysLeft - b.daysLeft);
  const urgentCount = rows.filter((r) => r.daysLeft <= urgentDays).length;
  return {
    generatedAt: report.generatedAt,
    // count: not part of renderNamedDigestBlock's own contract, but read by
    // send-morning-digest.js's top-verdict line — only URGENT (<=urgentDays)
    // closings escalate there, same convention as summarizeFreshnessHighSeverity's
    // count field.
    count: urgentCount,
    bannerText: `${rows.length} open show${rows.length === 1 ? '' : 's'} closing within 60 days${urgentCount ? ` (${urgentCount} within ${urgentDays} days)` : ''}`,
    items: rows.slice(0, maxItems).map((r) => ({
      title: r.title,
      detail: `${r.id} — closes ${r.closingDate} (${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left)`,
    })),
    moreCount: Math.max(0, rows.length - maxItems),
  };
}

// sync-audit-checkout.sh blocked-sync snapshots (task #1563). One file PER
// SYNC_TAG (shadow/digest/backlog-drain/predispatch-queue-audit/nightly —
// see scripts/launchd/*.plist and scripts/autonomous-nightly.sh), not a
// single fixed filename, so this can't be a SNAPSHOTS row (readAllSnapshots
// reads exactly one path per key). Presence alone is the signal: the
// producer deletes its own file on the next successful sync, so any file
// that still exists means that job's checkout has been stale since its
// last blocked sync — unlike every other row above, there is no "missing =
// still waiting for the first run" quiet state to special-case; "missing"
// here IS the quiet day. Never throws — a broken read degrades to "nothing
// to report", same fail-soft contract as every other reader in this file.
//
// Wording note (review finding): most callers chain with `&&` and genuinely
// stop when sync-audit-checkout.sh exits non-zero, but scripts/autonomous-
// nightly.sh (SYNC_TAG=nightly) deliberately does NOT — it logs a warning
// and continues, because its triage/executor steps read from Notion and
// spawn their own isolated worktrees rather than depending on THIS
// checkout being current. "Refused to run" would be false for that caller,
// so the copy below says "blocked git sync" instead, which is accurate
// for every caller regardless of what it does afterward.
//
// RETURN SHAPE (BRO-3393). Everything except `tags`/`unreadable` is a VIEW
// MODEL - bannerText/items/moreCount exist to be rendered, and `items` is
// capped at maxItems. `tags` and `unreadable` are DECISION data: uncapped,
// and read by autofixShouldDryRun() to answer "did MY OWN launchd job's
// sync refuse?" - a question the capped render list cannot answer (tag 9 of
// 9 would be invisible to it). Keep the two roles labelled: a future change
// that starts slicing `tags` for display silently re-breaks the decision.
//
// `unreadableTags` names refusal files that exist but could not be parsed, or
// that carry no usable `tag` field. Those used to be skipped outright, so a
// truncated snapshot for the digest's OWN tag read as "nobody refused" and
// would let real card-filing/dispatch run against an untrusted checkout.
//
// The tag comes from the FILENAME, not the body (ship-check finding,
// BRO-3393): sync-audit-checkout.sh:111 writes exactly
// `sync-refused-${TAG}.json`, so the filename still identifies the owner of a
// file whose contents are garbage. Keying on the filename is what keeps a
// corrupt SIBLING snapshot from re-creating the very bug this change fixes —
// a single global "something was unreadable" counter would suppress the
// digest's auto-fix indefinitely, since only the owning job ever clears its
// own file.
const SYNC_REFUSED_NAME_RE = /^sync-refused-(.+)\.json$/;

// SYNC_REFUSED_READ_FAILED: the sentinel a caller gets when the refusal
// directory itself could not be listed for any reason OTHER than "it does not
// exist". `tags: null` is the important field — autofixShouldDryRun treats a
// missing tags array as "cannot tell whose refusal this is" and fails closed,
// which is the correct answer when the evidence is unreadable (ship-check
// finding, BRO-3393). A genuinely absent directory still returns null: that is
// a fresh checkout with no refusals, not an unreadable one.
const SYNC_REFUSED_READ_FAILED = Object.freeze({
  generatedAt: null,
  count: 0,
  tags: null,
  unreadable: 0,
  unreadableTags: [],
  readFailed: true,
  bannerText: 'sync-refusal snapshots could not be read — treating the checkout as untrusted',
  items: [],
  moreCount: 0,
});

function readSyncRefused({ auditDir = DEFAULT_AUDIT_DIR, maxItems = 8 } = {}) {
  let names;
  try { names = fs.readdirSync(auditDir); }
  catch (err) { return err && err.code === 'ENOENT' ? null : SYNC_REFUSED_READ_FAILED; }
  const rows = [];
  const unreadableTags = [];
  for (const name of names) {
    const nameMatch = SYNC_REFUSED_NAME_RE.exec(name);
    if (!nameMatch) continue;
    let snap;
    try { snap = JSON.parse(fs.readFileSync(path.join(auditDir, name), 'utf8')); }
    catch { unreadableTags.push(nameMatch[1]); continue; }
    if (!snap || typeof snap !== 'object' || !snap.tag) { unreadableTags.push(nameMatch[1]); continue; }
    rows.push(snap);
  }
  const unreadable = unreadableTags.length;
  // A file that exists but cannot be read is still evidence that SOME job
  // refused - returning null there would hide it from the email as well as
  // from the dry-run decision.
  if (!rows.length && !unreadable) return null;
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return {
    generatedAt: rows.length ? rows[0].at : null,
    count: rows.length,
    tags: rows.map((r) => String(r.tag)),
    unreadable,
    unreadableTags,
    bannerText: rows.length
      ? `${rows.length} launchd sync job(s) hit a blocked git sync (stale/dirty checkout): ${rows.map((r) => r.tag).join(', ')}`
        + (unreadable ? ` (+${unreadable} unreadable refusal snapshot(s): ${unreadableTags.join(', ')})` : '')
      : `${unreadable} unreadable sync-refusal snapshot(s) (${unreadableTags.join(', ')}) - a launchd sync job refused and its snapshot could not be parsed`,
    items: rows.slice(0, maxItems).map((r) => ({
      title: r.tag,
      // blockingFiles (BRO-2314) is the subset of dirtyFiles that origin/main
      // actually moves — the only files that can block a fast-forward. Naming
      // them here is the difference between an alert that says "dirty
      // checkout" and one that says which file to go look at; the six-day
      // outage this key was added for was visible in this very block every
      // morning and went unactioned because it named the wrong files.
      detail: `${r.reason || 'unknown'} — ${Number(r.behindCount) || 0} commit(s) behind origin/main as of ${String(r.at || '').slice(0, 16).replace('T', ' ')} UTC`
        + (Array.isArray(r.blockingFiles) && r.blockingFiles.length
          ? ` — blocked by: ${r.blockingFiles.join(', ')}`
          : ''),
    })),
    moreCount: Math.max(0, rows.length - maxItems),
  };
}

module.exports = {
  SNAPSHOTS, readSnapshot, readAllSnapshots, describeProblems, DEFAULT_AUDIT_DIR,
  DEFAULT_DATA_DIR, readFreshnessReport, summarizeFreshnessHighSeverity, summarizeClosingSoon,
  readSyncRefused,
  SYNC_REFUSED_READ_FAILED,
};
