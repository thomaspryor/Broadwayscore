#!/usr/bin/env node
/**
 * Broadway source-coverage guard (card #1445).
 *
 * Per-source telemetry in scripts/lib/discovery-source-coverage.js catches a
 * discovery source going silent (contributing 0 candidates), but that isn't
 * the same question as "are we missing announced Broadway shows right now?"
 * — a source can be running fine and still not carry a given show (a
 * TodayTix listing gap, a title Playbill hasn't published yet under the
 * matched spelling, etc).
 *
 * This script answers that question directly: it re-scrapes Playbill's
 * "Schedule of Upcoming and Announced Broadway Shows" article (the same
 * source discover-new-shows.js unions in) and diffs its titles against the
 * open/upcoming Broadway shows already in shows.json. Anything Playbill
 * lists that we don't have is named, not silently dropped — this is what
 * would have caught the original TodayTix-only-for-months gap by comparing
 * against an independent upstream list instead of trusting our own output.
 *
 * NEVER writes shows.json. Writes data/audit/broadway-source-coverage-gaps.json
 * (full current view). Alerts (Discord, log-only per email-broadcast-rules.md)
 * when new gaps appear.
 *
 * Usage: node scripts/check-broadway-source-coverage.js [--dry-run]
 */

const USAGE = `check-broadway-source-coverage.js — diff Playbill's announced
Broadway schedule against shows.json and name what's missing.

Usage:
  node scripts/check-broadway-source-coverage.js [--dry-run]

Options:
  --dry-run     Print gaps; skip audit-file write and alert
  --help, -h    Show this help

Exit codes: 0 = ran; 1 = Playbill source failed (guard itself is blind).`;

function hasHelpFlag(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }

  const fs = require('fs');
  const path = require('path');
  const { scrapePlaybillBroadwayData, checkSilentRot } = require('./lib/playbill-broadway-schedule');
  const { buildShowTitleIndex, findUnmatchedCandidates, candidateKey } = require('./lib/reverse-discovery');

  const dryRun = argv.includes('--dry-run');
  const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
  const auditDir = path.join(__dirname, '..', 'data', 'audit');
  const outPath = path.join(auditDir, 'broadway-source-coverage-gaps.json');

  let entries, html;
  try {
    ({ entries, html } = await scrapePlaybillBroadwayData());
  } catch (e) {
    console.error(`ERROR: Playbill Broadway schedule fetch failed (${e.message}) — coverage guard is blind this run.`);
    return 1;
  }
  // checkSilentRot sets process.exitCode=1 on drift but doesn't throw — the
  // rest of this run still proceeds against whatever entries it did parse.
  checkSilentRot({ entries, html });

  // Only entries with a real venue + first-preview date are comparable to
  // catalogued shows — "IN THE WORKS" speculative titles have neither and
  // would false-positive as missing (they're not in shows.json by design).
  const datedEntries = entries.filter(e => e.venue && (e.firstPreview || e.opening));
  console.log(`Playbill Broadway schedule: ${entries.length} total entries, ${datedEntries.length} dated/venued`);

  // Broadway-only, not buildShowTitleIndex(shows, 'nyc') — that market scope
  // also admits Off-Broadway shows, so a Playbill-announced Broadway title
  // colliding with any current/closed/decades-old Off-Broadway production of
  // a similar name would silently read as "already covered" (the same
  // title-collision class reverse-discovery.js's own Gin Game/Midnight
  // comments describe). This guard's whole premise is Broadway vs Broadway.
  const allShows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
  const shows = allShows.filter(s => s.category === 'broadway');
  const index = buildShowTitleIndex(shows);
  console.log(`Loaded ${shows.length} Broadway shows of ${allShows.length} total (${index.exact.size} title variants)`);

  const items = datedEntries.map(e => ({
    title: e.title,
    source: 'playbill-broadway-schedule',
    url: e.url || 'https://playbill.com/article/schedule-of-upcoming-and-announced-broadway-shows',
    date: e.opening || e.firstPreview || null,
  }));
  // allowClosedRevival: Playbill's schedule is inherently about new/upcoming
  // productions, so a title matching ONLY a closed catalogued production
  // (same title, decades-old run) must surface as a gap, not read as
  // "already covered" — same reasoning audit-reverse-discovery.js applies to
  // its BWW roundup source.
  const gaps = findUnmatchedCandidates(items, index, { allowClosedRevival: true });

  console.log(`\n${gaps.length} show(s) on Playbill's announced schedule missing from shows.json:`);
  for (const g of gaps) console.log(`  "${g.title}" — ${g.url}`);
  if (gaps.length === 0) console.log('  (none)');

  if (dryRun) {
    console.log('\n--dry-run: no audit-file write, no alert.');
    return 0;
  }

  const statePath = path.join(auditDir, 'broadway-source-coverage-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  const nowIso = new Date().toISOString();
  const fresh = gaps.filter(g => !state[candidateKey(g)]);
  for (const g of fresh) state[candidateKey(g)] = { firstSeen: nowIso, title: g.title };

  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: nowIso, count: gaps.length, gaps }, null, 2) + '\n');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(`\nWrote ${outPath} (${gaps.length}) — ${fresh.length} new since last run`);

  if (fresh.length > 0) {
    const { sendAlert } = require('./lib/discord-notify');
    await sendAlert({
      severity: 'warning',
      title: `Broadway source coverage: ${fresh.length} announced show(s) missing from shows.json`,
      description: fresh.map(g =>
        `**${g.title}** — Playbill's announced schedule has this; shows.json doesn't.\nAdd: validate via \`node scripts/validate-show-venue.js\` then stub per CLAUDE.md §3`
      ).join('\n\n').slice(0, 3500),
    });
  }

  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, hasHelpFlag, USAGE };
