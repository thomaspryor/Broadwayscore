#!/usr/bin/env node
/**
 * poller-failure-audience.js: is a Broadway show in this Opening Night Poller
 * run? (BRO-5479, owner decision 2026-10-16: "A except for Broadway openings.
 * I want to know then.")
 *
 * Every poller failure goes through the auto-fix-first gate (BRO-5477: a fix
 * card first, email only if the fix fails). When this prints broadway=true,
 * opening-night-poller.yml's Notify step also emails the owner right away
 * (notify-failure's email_with_auto_fix); the fix card is still filed.
 *
 * Fail-open: an empty show list, an id missing from shows.json, a show with
 * no category, or an unreadable shows.json all count as Broadway, and the
 * workflow only skips the immediate email on an explicit 'false'.
 *
 *   node scripts/poller-failure-audience.js --shows=a,b
 *
 * Writes broadway=true|false to $GITHUB_OUTPUT. Always exits 0.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

function parseShowIds(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Pure: true when the poll includes a Broadway show (or cannot tell). */
function isBroadwayPoll(showIds, shows) {
  if (!showIds.length || !Array.isArray(shows)) return true;
  const byId = new Map(shows.filter((s) => s && s.id).map((s) => [s.id, s]));
  return showIds.some((id) => ((byId.get(id) && byId.get(id).category) || 'broadway') === 'broadway');
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

module.exports = { parseShowIds, isBroadwayPoll, main };
