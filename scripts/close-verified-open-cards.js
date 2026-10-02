#!/usr/bin/env node
/**
 * BRO-4523: act on done-evidence-audit.json.
 *  - open cards whose own evidence holds on main (STUCK) and recheck-ledger
 *    passes, idle >=24h  -> linear-brain update --state Done (its Done gate
 *    re-runs the evidence on fresh main; a refusal is recorded, not forced)
 *  - In Review cards whose own check fails (openCheckFails), idle >=24h
 *    -> comment + move to Todo so the watchdog re-dispatches (cap 2 bounces)
 *
 * Dry-run by default; --apply performs the writes.
 * Kill switch: OPEN_CARD_CLOSER_KILL_SWITCH=true.
 */
'use strict';
require('./lib/load-env').loadEnv();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const planner = require('./lib/open-card-closer');

const AUDIT = path.join(__dirname, '..', 'data', 'audit', 'done-evidence-audit.json');
const LEDGER = path.join(__dirname, '..', 'data', 'audit', 'autonomous-recheck-ledger.jsonl');
const REPORT = path.join(__dirname, '..', 'data', 'audit', 'open-card-closer.json');
const MAX_WRITES = 40;
// Stop writing before the workflow step's timeout-minutes (12) can kill us.
const WRITE_BUDGET_MS = 9 * 60000;
const REFUSAL_COOLDOWN_MS = 7 * 24 * 3600 * 1000;

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function brainUpdate(id, state, comment) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'linear-brain.js'), 'update', id, '--state', state, '--comment', comment], { encoding: 'utf8', timeout: 180000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-400) };
}

async function main(argv = process.argv.slice(2)) {
  if (process.env.OPEN_CARD_CLOSER_KILL_SWITCH === 'true') { console.error('[open-card-closer] kill switch set — skipping'); return; }
  const apply = argv.includes('--apply');
  if (!fs.existsSync(AUDIT)) { console.error('[open-card-closer] no done-evidence-audit.json — nothing to do'); return; }
  const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
  if (audit.fetchError || !Array.isArray(audit.results)) { console.error('[open-card-closer] audit report is incomplete — refusing to act'); process.exitCode = 1; return; }
  const ageH = (Date.now() - Date.parse(audit.generatedAt)) / 3600000;
  if (!(ageH < 36)) { console.error(`[open-card-closer] audit report is ${ageH.toFixed(0)}h old — refusing to act on stale evidence`); process.exitCode = 1; return; }

  const { getIssue } = require('./lib/linear-client');
  const ld = require('./lib/linear-dispatch');
  const ledgerRows = readJsonl(LEDGER);
  // Re-read only the ids the planner could act on.
  const ids = new Set();
  for (const r of audit.results) if (r.verdict === 'STUCK' || r.openCheckFails) ids.add(r.id);
  for (const r of ledgerRows) if (/^BRO-\d+$/.test(String(r.cardId || ''))) ids.add(r.cardId);
  const cards = {};
  for (const id of ids) {
    try {
      const i = await getIssue(id);
      if (!i) continue;
      cards[id] = {
        priority: i.priority, state: i.state && i.state.name, stateType: i.state && i.state.type, updatedAt: i.updatedAt,
        comments: (i.comments && i.comments.nodes) || [],
        labels: ld.issueLabelNames(i),
      };
    } catch (e) { console.error(`[open-card-closer] could not read ${id}: ${e.message}`); }
  }

  // Cards the Done gate refused in the last 7 days are not retried daily.
  const skipIds = new Set();
  try {
    const prev = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
    for (const e of prev.entries || []) {
      if (e.action === 'close' && !e.applied && /refused/.test(e.result || '') && Date.now() - Date.parse(prev.generatedAt) < REFUSAL_COOLDOWN_MS) skipIds.add(e.id);
    }
  } catch { /* no previous report */ }
  const plan = planner.planOpenCardActions({ auditRows: audit.results, ledgerRows, getCard: (id) => cards[id] || null, now: Date.now(), skipIds });
  const rowById = new Map(audit.results.map((r) => [r.id, r]));
  const out = [];
  const started = Date.now();
  let writes = 0;
  const save = () => fs.writeFileSync(REPORT, JSON.stringify({ generatedAt: new Date(started).toISOString(), apply, entries: out }, null, 2) + '\n');
  for (const p of plan) {
    const entry = { ...p, applied: false };
    if (p.action !== 'skip' && apply && writes < MAX_WRITES && Date.now() - started < WRITE_BUDGET_MS) {
      writes++;
      if (p.action === 'close') {
        const r = brainUpdate(p.id, 'Done', planner.buildCloseComment(p.reason));
        entry.applied = r.ok; entry.result = r.ok ? 'closed' : `Done gate refused: ${r.out}`;
      } else {
        const row = rowById.get(p.id) || {};
        const n = planner.countBounces(cards[p.id]) + 1;
        const r = brainUpdate(p.id, 'Todo', planner.buildBounceComment({ cmd: row.cmd, detail: p.detail, n }));
        entry.applied = r.ok; entry.result = r.ok ? 'bounced' : `update failed: ${r.out}`;
      }
    }
    out.push(entry);
    if (entry.applied || entry.result) save(); // record each write immediately
    if (p.action !== 'skip') console.error(`[open-card-closer] ${apply ? (entry.result || 'capped') : 'dry-run'} ${p.action} ${p.id}: ${p.reason}`);
  }
  const counts = out.reduce((a, e) => { const k = e.applied ? e.result.split(' ')[0] : e.action; a[k] = (a[k] || 0) + 1; return a; }, {});
  fs.writeFileSync(REPORT, JSON.stringify({ generatedAt: new Date(started).toISOString(), apply, counts, entries: out }, null, 2) + '\n');
  console.error(`[open-card-closer] ${JSON.stringify(counts)}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { main };
