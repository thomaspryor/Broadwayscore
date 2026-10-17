#!/usr/bin/env node
/**
 * Off-Broadway source-coverage guard (BRO-4381). Mirrors
 * check-broadway-source-coverage.js for the OB market.
 *
 * discover-new-shows.js now unions TheaterMania's Off-Broadway listings
 * (market 98) into discovery, but a source can run fine and still leave a
 * production out (a gate, a dedup false-positive, a title variant). This
 * answers "which current OB productions does TheaterMania list that
 * shows.json doesn't have?" directly, against an independent upstream list,
 * the way the Broadway guard does against Playbill's schedule. It is how the
 * 16 missing OB shows in BRO-4377 would have been named.
 *
 * Alert-only. NEVER writes shows.json. Writes
 * data/audit/off-broadway-source-coverage-gaps.json (current view) and
 * data/audit/off-broadway-source-coverage-state.json (first-seen ledger +
 * `guard` record). Shows queued by a pending-fix add-show plan count as
 * covered. When the feed is blind (fetch failed, 0 rows, or rows but none
 * current) the gaps file is left untouched, the state records
 * `guard: { blind: true }` and the exit code is 1; update-show-status.yml's
 * discovery-source-blind job reads that record and turns the run red
 * (scripts/check-discovery-source-blind.js), same as the Broadway guard.
 * New gaps are logged through sendAlert (log-only at 'warning'; the daily
 * digest carries it).
 *
 * BRO-4396: also reports per-venue listings-reader coverage — every venue on
 * an Off-Broadway show, whether OB_VENUE_CONFIGS (or another reader) reads
 * it, and the ACTIVE ones (a show in the last 12 months) that have none —
 * into the same state file under `venueReaders`, and alerts the first time
 * an active venue with 2+ recent shows has no reader and no recorded reason
 * (scripts/lib/ob-venue-reader-coverage.js). Runs before the TheaterMania
 * fetch, so a blind feed does not hide it.
 *
 * Usage: node scripts/check-off-broadway-source-coverage.js [--dry-run]
 *          [--fixture=<json>] [--today=YYYY-MM-DD] [--audit-dir=<dir>] [--shows=<path>]
 */

'use strict';

const USAGE = `check-off-broadway-source-coverage.js — diff TheaterMania's current
Off-Broadway listings against shows.json and name what's missing.

Usage:
  node scripts/check-off-broadway-source-coverage.js [--dry-run]

Options:
  --dry-run            Print gaps; skip audit-file writes and alerts
  --fixture=<json>     Use {rows, venues, genres} from this file instead of the
                       TheaterMania API (test seam; rows are filtered to
                       current ones against --today)
  --today=YYYY-MM-DD   "Today" for the current-row filter (default: now)
  --audit-dir=<dir>    Write the gaps/state files here (default data/audit)
  --shows=<path>       Read this shows.json (default data/shows.json)
  --pending-dir=<dir>  Pending-fix plans (default data/pending-fixes)
  --help, -h           Show this help

Exit codes: 0 = ran; 1 = TheaterMania feed failed or is blind (gaps file left
untouched, state file records guard.blind: true).`;

