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
 * (full current view) and data/audit/broadway-source-coverage-state.json
 * (first-seen ledger + the `guard` record below). Alerts (Discord, log-only
 * per email-broadcast-rules.md) when new gaps appear.
 *
 * S4-T2 (2026 data audit, BRO-4204) — honouring "rotted": checkSilentRot()
 * returns 'rotted' when Playbill's page fetched fine but the parser found 0
 * entries for >24h (a DOM change). Before S4-T2 this script logged that,
 * then carried on: 0 entries → 0 gaps → wrote `{count: 0, gaps: []}` and
 * exited 0, so a blind guard was indistinguishable from a clean one (it sat
 * that way for ~24 runs). Now the decision is a pure function
 * (decideCoverageOutcome): 'rotted' → record `guard: {blind: true, count:
 * null}` in the state file, leave the gaps file UNTOUCHED (the last real view
 * beats a fake empty one), exit 1. The workflow step stays
 * continue-on-error so status flips still run; the separate
 * discovery-source-blind job (scripts/check-discovery-source-blind.js)
 * reads `guard.blind` and turns the run red.
 *
 * Usage: node scripts/check-broadway-source-coverage.js [--dry-run]
 *          [--fixture=<json>] [--audit-dir=<dir>] [--shows=<path>]
 */

const USAGE = `check-broadway-source-coverage.js — diff Playbill's announced
Broadway schedule against shows.json and name what's missing.

Usage:
  node scripts/check-broadway-source-coverage.js [--dry-run]

Options:
  --dry-run            Print gaps; skip audit-file write and alert
  --fixture=<json>     Use {entries, html} from this file instead of scraping
                       Playbill (test seam — pair with
                       PLAYBILL_BROADWAY_LAST_SUCCESS_PATH to drive the rot
                       decision against a scratch last-success file)
  --audit-dir=<dir>    Write the gaps/state files here (default data/audit)
  --shows=<path>       Read this shows.json (default data/shows.json)
  --help, -h           Show this help

Exit codes: 0 = ran; 1 = Playbill source failed or parser rotted (guard is
blind — gaps file left untouched, state file records guard.blind: true).`;

function hasHelpFlag(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

function argValue(argv, flag) {
  const hit = argv.find(a => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
}

/**
 * Pure decision (CLAUDE.md §15): what this run does with checkSilentRot()'s
 * verdict. Only 'rotted' means blind — 'grace' is the first 24h of a 0-entry
 * parse, which is still treated as a transient and proceeds as before.
 *
 * @param {'ok'|'grace'|'rotted'|string} rot
 * @returns {{ blind: boolean, exitCode: 0|1, writeGaps: boolean, reason: string }}
 */
function decideCoverageOutcome(rot) {
  if (rot === 'rotted') return { blind: true, exitCode: 1, writeGaps: false, reason: 'rotted' };
  return { blind: false, exitCode: 0, writeGaps: true, reason: rot };
}

/**
 * Pure: the state file with this run's `guard` record set. The rest of the
 * file is the per-gap first-seen ledger (keys are `<source>:<title>` from
 * reverse-discovery.js's candidateKey, so `guard` can never collide) and is
 * preserved untouched — a blind run must not forget when gaps were first seen.
 *
 * @param {object|null} prevState
 * @param {{ blind: boolean, count: number|null, reason: string, nowIso: string }} guard
 */
function buildGuardState(prevState, { blind, count, reason, nowIso }) {
  const state = { ...(prevState || {}) };
  state.guard = { blind, count, reason, at: nowIso };
  return state;
}

function readJsonOr(fs, p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }

  const fs = require('fs');
  const path = require('path');
  const { scrapePlaybillBroadwayData, checkSilentRot } = require('./lib/playbill-broadway-schedule');
  const { buildShowTitleIndex, findUnmatchedCandidates, candidateKey } = require('./lib/reverse-discovery');

  const dryRun = argv.includes('--dry-run');
  const fixturePath = argValue(argv, '--fixture');
  const showsPath = argValue(argv, '--shows') || path.join(__dirname, '..', 'data', 'shows.json');
  const auditDir = argValue(argv, '--audit-dir') || path.join(__dirname, '..', 'data', 'audit');
  const outPath = path.join(auditDir, 'broadway-source-coverage-gaps.json');
  const statePath = path.join(auditDir, 'broadway-source-coverage-state.json');

  let entries, html;
  try {
    if (fixturePath) {
      ({ entries = [], html = '' } = JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
      console.log(`--fixture: ${entries.length} entries, ${html.length} chars of HTML from ${fixturePath}`);
    } else {
      ({ entries, html } = await scrapePlaybillBroadwayData());
    }
  } catch (e) {
    console.error(`ERROR: Playbill Broadway schedule fetch failed (${e.message}) — coverage guard is blind this run.`);
    return 1;
  }
  // checkSilentRot sets process.exitCode=1 on drift but doesn't throw; its
  // return value ('ok' | 'grace' | 'rotted') is what S4-T2 acts on.
  const rot = checkSilentRot({ entries, html });
  const outcome = decideCoverageOutcome(rot);
  const nowIso = new Date().toISOString();

  if (outcome.blind) {
    console.error(`::error::Broadway source-coverage guard is BLIND (Playbill parser ${outcome.reason}: ${entries.length} entries from ${html.length} chars of HTML) — gaps file left untouched, exiting 1.`);
    if (dryRun) {
      console.log('--dry-run: state file not written.');
    } else {
      fs.mkdirSync(auditDir, { recursive: true });
      const state = buildGuardState(readJsonOr(fs, statePath, {}), { blind: true, count: null, reason: outcome.reason, nowIso });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
      console.log(`Wrote ${statePath} (guard.blind: true, count: null)`);
    }
    return outcome.exitCode;
  }

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
    return outcome.exitCode;
  }

  let state = readJsonOr(fs, statePath, {});
  const fresh = gaps.filter(g => !state[candidateKey(g)]);
  for (const g of fresh) state[candidateKey(g)] = { firstSeen: nowIso, title: g.title };
  // A healthy run clears any earlier blind record and stamps the real count.
  state = buildGuardState(state, { blind: false, count: gaps.length, reason: outcome.reason, nowIso });

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

  return outcome.exitCode;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, hasHelpFlag, USAGE, decideCoverageOutcome, buildGuardState };
