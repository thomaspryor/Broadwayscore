#!/usr/bin/env node
/**
 * poller-failure-audience.js: is a Broadway show in this Opening Night Poller
 * run AND inside its opening window? (BRO-5479, owner decision 2026-10-16:
 * "A except for Broadway openings. I want to know then.")
 *
 * "Openings" means the opening window from scripts/lib/opening-window-backoff.js
 * ([openingDate-1d, openingDate+3d]). The orchestrator polls a 21-day lookback,
 * so a Broadway show stays in the poll for weeks after its opening; counting it
 * the whole time emailed the owner about routine failures with nothing to do
 * (Other Desert Cities, opened 10/18, paged on 10/21).
 *
 * Every poller failure goes through the auto-fix-first gate (BRO-5477: a fix
 * card first, email only if the fix fails). When this prints broadway=true,
 * opening-night-poller.yml's Notify step also emails the owner right away
 * (notify-failure's email_with_auto_fix); the fix card is still filed.
 *
 * Fail-open: an empty show list, a show with no category, a Broadway show with
 * no or an unparseable openingDate all count, and the workflow only skips the
 * immediate email on an explicit 'false'. An id that shows.json cannot answer
 * for (shows.json unreadable because the run died in checkout-core-data, or the
 * id is not in it) counts too, UNLESS the id itself ends in a non-Broadway
 * market suffix (-off-broadway-YYYY, -west-end-YYYY, -off-west-end-YYYY):
 * tests/unit/poller-failure-audience.test.mjs checks every such id in
 * shows.json is non-Broadway. Tours are left out (a Broadway title can end in
 * "tour", and the poller never polls tours). BRO-7029 night: three Off-Broadway polls died before shows.json
 * loaded and the owner got a [CRITICAL] email they had opted out of.
 *
 *   node scripts/poller-failure-audience.js --shows=a,b
 *
 * Writes broadway=true|false to $GITHUB_OUTPUT. Always exits 0.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { isInOpeningWindow } = require('./lib/opening-window-backoff');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

function parseShowIds(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Ids whose market is certain from the id alone. Plain `<title>-YYYY` ids are
// Broadway OR regional, so they stay fail-open.
const NON_BROADWAY_ID_RE = /-(off-broadway|west-end|off-west-end)-\d{4}$/;

/** Pure: true when the id alone says the show is not Broadway. */
function isNonBroadwayId(id) {
  return NON_BROADWAY_ID_RE.test(String(id || ''));
}

/** Pure: a Broadway show in its opening window, or one we cannot date. */
function isBroadwayOpening(show, now) {
  if (!show) return true;
  if ((show.category || 'broadway') !== 'broadway') return false;
  // isInOpeningWindow fails closed on an unparseable date; this alert fails open.
  if (show.openingDate && Number.isNaN(new Date(show.openingDate).getTime())) return true;
  return isInOpeningWindow(show, now);
}

/** Pure: true when the poll includes a Broadway opening (or cannot tell). */
function isBroadwayPoll(showIds, shows, now = new Date()) {
  if (!showIds.length) return true;
  const byId = new Map((Array.isArray(shows) ? shows : []).filter((s) => s && s.id).map((s) => [s.id, s]));
  return showIds.some((id) => {
    const show = byId.get(id);
    if (!show) return !isNonBroadwayId(id);
    return isBroadwayOpening(show, now);
  });
}

function loadShows() {
  try {
    return JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows || null;
  } catch {
    return null;
  }
}

function main(argv = process.argv.slice(2)) {
  const arg = argv.find((a) => a.startsWith('--shows='));
  const showIds = parseShowIds(arg ? arg.slice('--shows='.length) : '');
  const broadway = isBroadwayPoll(showIds, loadShows());
  console.log(`[poller-failure-audience] shows=${showIds.join(',') || '(none)'} broadway=${broadway}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `broadway=${broadway ? 'true' : 'false'}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { parseShowIds, isBroadwayPoll, isBroadwayOpening, isNonBroadwayId, main };
