#!/usr/bin/env node
// Audit check-cron-health.yml entries: max_hours must cover worst real cron gap + cushion.
// Fails CI when an entry would inevitably trip (false-positive alerts) or fails to alert
// (silent staleness). Surfaced by 2026-05-24 incident where Enrich WE/OB Dates was set to
// max=50h but real cadence is Mon+Thu (95h Thu→Mon gap).

const fs = require('fs');
const path = require('path');
const {
  isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt,
  parseExemptEntries, findUnjustifiedExempt, findFalseDigestClaims, findDigestDrift,
  worstGapHours, extractCrons, classifyAlertPaths,
} = require('./lib/cron-coverage');
const { DIGEST_CRONS, DIGEST_ONLY } = require('./lib/health-digest-crons');
const { ORDERING, checkOrdering, fileReader } = require('./lib/cron-ordering');

const CUSHION_HOURS = 12;
const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');
const CHECK_FILE = path.join(WORKFLOWS_DIR, 'check-cron-health.yml');
const EXEMPT_FILE = path.join(__dirname, '..', '.cron-health-exempt.txt');
// BRO-2818: entries grandfathered from the 2026-06-28 bulk seed that still carry no
// justification. Only shrinks: a NEW exempt entry without a reason fails the audit.

// Entries whose max_hours is intentionally tighter than worst-gap + CUSHION_HOURS.
// These trade part of the standard cron-lag cushion for faster cancel detection
// and are exempt from the cushion warning (the false-positive risk is accepted by
// design). DO NOT "fix" these toward the generic 36h daily cushion — doing so
// silently defeats the detection they exist for. Map: workflow filename → { maxHours, why }.
const TIGHT_BY_DESIGN = {
  // Digest snapshot carrier: a cancelled run writes no snapshot, blacking out
  // all non-critical alerting for that day. 26h (vs the generic 36h daily
  // cushion) keeps the band tight to the 24h cadence so a dead cron trips
  // fast, while leaving ~2h healthy-state slack.
  // Card #364 (owner merge decision 2026-07-26) moved this back to 06:45 UTC —
  // the pre-#409 slot — since health-check.js no longer emails its own digest
  // (it writes data/audit/health-digest-snapshot.json; autonomous-email.js
  // folds it into the loop's single scheduled morning email), so #409's
  // reason for spacing it away from that email no longer applies. The
  // noon-UTC check now runs ~5h AFTER it (healthy age ~5h), matching the
  // original pre-#409 geometry, hence the restored 26h band. BRO-4800 moved
  // it to 02:15 UTC (schedule lag made 06:45 land after the 11:30 digest);
  // with lag on both crons the healthy age is ~6-12h, still well inside 26h.
  // See Notion 381637c5-416f-81af and the comment on this entry in check-cron-health.yml.
  'data-health-check.yml': { maxHours: 26, why: 'digest-snapshot-carrier cancel detection (tight to 24h cadence)' },
  // BRO-3666: this entry is tighter than worst-gap + CUSHION_HOURS for the
  // OPPOSITE reason to the one above — not because we want faster detection,
  // but because worstGapHours() is fiction for this workflow. It simulates the
  // cron EXPRESSION ('0 * * * *' -> gap=1h), whereas GitHub throttles this
  // repo's hourly schedules heavily and actually fires it every ~1.5-5.5h.
  // Measured over 2026-09-16 -> 2026-09-20 (30 runs): MAX observed gap 5h31m
  // (2026-09-20T07:08:39Z -> 12:39:26Z), with a cluster of 4h54m-5h31m gaps
  // in the 01:00-12:00 UTC band. The generic rule would demand 1h + 12h = 13h,
  // which is 12h of cushion over a 1h gap that never happens.
  // 8h = observed max + ~2.5h headroom. Do NOT widen toward 13h and do NOT
  // tighten back to the original 3h: 3h flagged a perfectly healthy workflow
  // on any noon following a normal throttle gap, which fired the self-heal
  // redispatch and then paged on the second consecutive check.
  'commercial-rss-poll.yml': { maxHours: 8, why: 'GitHub throttles this hourly cron to ~1.5-5.5h real cadence (max observed 5h31m, 2026-09-16->20); expression-derived gap=1h is fiction' },
  // BRO-3867: the same throttling (BRO-3666) hits every hourly/30-min cron in
  // this repo. Success-run gaps measured 2026-10-01 -> 10-22 (21 days, REST
  // API): p95 7-8.5h, max 9.6-12.1h. Each band is the smallest with 0 false
  // flags when the daily checker is replayed at every hour of the day, so a
  // drift in the checker's own run time cannot reintroduce false trips. The old
  // 2-5h bands false-tripped the real checker on 10-08, 10-12, 10-14, 10-15
  // and 10-20. Keep in sync with check-cron-health.yml.
  'audit-aggregator-gap.yml': { maxHours: 12, why: 'throttled hourly cron: real gap p95 8.0h, max 12.1h (2026-10-01->22)' },
  'opening-night-reviews.yml': { maxHours: 12, why: 'throttled ~3h cron: real gap p95 8.5h, max 11.4h (2026-10-01->22)' },
  'check-opening-night-drift.yml': { maxHours: 10, why: 'throttled 30-min cron: real gap p95 7.1h, max 9.7h (2026-10-01->22)' },
  'codex-lane-health.yml': { maxHours: 12, why: 'throttled hourly cron: real gap p95 8.0h, max 12.1h (2026-10-01->22); BRO-6134' },
  'opening-night-checklist.yml': { maxHours: 10, why: 'throttled hourly cron: real gap p95 7.1h, max 10.6h (2026-10-01->22)' },
  'opening-night-express-retry-check.yml': { maxHours: 10, why: 'throttled hourly cron: real gap p95 7.0h, max 9.6h (2026-10-01->22)' },
};

