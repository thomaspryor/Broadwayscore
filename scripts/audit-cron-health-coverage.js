#!/usr/bin/env node
// Audit check-cron-health.yml entries: max_hours must cover worst real cron gap + cushion.
// Fails CI when an entry would inevitably trip (false-positive alerts) or fails to alert
// (silent staleness). Surfaced by 2026-05-24 incident where Enrich WE/OB Dates was set to
// max=50h but real cadence is Mon+Thu (95h Thu→Mon gap).

const fs = require('fs');
const path = require('path');

const CUSHION_HOURS = 12;
const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');
const CHECK_FILE = path.join(WORKFLOWS_DIR, 'check-cron-health.yml');

// Entries whose max_hours is intentionally tighter than worst-gap + CUSHION_HOURS.
// These trade the standard cron-lag cushion for SAME-DAY detection and are exempt
// from the cushion warning (the false-positive risk is accepted by design).
// DO NOT "fix" these by raising max_hours — doing so silently defeats the detection
// they exist for. Map: workflow filename → { maxHours, why }.
const TIGHT_BY_DESIGN = {
  // Digest carrier: a single cancelled run blacks out all non-critical alerting.
  // 26h (vs the generic 36h for a daily cron) is required so the noon-UTC check
  // catches a cancel SAME day before the next day's success resets the clock.
  // See Notion 381637c5-416f-81af and the comment on this entry in check-cron-health.yml.
  'data-health-check.yml': { maxHours: 26, why: 'same-day digest-carrier cancel detection' },
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
  const entries = [...ch.matchAll(/"([a-z0-9-]+\.yml)\|(\d+)\|([^"]+)"/g)];

  let failures = 0, warnings = 0, skipped = 0;
  console.log(`Auditing ${entries.length} check-cron-health entries (cushion: ${CUSHION_HOURS}h)\n`);

  for (const [, wf, maxStr, name] of entries) {
    const maxHours = parseInt(maxStr, 10);
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
  if (failures > 0) {
    console.log(`\n::error::${failures} check-cron-health entries are misconfigured — max_hours less than the worst cron gap.`);
    process.exit(1);
  }
  if (warnings > 0 && process.argv.includes('--strict')) {
    process.exit(1);
  }
}

main();
