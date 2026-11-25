#!/usr/bin/env node
'use strict';

/**
 * model-quality-scorecard.js (BRO-8289): did the Sonnet default make the site or the fixes worse?
 *
 *   node scripts/model-quality-scorecard.js [--switch=YYYY-MM-DD] [--json] [--no-linear]
 *
 * Read-only. Compares the 28 days before the switch with the days since, over ALL landed work
 * (not Sonnet vs Opus: Opus keeps the hard cards, so a per-family split measures task mix).
 * Metrics: cost per landed card, rework (a card landing again 6h-7d after a landing), extra land
 * attempts, reverts, cards reopened after Done (Linear, skipped with --no-linear or no key), plus the
 * latest site-health snapshot. Thresholds live in scripts/lib/model-quality-scorecard.js (THRESHOLDS).
 *
 * Verdict line: OK / WORSE / INSUFFICIENT DATA. Exit 0 only for OK, 1 for WORSE, 3 for INSUFFICIENT DATA
 * (never a pass), 2 for usage errors. Only landings on branches named after a card are counted.
 * Not covered, and said so: prod runtime errors (no keyless read), per-show review coverage.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { THRESHOLDS, computeScorecard, formatScorecard } = require('./lib/model-quality-scorecard.js');
const { readLedger } = require('./lib/claude-session-cost.js');
const { exitFlushed } = require('./lib/exit-flushed');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_SWITCH = '2026-11-25';
const USAGE = 'Usage: node scripts/model-quality-scorecard.js [--switch=YYYY-MM-DD] [--json] [--no-linear]\nRead-only quality scorecard: baseline (28 days before the switch) vs after. Exit 1 on WORSE.';

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Done -> reopened transitions since `sinceIso`, from Linear issue history. null when unreadable. */
async function fetchReopens(sinceIso) {
  try {
    require('./lib/load-env').loadEnv();
    if (!process.env.LINEAR_API_KEY) { console.error('[scorecard] no LINEAR_API_KEY; reopen metric skipped'); return null; }
    const { graphql } = require('./lib/linear-client.js');
    const q = `query($since: DateTimeOrDuration!, $after: String) { issues(first: 100, after: $after, filter: { team: { key: { eq: "BRO" } }, updatedAt: { gte: $since } }) { pageInfo { hasNextPage endCursor } nodes { identifier history(first: 50) { nodes { createdAt fromState { type } toState { type } } } } } }`;
    const out = [];
    let after = null;
    for (let page = 0; page < 60; page += 1) {
      const d = await graphql(q, { since: sinceIso, after });
      const conn = d.issues;
      for (const n of conn.nodes) {
        for (const h of (n.history && n.history.nodes) || []) {
          if (h.fromState && h.toState && h.fromState.type === 'completed' && h.toState.type !== 'completed' && h.toState.type !== 'canceled') {
            out.push({ ms: Date.parse(h.createdAt), card: n.identifier });
          }
        }
      }
      if (!conn.pageInfo.hasNextPage) return out;
      after = conn.pageInfo.endCursor;
    }
    return null; // too many pages: treat as unreadable rather than undercount
  } catch (e) {
    console.error(`[scorecard] Linear reopen read failed (${e && e.message}); reopen metric skipped`);
    return null;
  }
}

function siteHealthLines() {
  const lines = [];
  const h = readJson(path.join(REPO, 'data/audit/health-check-history.json'));
  if (h && Array.isArray(h.results)) {
    const bad = h.results.filter((r) => r.status && !['pass', 'ok'].includes(r.status));
    lines.push(`data-health-check ${h.lastRun}: ${bad.length} of ${h.results.length} checks not passing${bad.length ? ` (${bad.slice(0, 5).map((r) => r.name).join('; ')})` : ''}`);
  } else lines.push('data-health-check: no snapshot readable');
  const s = readJson(path.join(REPO, 'data/audit/time-to-publish-sla.json'));
  if (s && s.verdict) lines.push(`opening-night time-to-publish SLA ${s.generatedAt}: ${s.verdict.verdict} (evaluated ${s.verdict.evaluated}, compliance ${s.verdict.compliancePct === null ? 'n/a' : `${s.verdict.compliancePct}%`}, target ${s.verdict.targetPct}% within ${s.verdict.targetMinutes} min)`);
  else lines.push('time-to-publish SLA: no snapshot readable');
  lines.push('prod runtime errors and review coverage: not read here (no keyless source); check the Vercel runtime errors view by hand when the verdict is WORSE');
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(process.argv)) { console.log(USAGE); return 0; }
  const opts = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m || !['switch', 'json', 'no-linear'].includes(m[1])) { console.error(USAGE); return 2; }
    opts[m[1]] = m[2] === undefined ? true : m[2];
  }
  const switchDate = opts.switch || DEFAULT_SWITCH;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(switchDate)) { console.error(USAGE); return 2; }
  const landings = readJsonl(path.join(REPO, 'data/audit/landings.jsonl'));
  if (!landings.length) { console.error('[scorecard] data/audit/landings.jsonl missing or empty'); return 2; }
  const { rows: sessionRows } = readLedger({ file: path.join(REPO, 'data/audit/claude-session-cost.jsonl') });
  const nowMs = Date.now();
  const reopens = opts['no-linear'] ? null : await fetchReopens(new Date(Date.parse(`${switchDate}T00:00:00Z`) - THRESHOLDS.baselineDays * 86400 * 1000).toISOString());
  const sc = computeScorecard({ sessionRows, landings, reopens, switchDate, nowMs });
  if (opts.json) console.log(JSON.stringify(sc, null, 2));
  else console.log(formatScorecard(sc, { siteHealth: siteHealthLines() }));
  if (sc.verdict === 'WORSE') {
    console.log('ROLLBACK (one line): in .claude/settings.json delete the "model" key and its "_comment_model" line, set model: claude-opus-5-5 in .claude/agents/review-panelist.md and in EXPECTED in tests/unit/claude-agent-models.test.mjs, then land it. Keep this scorecard.');
    return 1;
  }
  if (sc.verdict === 'INSUFFICIENT DATA') {
    console.log('Not a pass: re-run after the windows fill (exit 3).');
    return 3;
  }
  return 0;
}

main().then((c) => exitFlushed(c), (e) => { console.error(`[scorecard] ${e && e.stack ? e.stack : e}`); exitFlushed(2); });
