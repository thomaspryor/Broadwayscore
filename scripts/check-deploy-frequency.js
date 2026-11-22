#!/usr/bin/env node
'use strict';
// BRO-8028: daily guard on production deploy frequency. Vercel bills per build
// (build CPU, ISR writes, cache invalidation), and 300-400 deploys/day cost ~$231
// in one cycle (Oct 21-Nov 20 2026). Counts READY production deploys in the last
// 24h and exits 1 above DEPLOY_FREQ_MAX (default 60; target is <= 48).
// Env: VERCEL_TOKEN (required), DEPLOY_FREQ_MAX, DEPLOY_FREQ_HOURS (default 24).
// Test seam: DEPLOY_FREQ_CREATED_JSON='[epochMs,...]' skips the API.
require('./lib/cli-help').exitOnHelp(module);

const PROJECT_ID = 'prj_wmBnDUrCQCwabIAYPbnMiIP3wg15';
const TEAM_ID = 'team_zvgatcxkXdPbfhtHQMOnjpXo';

function evaluate(createdMs, { nowMs, hours, max }) {
  const since = nowMs - hours * 3600 * 1000;
  const count = createdMs.filter((t) => t >= since).length;
  return { count, ok: count <= max, perDay: Math.round((count * 24) / hours) };
}

async function fetchCreated(token, sinceMs) {
  const out = [];
  let until = '';
  for (let page = 0; page < 20; page++) {
    const url = `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&target=production&state=READY&limit=100&since=${sinceMs}${until}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Vercel API ${res.status}`);
    const j = await res.json();
    const ds = j.deployments || [];
    out.push(...ds.map((d) => d.created));
    if (!j.pagination || !j.pagination.next || ds.length === 0) break;
    until = `&until=${j.pagination.next}`;
  }
  return out;
}

async function main() {
  const hours = Number(process.env.DEPLOY_FREQ_HOURS) || 24;
  const max = Number(process.env.DEPLOY_FREQ_MAX) || 60;
  const nowMs = Date.now();
  let created;
  if (process.env.DEPLOY_FREQ_CREATED_JSON) created = JSON.parse(process.env.DEPLOY_FREQ_CREATED_JSON);
  else {
    const token = process.env.VERCEL_TOKEN;
    if (!token) { console.log('::warning::[deploy-frequency] VERCEL_TOKEN unset, check skipped'); return; }
    created = await fetchCreated(token, nowMs - hours * 3600 * 1000);
  }
  const r = evaluate(created, { nowMs, hours, max });
  console.log(`[deploy-frequency] ${r.count} READY production deploys in the last ${hours}h (~${r.perDay}/day, limit ${max})`);
  if (!r.ok) {
    console.log(`::error::[deploy-frequency] ${r.count} production deploys in ${hours}h exceeds ${max}. Vercel bills per build; check should-deploy-gate.js min-interval and new dispatchers (BRO-8028).`);
    process.exitCode = 1;
  }
}

module.exports = { evaluate };
if (require.main === module) main().catch((e) => { console.log(`::warning::[deploy-frequency] check skipped: ${e.message}`); });
