#!/usr/bin/env node
'use strict';

/**
 * Drops the stale 'upcoming' tag from shows whose status moved past it
 * (open, previews or closed; BRO-3208). Runs daily in update-show-status.yml.
 * Companion remediation for the stale-upcoming-tag opening-night check.
 *
 * Usage:
 *   node scripts/fix-stale-upcoming-tags.js              # dry-run, reports all matches
 *   node scripts/fix-stale-upcoming-tags.js --apply       # writes the fix for all matches
 *   node scripts/fix-stale-upcoming-tags.js --show=ID --apply   # scope to one show
 *   node scripts/fix-stale-upcoming-tags.js --check       # exit 1 if any stale tag remains
 */

const { hasStoredStaleUpcomingTag, stripUpcomingTag } = require('./lib/opening-night-completeness.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-stale-upcoming-tags.js — Drops the stale 'upcoming' tag from open, previews and closed shows.

Usage:
  node scripts/fix-stale-upcoming-tags.js [--apply] [--show=ID] [--check]
  node scripts/fix-stale-upcoming-tags.js --help, -h    print this usage and exit
`;

/**
 * @param {Object[]} shows
 * @param {string|null} showId - limit to one show id, or null for all
 * @returns {Object[]} shows that still carry a stale 'upcoming' tag
 */
function findStaleUpcomingTargets(shows, showId = null) {
  return (shows || []).filter(s => (!showId || s.id === showId) && hasStoredStaleUpcomingTag(s));
}

/**
 * @param {string[]} args - CLI args (process.argv.slice(2))
 * @param {Object} [deps]
 * @param {Function} [deps.loadShows]
 * @param {Function} [deps.saveShows]
 * @param {Function} [deps.log]
 * @param {Function} [deps.logError]
 * @returns {number} exit code: 0 clean/fixed, 1 --check found stale tags, 2 bad flags
 */
function run(args, deps = {}) {
  const log = deps.log || console.log;
  const logError = deps.logError || console.error;
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266, see scripts/lib/cli-help.js).
  if (hasHelpFlag(args)) { log(USAGE); return 0; }
  const apply = args.includes('--apply');
  const check = args.includes('--check');
  const showIdArg = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '') || null;
  if (check && apply) {
    logError('--check is read-only; run --apply and --check as two separate commands.');
    return 2;
  }

  let loadShows = deps.loadShows;
  let saveShows = deps.saveShows;
  if (!loadShows || !saveShows) {
    ({ loadShows, saveShows } = require('./lib/shows-write-guard'));
  }

  const data = loadShows();
  const targets = findStaleUpcomingTargets(data.shows, showIdArg);

  if (targets.length === 0) {
    log('No shows with a stale upcoming tag found.');
    return 0;
  }

  log(`${targets.length} show(s) with stale 'upcoming' tag:`);
  for (const s of targets) {
    log(`  - ${s.id} [${s.status}] (tags: ${JSON.stringify(s.tags)})`);
  }

  if (check) return 1;

  if (!apply) {
    log('\nDry run, pass --apply to drop the tag.');
    return 0;
  }

  // Re-select and strip on the file as re-read under the write lock, so a
  // concurrent edit to the same show's other fields or tags is not reverted
  // by this load-time snapshot.
  const fixed = [];
  const result = saveShows(data, {
    mutateFresh(fresh) {
      for (const s of findStaleUpcomingTargets(fresh.shows, showIdArg)) {
        if (stripUpcomingTag(s)) fixed.push(s.id);
      }
      return fixed.length > 0;
    },
  });

  if (!result || result.wrote === false) {
    log('\nNothing left to fix by the time the write lock was held; shows.json not written.');
    return 0;
  }
  log(`\nWrote shows.json (${result.lineCountBefore} -> ${result.lineCountAfter} lines). Fixed ${fixed.length} show(s).`);
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run, findStaleUpcomingTargets, USAGE };
