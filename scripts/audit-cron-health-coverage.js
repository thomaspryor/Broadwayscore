#!/usr/bin/env node
// Audit check-cron-health.yml entries: max_hours must cover worst real cron gap + cushion.
// Fails CI when an entry would inevitably trip (false-positive alerts) or fails to alert
// (silent staleness). Surfaced by 2026-05-24 incident where Enrich WE/OB Dates was set to
// max=50h but real cadence is Mon+Thu (95h Thu→Mon gap).

const fs = require('fs');
const path = require('path');
const { isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt, worstGapHours, loadDigestCrons, validateExemptEntries, parseExemptEntries, parsePagingCrons, digestCadenceError } = require('./lib/cron-coverage');

const CUSHION_HOURS = 12;
const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');
const CHECK_FILE = path.join(WORKFLOWS_DIR, 'check-cron-health.yml');
const EXEMPT_FILE = path.join(__dirname, '..', '.cron-health-exempt.txt');

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
  // original pre-#409 geometry, hence the restored 26h band.
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
};

function extractCrons(wfPath) {
  if (!fs.existsSync(wfPath)) return [];
  const yaml = fs.readFileSync(wfPath, 'utf8');
  return [...yaml.matchAll(/-?\s*cron:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
}

function main() {
  const ch = fs.readFileSync(CHECK_FILE, 'utf8');
  // Entry format: "file.yml|max_hours|Friendly Name[|active_months]" — the
  // optional 4th field (e.g. "4-6") marks seasonal crons checked only in
  // those months.
  const entries = parsePagingCrons(ch).map(entry => ['', entry.workflow, String(entry.maxHours), entry.name, entry.activeMonths]);

  let failures = 0, warnings = 0, skipped = 0;
  console.log(`Auditing ${entries.length} check-cron-health entries (cushion: ${CUSHION_HOURS}h)\n`);

  for (const [, wf, maxStr, name, activeMonths] of entries) {
    const maxHours = parseInt(maxStr, 10);
    if (activeMonths) {
      console.log(`  \u23ed  ${name.padEnd(42)} seasonal (months ${activeMonths}) — recency checked in-season only`);
      skipped++;
      continue;
    }
    const crons = extractCrons(path.join(WORKFLOWS_DIR, wf));
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

  const digest = loadDigestCrons(path.join(__dirname, '..'));
  const exemptionErrors = validateExemptEntries(parseExemptEntries(fs.readFileSync(EXEMPT_FILE, 'utf8')), digest);
  for (const entry of parseExemptEntries(fs.readFileSync(EXEMPT_FILE, 'utf8')).filter(entry => entry.mode === 'digest')) {
    const workflowPath = path.join(WORKFLOWS_DIR, entry.workflow);
    if (!fs.existsSync(workflowPath)) continue; // Existing stale-exemption reporting below.
    const error = digestCadenceError(entry, fs.readFileSync(workflowPath, 'utf8'));
    if (error) exemptionErrors.push(error);
  }
  exemptionErrors.forEach(error => console.log(`  Invalid exemption: ${error}`));
  if (!digest.some(entry => entry.workflow === 'check-cron-health.yml')) {
    exemptionErrors.push('check-cron-health.yml needs an independent digest monitor');
    console.log('  Invalid coverage: check-cron-health.yml has no independent digest monitor');
  }
  const uncovered = findUncoveredScheduled(scheduled, covered, exempt);
  const stale = findStaleExempt(exempt, scheduledSet, covered);

  console.log(`\nCoverage: ${scheduled.length} scheduled workflows — ${covered.size} in CRITICAL_CRONS, ${exempt.size} exempt, ${uncovered.length} uncovered, ${digest.length} digest monitors, ${exemptionErrors.length} invalid exemptions.`);

  // Stale exempt entries are advisory (don't block) — they just mean the allowlist drifted.
  if (stale.notScheduled.length) {
    console.log(`  🟡 ${stale.notScheduled.length} exempt entr(ies) no longer scheduled (prune from .cron-health-exempt.txt): ${stale.notScheduled.join(', ')}`);
    warnings += stale.notScheduled.length;
  }
  if (stale.alsoCovered.length) {
    console.log(`  🟡 ${stale.alsoCovered.length} exempt entr(ies) also in CRITICAL_CRONS (remove from exempt): ${stale.alsoCovered.join(', ')}`);
    warnings += stale.alsoCovered.length;
  }

  let coverageFailures = exemptionErrors.length;
  if (uncovered.length) {
    console.log(`\n🔴 ${uncovered.length} scheduled workflow(s) have NO monitoring (not in CRITICAL_CRONS, not exempt):`);
    uncovered.forEach(f => console.log(`     ${f}`));
    console.log(`  fix: add each to check-cron-health.yml CRITICAL_CRONS (real-time paging) OR to`);
    console.log(`       .cron-health-exempt.txt (digest-only / low-stakes). Don't leave a cron unmonitored.`);
    coverageFailures += uncovered.length;
  }

  if (failures > 0) {
    console.log(`\n::error::${failures} check-cron-health entries are misconfigured — max_hours less than the worst cron gap.`);
    process.exit(1);
  }
  if (coverageFailures > 0) {
    console.log(`\n::error::${coverageFailures} scheduled workflow coverage errors: missing monitoring or invalid exemptions.`);
    process.exit(1);
  }
  if (warnings > 0 && process.argv.includes('--strict')) {
    process.exit(1);
  }
}

main();
