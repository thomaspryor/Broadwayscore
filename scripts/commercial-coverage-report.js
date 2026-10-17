#!/usr/bin/env node
'use strict';
/**
 * Commercial coverage by season (BRO-4990).
 *
 * Weekly health output for commercial.json: of the Broadway shows that
 * opened since the research floor (2020-01-01) and ran 8+ weeks, how many
 * have a record and how many have a resolved (non-TBD) designation.
 * Uncovered shows are listed; the weekly research run's sweep picks them up.
 *
 * Usage:
 *   node scripts/commercial-coverage-report.js [--json] [--today=YYYY-MM-DD]
 *     [--fail-under=PCT]   exit 1 when overall coverage is below PCT
 *
 * With GITHUB_STEP_SUMMARY set, the markdown table is appended there too.
 */

const fs = require('fs');
const path = require('path');
const { computeCoverageBySeason, COMMERCIAL_RESEARCH_FLOOR } = require('./lib/commercial-queue');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const fmt = (p) => (p == null ? '—' : `${p}%`);

function main() {
  const today = typeof flag('today') === 'string' ? flag('today') : new Date().toISOString().slice(0, 10);
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')).shows || [];
  const commercial = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'commercial.json'), 'utf8'));
  let pendingShows = {};
  try {
    pendingShows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'commercial-pending-review.json'), 'utf8')).shows || {};
  } catch { /* no pending file */ }
  const rows = computeCoverageBySeason(shows, commercial, today, { pendingShows });

  const total = rows.reduce((t, r) => ({
    eligible: t.eligible + r.eligible,
    covered: t.covered + r.covered,
    resolved: t.resolved + r.resolved,
    pendingReview: t.pendingReview.concat(r.pendingReview),
    uncovered: t.uncovered.concat(r.uncovered),
  }), { eligible: 0, covered: 0, resolved: 0, pendingReview: [], uncovered: [] });

  const report = {
    today,
    since: COMMERCIAL_RESEARCH_FLOOR,
    coveragePct: pct(total.covered, total.eligible),
    resolvedPct: pct(total.resolved, total.eligible),
    ...total,
    seasons: rows.map(r => ({ ...r, coveragePct: pct(r.covered, r.eligible), resolvedPct: pct(r.resolved, r.eligible) })),
  };

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const lines = [
      `## Commercial coverage (Broadway, opened since ${COMMERCIAL_RESEARCH_FLOOR}, ran 8+ weeks)`,
      '',
      '| Season | Eligible | Has record | Coverage | Resolved (not TBD) | Researched, awaiting review |',
      '|---|---|---|---|---|---|',
      ...report.seasons.map(r => `| ${r.season} | ${r.eligible} | ${r.covered} | ${fmt(r.coveragePct)} | ${r.resolved} (${fmt(r.resolvedPct)}) | ${r.pendingReview.length} |`),
      `| **All** | ${total.eligible} | ${total.covered} | **${fmt(report.coveragePct)}** | ${total.resolved} (${fmt(report.resolvedPct)}) | ${total.pendingReview.length} |`,
      '',
      ...(total.pendingReview.length
        ? [`Awaiting human review (${total.pendingReview.length}, apply with apply-commercial-pending.js --show=SLUG): ${total.pendingReview.join(', ')}`, '']
        : []),
      total.uncovered.length
        ? `Uncovered (${total.uncovered.length}, queued by the weekly research sweep): ${total.uncovered.join(', ')}`
        : 'Uncovered: none',
    ];
    const md = lines.join('\n');
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }

  const failUnder = parseFloat(flag('fail-under'));
  if (Number.isFinite(failUnder) && report.coveragePct != null && report.coveragePct < failUnder) {
    console.error(`Coverage ${report.coveragePct}% is below --fail-under=${failUnder}%`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exit(main());
