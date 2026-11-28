#!/usr/bin/env node
// scripts/lib/land-preflight-digest.js (BRO-5411) — one digest row for the
// review gate's land telemetry, same shape as infra-review-digest.js.
//
// Two inputs, because the hook ledger alone cannot see a stale container:
//   hookEvents  .claude/land-preflight.jsonl ({ts,event,reason,gatedLines,target})
//               — per-container, gitignored; only containers with the hook write it
//   landings    data/audit/landings.jsonl ({ts,branch,sha,receipt}) — committed by
//               land.yml for EVERY landing; `receipt` is the server-side verdict
//               (present|missing|malformed|not-required, absent on older rows)
// A landing whose receipt is `missing` or `malformed` (a gated diff over the
// line budget with no valid Review-Receipt trailer) and whose branch has no
// hook allow/bypass event is a stale-container landing.
//
// Run it where the hook ledger lives (or pass --events=), else every missing
// landing reads as stale. Merge-train riders carry no receipt (reported unknown).
//
// Pure function only (CLAUDE.md rule 15).
'use strict';

const WINDOW_MS = 24 * 60 * 60 * 1000;

function inWindow(ts, now, windowMs) {
  const t = Date.parse(ts || '');
  return Number.isFinite(t) && t <= now && now - t <= windowMs;
}

function computeLandPreflightDigest({ hookEvents = [], landings = [], now = 0, windowMs = WINDOW_MS } = {}) {
  const ev = (hookEvents || []).filter((e) => e && inWindow(e.ts, now, windowMs));
  const rows = (landings || []).filter((l) => l && inWindow(l.ts, now, windowMs));
  const blocked = ev.filter((e) => e.event === 'review-coverage-block');
  const allowed = ev.filter((e) => e.event === 'review-coverage-allow');
  const bypassed = allowed.filter((e) => /^NO-SHIP-CHECK bypass/.test(e.reason || ''));
  const covered = new Set(allowed.map((e) => e.target).filter(Boolean));

  const byReceipt = {};
  const stale = [];
  for (const l of rows) {
    const r = l.receipt || 'unknown';
    byReceipt[r] = (byReceipt[r] || 0) + 1;
    if ((r === 'missing' || r === 'malformed') && !covered.has(l.branch)) stale.push({ branch: l.branch, sha: l.sha, receipt: r });
  }
  const warn = stale.length > 0;
  return {
    name: 'Land review gate: telemetry',
    status: warn ? 'warn' : 'pass',
    message: `${rows.length} landings, ${blocked.length} blocked, ${allowed.length} allowed (${bypassed.length} bypassed), ${stale.length} with no review evidence (stale container)`,
    hint: warn ? 'Landings over the gated-line budget with no Review-Receipt and no hook event: the session ran without the gate. Check its container snapshot (.claude/CLOUD.md setup script).' : undefined,
    landings: rows.length,
    blocked: blocked.length,
    allowed: allowed.length,
    bypassed: bypassed.length,
    byReceipt,
    stale,
  };
}

module.exports = { WINDOW_MS, computeLandPreflightDigest };

if (require.main === module) {
  const fs = require('fs');
  const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
  const lines = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  let input;
  if (process.argv.includes('--sample')) {
    const now = Date.parse('2026-10-29T12:00:00Z');
    input = {
      now,
      hookEvents: [
        { ts: '2026-10-29T09:00:00Z', event: 'review-coverage-block', reason: 'review coverage incomplete', gatedLines: 120 },
        { ts: '2026-10-29T09:30:00Z', event: 'review-coverage-allow', reason: 'ship-check coverage complete', gatedLines: 120, target: 'land/bro-1-reviewed' },
      ],
      landings: [
        { ts: '2026-10-29T09:40:00Z', branch: 'land/bro-1-reviewed', sha: 'a'.repeat(40), receipt: 'present' },
        { ts: '2026-10-29T10:10:00Z', branch: 'land/job/stale-container', sha: 'b'.repeat(40), receipt: 'missing' },
      ],
    };
  } else {
    input = { now: Date.now(), hookEvents: lines(arg('events') || '.claude/land-preflight.jsonl'), landings: lines(arg('landings') || 'data/audit/landings.jsonl') };
  }
  console.log(JSON.stringify(computeLandPreflightDigest(input), null, 2));
}
