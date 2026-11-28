#!/usr/bin/env node
'use strict';
/**
 * Browserbase cost for the weekly Scraper Cost Report (BRO-8268).
 *
 * The report used to price Browserbase at sessions x $0.10. Browserbase bills
 * browser-hours against a $20/month plan, not sessions, so that overstated the
 * bill ~10x (week to 2026-11-24: report said $97.10 for 971 sessions, billed
 * model says ~$6.60) and tripped the report's red "Browserbase spike" alert
 * (> $50/week) on phantom spend. BRO-3240 fixed the same mistake for the daily
 * digest; this reads the daily records that fix produces
 * (data/audit/provider-spend-daily.jsonl, priced by provider-spend-core bbCost,
 * cross-checked against real invoices) instead of re-deriving a price.
 *
 * Falls back to the old sessions x $0.10 figure, labelled as an estimate, when
 * fewer than MIN_DAYS of the last 7 complete days have a billed record. That
 * fallback over-states, the safe direction for a spike alarm.
 *
 * CLI: node scripts/lib/browserbase-week-cost.js --sessions=N [--file=PATH]
 *   prints "<usd>|<billed|estimate>|<days>"
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'audit', 'provider-spend-daily.jsonl');
const LEGACY_PER_SESSION_USD = 0.10;
const MIN_DAYS = 5;

function windowDays(now = new Date()) {
  const out = [];
  for (let i = 7; i >= 1; i--) out.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  return out;
}

/** @param {string} text jsonl  @returns {{cost:number, source:'billed'|'estimate', days:number}} */
function weekCost(text, { sessions = 0, now = new Date() } = {}) {
  const want = new Set(windowDays(now));
  const byDay = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const bb = r && r.providers && r.providers.browserbase;
    // minutes required: pre-BRO-3240 rows priced cost as sessions x $0.10 and had no minutes
    if (!r || !want.has(r.day) || !bb || bb.status !== 'ok' || !Number.isFinite(bb.cost) || !Number.isFinite(bb.minutes)) continue;
    byDay.set(r.day, bb.cost); // last record for a day wins
  }
  const days = byDay.size;
  if (days >= MIN_DAYS) {
    const sum = [...byDay.values()].reduce((a, b) => a + b, 0);
    return { cost: +(sum * 7 / days).toFixed(2), source: 'billed', days };
  }
  const n = Number(sessions);
  return { cost: +((Number.isFinite(n) ? n : 0) * LEGACY_PER_SESSION_USD).toFixed(2), source: 'estimate', days };
}

module.exports = { weekCost, windowDays, MIN_DAYS, LEGACY_PER_SESSION_USD };

if (require.main === module) {
  const arg = (k) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
  let text = '';
  try { text = fs.readFileSync(arg('file') || DEFAULT_FILE, 'utf8'); } catch { text = ''; }
  const r = weekCost(text, { sessions: arg('sessions') || 0 });
  process.stdout.write(`${r.cost.toFixed(2)}|${r.source}|${r.days}\n`);
}