function argValue(argv, flag) {
  const hit = argv.find(a => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
}

function readJsonOr(fs, p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }

  const fs = require('fs');
  const path = require('path');
  const {
    fetchTmOffBroadway, isCurrentTmRow, findTmCoverageGaps, decideTmCoverageOutcome,
  } = require('./lib/theatermania-ob');
  const { loadPendingAddShows } = require('./lib/pending-add-shows');
  const { candidateKey } = require('./lib/reverse-discovery');
  const { buildGuardState } = require('./check-broadway-source-coverage');
  const { isNonTheaterContent, isOneNightShow } = require('./discover-new-shows');

  const dryRun = argv.includes('--dry-run');
  const fixturePath = argValue(argv, '--fixture');
  const todayIso = argValue(argv, '--today') || new Date().toISOString().slice(0, 10);
  const showsPath = argValue(argv, '--shows') || path.join(__dirname, '..', 'data', 'shows.json');
  const auditDir = argValue(argv, '--audit-dir') || path.join(__dirname, '..', 'data', 'audit');
  const pendingDir = argValue(argv, '--pending-dir') || undefined;
  const outPath = path.join(auditDir, 'off-broadway-source-coverage-gaps.json');
  const statePath = path.join(auditDir, 'off-broadway-source-coverage-state.json');
  const nowIso = new Date().toISOString();

  await reportVenueReaderCoverage({ fs, showsPath, statePath, auditDir, todayIso, nowIso, dryRun });
  await reportVenueReaderCoverage({ fs, showsPath, statePath, auditDir, todayIso, nowIso, dryRun, market: 'london' });

  let feed;
  try {
    if (fixturePath) {
      const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      const rows = (fx.rows || []).filter(r => isCurrentTmRow(r, todayIso));
      feed = {
        rows,
        rawCount: (fx.rows || []).length,
        venuesById: new Map((fx.venues || []).map(v => [Number(v.id), v])),
        genresById: new Map((fx.genres || []).map(g => [Number(g.id), g.name])),
      };
      console.log(`--fixture: ${feed.rawCount} rows (${rows.length} current as of ${todayIso}) from ${fixturePath}`);
    } else {
      feed = await fetchTmOffBroadway({ todayIso });
    }
  } catch (e) {
    feed = { rows: [], rawCount: 0, error: e.message };
    console.error(`ERROR: TheaterMania OB fetch failed (${e.message})`);
  }

  const outcome = decideTmCoverageOutcome({ rawCount: feed.rawCount, currentCount: feed.rows.length });
  if (outcome.blind) {
    const reason = feed.error || outcome.reason;
    console.error(`::error::Off-Broadway source-coverage guard is BLIND (TheaterMania: ${reason}) — gaps file left untouched, exiting 1.`);
    if (!dryRun) {
      fs.mkdirSync(auditDir, { recursive: true });
      // The first-seen ledger is preserved: a blind run must not forget when
      // gaps were first seen (same rule as the Broadway guard).
      const state = buildGuardState(readJsonOr(fs, statePath, {}), { blind: true, count: null, reason, nowIso });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
      console.log(`Wrote ${statePath} (guard.blind: true)`);
    }
    return outcome.exitCode;
  }

  const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
  const pendingShows = loadPendingAddShows(pendingDir);
  const { gaps, parsedCount, skippedCount, gatedCount } = findTmCoverageGaps({
    rows: feed.rows, venuesById: feed.venuesById, genresById: feed.genresById,
    shows, pendingShows, gates: { isNonTheaterContent, isOneNightShow },
  });
  console.log(`TheaterMania OB: ${feed.rows.length} current rows, ${parsedCount} parsed (${skippedCount} skipped: venue/date), ${gatedCount} filtered by gates; ${pendingShows.length} show(s) queued in pending-fix plans`);

  console.log(`\n${gaps.length} current Off-Broadway production(s) on TheaterMania missing from shows.json:`);
  for (const g of gaps) console.log(`  "${g.title}" @ ${g.venue} (${g.date || 'no date'}${g.closingDate ? ` → ${g.closingDate}` : ''})${g.closedMatch ? ` [only closed row ${g.closedMatch} matches]` : ''} — ${g.url}`);
  if (gaps.length === 0) console.log('  (none)');

  if (dryRun) {
    console.log('\n--dry-run: no audit-file write, no alert.');
    return 0;
  }

  let state = readJsonOr(fs, statePath, {});
  const fresh = gaps.filter(g => !state[candidateKey(g)]);
  for (const g of fresh) state[candidateKey(g)] = { firstSeen: nowIso, title: g.title };
  state = buildGuardState(state, { blind: false, count: gaps.length, reason: outcome.reason, nowIso });

  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: nowIso, count: gaps.length, gaps }, null, 2) + '\n');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(`\nWrote ${outPath} (${gaps.length}) — ${fresh.length} new since last run`);

  if (fresh.length > 0) {
    const { sendAlert } = require('./lib/discord-notify');
    await sendAlert({
      severity: 'warning',
      title: `Off-Broadway source coverage: ${fresh.length} current production(s) missing from shows.json`,
      description: fresh.map(g =>
        `**${g.title}** @ ${g.venue} (${g.date || 'no date'}) — TheaterMania lists it; shows.json doesn't${g.closedMatch ? ` (only a closed row matches: ${g.closedMatch}; a return run needs a hand-added row, see .claude/CLOUD.md add-show)` : ''}.\n${g.url}`
      ).join('\n\n').slice(0, 3500),
    });
  }
  return 0;
}