function extractCronsFromFile(wfPath) {
  return fs.existsSync(wfPath) ? extractCrons(fs.readFileSync(wfPath, 'utf8')) : [];
}

function main() {
  const ch = fs.readFileSync(CHECK_FILE, 'utf8');
  // Entry format: "file.yml|max_hours|Friendly Name[|active_months]" — the
  // optional 4th field (e.g. "4-6") marks seasonal crons checked only in
  // those months.
  const entries = [...ch.matchAll(/"([a-z0-9-]+\.yml)\|(\d+)\|([^"|]+)(?:\|(\d+-\d+))?"/g)];

  let failures = 0, warnings = 0, skipped = 0;
  console.log(`Auditing ${entries.length} check-cron-health entries (cushion: ${CUSHION_HOURS}h)\n`);

  for (const [, wf, maxStr, name, activeMonths] of entries) {
    const maxHours = parseInt(maxStr, 10);
    if (activeMonths) {
      console.log(`  \u23ed  ${name.padEnd(42)} seasonal (months ${activeMonths}) — recency checked in-season only`);
      skipped++;
      continue;
    }
    const crons = extractCronsFromFile(path.join(WORKFLOWS_DIR, wf));
    if (!crons.length) {
      console.log(`  ⏭  ${name.padEnd(42)} (${wf}): no cron found, manual-trigger only?`);
      skipped++;
      continue;
    }
    const gap = worstGapHours(crons);
    if (gap == null) {
      console.log(`  ⏭  ${name.padEnd(42)} (seasonal/no fires in window) [${crons.join(', ')}]`);
      skipped++;
      continue;
    }
    const required = gap + CUSHION_HOURS;
    const tight = TIGHT_BY_DESIGN[wf];
    if (maxHours < gap) {
      console.log(`  🔴 ${name.padEnd(42)} max=${maxHours}h < worst-gap=${gap}h — WILL alert on every long-leg cycle`);
      console.log(`     cron: ${crons.join(', ')}`);
      console.log(`     fix:  raise max_hours to ≥${required}h`);
      failures++;
    } else if (tight && tight.maxHours === maxHours) {
      // Intentionally tighter than the standard cushion — see TIGHT_BY_DESIGN.
      console.log(`  🛡  ${name.padEnd(42)} max=${maxHours}h (tight by design: ${tight.why})`);
    } else if (maxHours < required) {
      console.log(`  🟡 ${name.padEnd(42)} max=${maxHours}h, gap=${gap}h, cushion=${maxHours - gap}h (need ≥${CUSHION_HOURS}h for cron lag)`);
      warnings++;
    }
  }

  console.log(`\nSummary: ${failures} failures, ${warnings} warnings, ${skipped} skipped (seasonal/manual)`);

  // ── Coverage gate: every scheduled workflow must be in CRITICAL_CRONS or the exempt list ──
  // Catches a new cron shipping with ZERO monitoring (process-feedback.yml was disabled for
  // 15 days unnoticed because it was in neither list, 2026-06-11..26).
  const covered = new Set(entries.map(([, wf]) => wf));
  const allFiles = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.yml'));
  const scheduled = allFiles.filter(f => isScheduledWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')));
  const scheduledSet = new Set(scheduled);
  const exempt = parseExemptList(fs.existsSync(EXEMPT_FILE) ? fs.readFileSync(EXEMPT_FILE, 'utf8') : '');

  const uncovered = findUncoveredScheduled(scheduled, covered, exempt);
  const stale = findStaleExempt(exempt, scheduledSet, covered);

  console.log(`\nCoverage: ${scheduled.length} scheduled workflows — ${covered.size} in CRITICAL_CRONS, ${exempt.size} exempt, ${uncovered.length} uncovered.`);

  // Stale exempt entries are advisory (don't block) — they just mean the allowlist drifted.
  if (stale.notScheduled.length) {
    console.log(`  🟡 ${stale.notScheduled.length} exempt entr(ies) no longer scheduled (prune from .cron-health-exempt.txt): ${stale.notScheduled.join(', ')}`);
    warnings += stale.notScheduled.length;
  }
  if (stale.alsoCovered.length) {
    console.log(`  🟡 ${stale.alsoCovered.length} exempt entr(ies) also in CRITICAL_CRONS (remove from exempt): ${stale.alsoCovered.join(', ')}`);
    warnings += stale.alsoCovered.length;
  }

  let coverageFailures = 0;
  if (uncovered.length) {
    console.log(`\n🔴 ${uncovered.length} scheduled workflow(s) have NO monitoring (not in CRITICAL_CRONS, not exempt):`);
    uncovered.forEach(f => console.log(`     ${f}`));
    console.log(`  fix: add each to check-cron-health.yml CRITICAL_CRONS (real-time paging) OR to`);
    console.log(`       .cron-health-exempt.txt (digest-only / low-stakes). Don't leave a cron unmonitored.`);
    coverageFailures = uncovered.length;
  }

  // ── BRO-2818: the exempt list must say WHY, and its coverage claims must be true ──
  const exemptEntries = parseExemptEntries(fs.existsSync(EXEMPT_FILE) ? fs.readFileSync(EXEMPT_FILE, 'utf8') : '');
  const falseClaims = findFalseDigestClaims(exemptEntries, DIGEST_CRONS.map(d => d.workflow));
  // BRO-4941: the grandfathered baseline is gone; every exempt entry must carry a reason.
  const unjustified = findUnjustifiedExempt(exemptEntries);
  const paging = new Map(entries.map(([, wf, hrs]) => [wf, parseInt(hrs, 10)]));
  const drift = findDigestDrift(DIGEST_CRONS, paging, DIGEST_ONLY);

  console.log(`Exempt justification: ${exemptEntries.size - unjustified.length} of ${exemptEntries.size} carry a reason.`);
  if (drift.staleDigestOnly.length) {
    console.log(`  🟡 DIGEST_ONLY lists workflow(s) not in the digest (prune scripts/lib/health-digest-crons.js): ${drift.staleDigestOnly.join(', ')}`);
    warnings += drift.staleDigestOnly.length;
  }
  let justificationFailures = 0;
  if (falseClaims.length) {
    console.log(`\n🔴 exempt entr(ies) claim [digest] coverage but are not in health-check.js's digest list: ${falseClaims.join(', ')}`);
    console.log('  fix: add the workflow to scripts/lib/health-digest-crons.js, or drop the [digest] claim.');
    justificationFailures += falseClaims.length;
  }
  if (unjustified.length) {
    console.log(`\n🔴 exempt entr(ies) with no justification: ${unjustified.join(', ')}`);
    console.log('  fix: put a # comment above the entry (or inline) saying why a stale run is acceptable and what, if anything, watches it.');
    justificationFailures += unjustified.length;
  }
  if (drift.missingFromPaging.length || drift.hoursMismatch.length) {
    if (drift.missingFromPaging.length) console.log(`\n🔴 digest cron(s) missing from check-cron-health.yml CRITICAL_CRONS and not in DIGEST_ONLY: ${drift.missingFromPaging.join(', ')}`);
    if (drift.hoursMismatch.length) console.log(`\n🔴 digest vs paging max-hours mismatch: ${drift.hoursMismatch.join('; ')}`);
    console.log('  fix: scripts/lib/health-digest-crons.js and check-cron-health.yml CRITICAL_CRONS must agree.');
    justificationFailures += drift.missingFromPaging.length + drift.hoursMismatch.length;
  }

  // ── BRO-3492: which path tells someone each scheduled workflow stopped running ──
  // Advisory only (§19): opt-outs and uncomputable cadences are warnings, never failures.
  const paths = classifyAlertPaths(scheduled, paging, DIGEST_CRONS.map(d => d.workflow), exemptEntries);
  const byPath = { paged: [], digest: [], liveness: [], none: [] };
  for (const [f, p] of paths) byPath[p].push(f);
  console.log(`\nStopped-running alert paths: ${byPath.paged.length} paged (CRITICAL_CRONS), ${byPath.digest.length} digest row, ${byPath.liveness.length} default liveness sweep (health-check.js), ${byPath.none.length} opted out.`);
  if (process.argv.includes('--paths')) for (const [f, p] of paths) console.log(`     ${p.padEnd(8)} ${f}`);
  if (byPath.none.length) console.log(`  ℹ  opted out of liveness ([no-liveness: ...]): ${byPath.none.join(', ')}`);
  const noCadence = byPath.liveness.filter(f => worstGapHours(extractCronsFromFile(path.join(WORKFLOWS_DIR, f))) == null);
  if (noCadence.length) {
    console.log(`  🟡 ${noCadence.length} liveness-swept workflow(s) have no computable cadence (seasonal?) so the sweep skips them: ${noCadence.join(', ')}`);
    warnings += noCadence.length;
  }

  // ── BRO-4801: "B runs after A" assumptions between crons (scripts/lib/cron-ordering.js).
  // Advisory here (blocking in scripts/lib/cron-ordering.test.mjs).
  const orderingProblems = checkOrdering(fileReader(WORKFLOWS_DIR));
  console.log(`Cron ordering: ${ORDERING.length - new Set(orderingProblems.map(p => p.entry)).size} of ${ORDERING.length} registered orderings hold.`);
  for (const p of orderingProblems) {
    console.log(`  🟡 ${p.entry.before} -> ${p.entry.after}: ${p.problem}`);
    warnings++;
  }

  if (failures > 0) {
    console.log(`\n::error::${failures} check-cron-health entries are misconfigured — max_hours less than the worst cron gap.`);
    process.exit(1);
  }
  if (coverageFailures > 0) {
    console.log(`\n::error::${coverageFailures} scheduled workflow(s) are unmonitored — add to CRITICAL_CRONS or .cron-health-exempt.txt.`);
    process.exit(1);
  }
  if (justificationFailures > 0) {
    console.log(`\n::error::${justificationFailures} cron-coverage honesty problem(s) (BRO-2818) — see above.`);
    process.exit(1);
  }
  if (warnings > 0 && process.argv.includes('--strict')) {
    process.exit(1);
  }
}

main();
