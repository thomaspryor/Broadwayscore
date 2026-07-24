#!/usr/bin/env node
// Audit check-cron-health.yml entries: max_hours must cover worst real cron gap + cushion.
// Fails CI when an entry would inevitably trip (false-positive alerts) or fails to alert
// (silent staleness). Surfaced by 2026-05-24 incident where Enrich WE/OB Dates was set to
// max=50h but real cadence is Mon+Thu (95h Thu→Mon gap).

const fs = require('fs');
const path = require('path');
const { isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt } = require('./lib/cron-coverage');

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
  // Digest carrier: a cancelled run blacks out all non-critical alerting.
  // 30h (vs the generic 36h daily cushion) keeps the band tight to the 24h
  // cadence so a dead cron trips fast, while leaving ~7h healthy-state slack.
  // The digest moved 07→16 UTC on 2026-07-24 (card #409); the noon-UTC check now
  // runs before it, so healthy age at check time rose from ~5h to ~20h and a
  // single cancel is caught at ~44h the next noon (not same-day). 30h (raised
  // from 26h in #409) restores slack so a lagged check can't false-trip and
  // self-heal into a duplicate digest email; it still catches the 44h case.
  // See Notion 381637c5-416f-81af and the comment on this entry in check-cron-health.yml.
  'data-health-check.yml': { maxHours: 30, why: 'digest-carrier cancel detection (tight to 24h cadence)' },
};

function parseField(field, min, max) {
  if (field === '*') return null; // wildcard
  const out = new Set();
  for (const part of field.split(',')) {
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      for (let v = min; v <= max; v += step) out.add(v);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let v = a; v <= b; v++) out.add(v);
    } else {
      out.add(parseInt(part, 10));
    }
  }
  return out;
}

// Compute worst-case gap (hours) across a 60-day window, treating multiple crons as a union.
function worstGapHours(cronExprs) {
  const matchers = cronExprs.map(expr => {
    const [m, h, dom, mon, dow] = expr.split(/\s+/);
    return {
      m: parseField(m, 0, 59),
      h: parseField(h, 0, 23),
      dom: parseField(dom, 1, 31),
      mon: parseField(mon, 1, 12),
      dow: parseField(dow, 0, 6),
    };
  });

  const fires = [];
  const start = new Date(Date.UTC(2026, 0, 5, 0, 0, 0)); // Mon 2026-01-05 — neutral start
  const WINDOW_MIN = 60 * 24 * 60; // 60 days

  for (let i = 0; i < WINDOW_MIN; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    const tm = t.getUTCMinutes(), th = t.getUTCHours();
    const tdom = t.getUTCDate(), tmon = t.getUTCMonth() + 1, tdow = t.getUTCDay();
    for (const c of matchers) {
      if (c.m && !c.m.has(tm)) continue;
      if (c.h && !c.h.has(th)) continue;
      if (c.mon && !c.mon.has(tmon)) continue;
      // cron oddity: when dom and dow are both set, they're an OR
      const domOk = !c.dom || c.dom.has(tdom);
      const dowOk = !c.dow || c.dow.has(tdow);
      if (c.dom && c.dow) {
        if (!domOk && !dowOk) continue;
      } else {
        if (!domOk || !dowOk) continue;
      }
      fires.push(t.getTime());
      break;
    }
  }

  if (fires.length < 2) return null; // can't determine (seasonal cron or never fires)

  let maxGap = 0;
  for (let i = 1; i < fires.length; i++) {
    maxGap = Math.max(maxGap, fires[i] - fires[i - 1]);
  }
  return Math.round(maxGap / 3_600_000);
}

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

  if (failures > 0) {
    console.log(`\n::error::${failures} check-cron-health entries are misconfigured — max_hours less than the worst cron gap.`);
    process.exit(1);
  }
  if (coverageFailures > 0) {
    console.log(`\n::error::${coverageFailures} scheduled workflow(s) are unmonitored — add to CRITICAL_CRONS or .cron-health-exempt.txt.`);
    process.exit(1);
  }
  if (warnings > 0 && process.argv.includes('--strict')) {
    process.exit(1);
  }
}

main();