// venue-write-guard-ok: reportVenueReaderCoverage writes venue strings to an
// audit state file (report rows), never to shows.json.
/**
 * BRO-4396 per-venue reader coverage; BRO-4398 added the London pool
 * (market 'london': Off-West End shows against OWE_VENUE_CONFIGS' dated
 * readers plus the VENUE_LISTING_PAGES link readers, recorded under
 * `venueReadersLondon`, with the venues only an undated link reader covers
 * listed apart). Never throws: a failure here logs and leaves the
 * TheaterMania guard to run.
 */
async function reportVenueReaderCoverage({ fs, showsPath, statePath, auditDir, todayIso, nowIso, dryRun, market = 'nyc' }) {
  const london = market === 'london';
  const label = london ? 'Off-West End' : 'Off-Broadway';
  const stateKey = london ? 'venueReadersLondon' : 'venueReaders';
  try {
    const { computeVenueReaderCoverage, diffUncovered, alertableUncovered, londonReaderConfigs } = require('./lib/ob-venue-reader-coverage');
    const { OB_VENUE_CONFIGS, OWE_VENUE_CONFIGS } = require('./lib/venue-listing-discover');
    // discover-new-shows.js is required lazily (it reads argv at load) and
    // only for the London link readers.
    const configs = london ? londonReaderConfigs(OWE_VENUE_CONFIGS, require('./discover-new-shows').VENUE_LISTING_PAGES) : OB_VENUE_CONFIGS;
    const readerList = london ? 'scripts/lib/venue-listing-discover.js OWE_VENUE_CONFIGS' : 'scripts/lib/venue-listing-discover.js OB_VENUE_CONFIGS';
    const reasonList = london ? 'LONDON_NO_READER_REASONS' : 'NO_READER_REASONS';
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
    const cov = computeVenueReaderCoverage({ shows, configs, todayIso, market });
    const alertable = alertableUncovered(cov.uncovered);
    console.log(`Venue reader coverage (${label}): ${configs.length} readers; ${cov.activeCovered}/${cov.active} active venue spellings covered (${cov.activeDated} by a dated reader); ${cov.uncovered.length} active house(s) without a reader, ${alertable.length} alertable (2+ recent shows, no recorded reason).`);
    for (const u of (london ? cov.undatedOnly : []).filter(x => x.recentShows >= 2)) {
      console.log(`  undated reader only: ${u.spellings.join(' / ')} (${u.recentShows} recent) — ${u.reader}`);
    }
    for (const u of cov.uncovered.filter(x => x.recentShows >= 2)) {
      console.log(`  no reader: ${u.spellings.join(' / ')} (${u.recentShows} recent)${u.noReaderReason ? ` — ${u.noReaderReason}` : ' — ALERT'}`);
    }
    if (dryRun) return;
    // Re-read: the NYC and London passes write the same state file in turn.
    const prev = readJsonOr(fs, statePath, {});
    const { ledger, fresh } = diffUncovered((prev[stateKey] && prev[stateKey].uncovered) || {}, alertable, nowIso);
    const next = {
      ...prev,
      [stateKey]: {
        at: nowIso,
        readers: configs.length,
        active: cov.active,
        activeCovered: cov.activeCovered,
        activeDated: cov.activeDated,
        uncovered: ledger,
        explained: cov.uncovered.filter(u => u.noReaderReason && u.recentShows >= 2).map(u => ({ venue: u.venue, recentShows: u.recentShows, reason: u.noReaderReason })),
        ...(london ? { undatedOnly: cov.undatedOnly.map(u => ({ venue: u.venue, recentShows: u.recentShows, reader: u.reader })) } : {}),
      },
    };
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n');
    if (fresh.length > 0) {
      const { sendAlert } = require('./lib/discord-notify');
      await sendAlert({
        severity: 'warning',
        title: `${label} venue coverage: ${fresh.length} active venue(s) with no listings reader`,
        description: fresh.map(u => `**${u.spellings.join(' / ')}**: ${u.recentShows} show(s) in the last 12 months (latest ${u.lastShow || 'n/a'}), and no reader in ${readerList}. Add one (a platform reader if the venue sells through OvationTix/Spektrix/NYTG) or record why in ${reasonList}.`).join('\n\n').slice(0, 3500),
      });
    }
  } catch (e) {
    console.warn(`::warning::${label} venue reader coverage failed (${e.message}); TheaterMania guard continues`);
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, USAGE };
