/**
 * guard-audit-io.js — reads the files the spend-guard audit (BRO-3011) needs
 * and runs guard-audit-core over them. Read-only, and deliberately free of
 * owner-alert-router: the weekly cost report renders through this path
 * (scripts/render-guard-audit.js), so it can never reach routeAlert().
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./guard-audit-core');
const { readLedger } = require('./breaker-transitions');
const { checkDailyBreakerPattern } = require('./check-daily-breaker-pattern');

const AUDIT = path.join(__dirname, '..', '..', 'data', 'audit');
const DEFAULT_SNAPSHOT_PATH = path.join(AUDIT, 'guard-audit-snapshot.json');
const THRESHOLDS = path.join(__dirname, '..', 'config', 'provider-spend-thresholds.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Run the audit over the repo's files; returns the snapshot. */
function runGuardAuditFromFiles({ env = process.env, now = new Date(), snapshotPath = env.GUARD_AUDIT_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH } = {}) {
  const bdZone = String(env.BRIGHTDATA_ZONE || '').trim() || 'web_unlocker2';
  const bdState = readJson(path.join(AUDIT, 'bd-circuit-breaker.json'));
  const states = {
    'sd-circuit-breaker': readJson(path.join(AUDIT, 'sd-circuit-breaker.json')),
    'sb-circuit-breaker': readJson(path.join(AUDIT, 'sb-circuit-breaker.json')),
  };
  // bd-circuit-breaker.json holds one entry per zone under `zones`.
  for (const [zone, z] of Object.entries((bdState && bdState.zones) || {})) states[`bd-circuit-breaker-${zone}`] = z;
  const ledger = readLedger();
  const snapshot = core.runGuardAudit({
    ledger,
    spendRows: readJsonl(path.join(AUDIT, 'scraper-spend-ledger.jsonl')),
    dailyRows: readJsonl(path.join(AUDIT, 'provider-spend-daily.jsonl')),
    states,
    thresholds: readJson(THRESHOLDS) || {},
    prevSnapshot: readJson(snapshotPath),
    nowIso: now.toISOString(),
    bdZone,
  });
  snapshot.dailyBreakerPattern = checkDailyBreakerPattern(ledger, {
    untilDay: now.toISOString().slice(0, 10), bdZone,
  });
  snapshot.items.push({ title: 'Data Validation fallback risk', detail: snapshot.dailyBreakerPattern.summary });
  return snapshot;
}

module.exports = { runGuardAuditFromFiles, DEFAULT_SNAPSHOT_PATH };
