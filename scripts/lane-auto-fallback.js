#!/usr/bin/env node
'use strict';
/**
 * BRO-6621: CLI for scripts/lib/opening-night-lane/auto-fallback.js (start the lane night run and its watchdog with no
 * cron on the critical path; fall back to the old path once when the lane dies).
 *
 *   start-plan --shows=a,b [--armed=1] [--seen-file=PATH] [--now=]
 *       Prints "SHOW NIGHT" per show whose lane night run and watchdog the orchestrator should dispatch now, or
 *       "SHOW NIGHT watchdog-only" when the night run started but its watchdog did not. Reads
 *       LANE_ONLY_MARKETS/_READ and LANE_STANDDOWN/_READ from env (read-lane-only-vars). --seen-file lists run titles
 *       from the last day, one per line; missing = the run list failed (start nothing).
 *   night-wait --show= --night= [--now=]
 *       Prints "ACTION SLEEP_MIN" (go | sleep-go | sleep-chain | late | unknown).
 *   hold-check --show=
 *       Exit 0 when LANE_ONLY_MARKETS (read live with VARS_TOKEN, else from env) covers the show and LANE_STANDDOWN was
 *       read and does not; exit 3 otherwise. The night-wait job runs it after its sleep, so a hold set during the day wins.
 *   The watchdog loop is scripts/lane-watchdog.js (kept apart so this CLI never loads the alert router).
 */
if (require.main === module) require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const af = require('./lib/opening-night-lane/auto-fallback');
const lom = require('./lib/opening-night-lane/lane-only-markets');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const flag = (n) => argv.includes(`--${n}`) || arg(n) === '1' || arg(n) === 'true';

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
  return Array.isArray(raw.shows) ? raw.shows : raw;
}
const findShow = (shows, id) => shows.find((s) => s.id === id || s.slug === id) || null;

/** {onlyMarkets, standdown} as {ok, value}, from the read-lane-only-vars env. */
function readVars(env = process.env) {
  const { onlyMarkets, standdown } = lom.envInputs(env);
  return { onlyMarkets, standdown };
}

/**
 * Live read of both variables (read-actions-variable.sh with VARS_TOKEN), so an owner switch flipped mid-night reaches
 * the watchdog within a tick. No VARS_TOKEN = the values the job read at its start.
 */
function readVarsLive() {
  if (!process.env.VARS_TOKEN) return readVars();
  const env = {};
  for (const name of ['LANE_ONLY_MARKETS', 'LANE_STANDDOWN']) {
    try {
      env[name] = execFileSync('bash', [path.join(__dirname, 'lib/read-actions-variable.sh'), name],
        { encoding: 'utf8', timeout: 25000, env: { ...process.env, GH_TOKEN: process.env.VARS_TOKEN } }).replace(/[\r\n]/g, '');
      env[`${name}_READ`] = 'ok';
    } catch { env[`${name}_READ`] = 'unknown'; }
  }
  return readVars(env);
}

function output(key, value) {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function startPlan() {
  const ids = String(arg('shows') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const seenFile = arg('seen-file');
  let seenTitles = null;
  if (seenFile && fs.existsSync(seenFile)) seenTitles = fs.readFileSync(seenFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const shows = loadShows();
  const vars = readVars();
  for (const id of ids) {
    const d = af.planNightStart({ show: findShow(shows, id), now: arg('now') || undefined, ...vars, armed: flag('armed'), seenTitles });
    console.error(`lane start ${id}: ${d.start ? 'START' : 'skip'} (${d.reason})`);
    if (d.start) console.log(`${id} ${d.night}${d.watchdogOnly ? ' watchdog-only' : ''}`);
  }
  return 0;
}

function nightWait() {
  const show = findShow(loadShows(), arg('show'));
  const d = af.planNightWait({ show, night: arg('night'), now: arg('now') || undefined });
  console.error(`night-wait ${arg('show')} ${arg('night')}: ${d.action} (${d.reason})`);
  console.log(`${d.action} ${d.sleepMin}`);
  return 0;
}

function holdCheck() {
  const show = findShow(loadShows(), arg('show'));
  const { onlyMarkets, standdown } = readVarsLive();
  const covers = !!show && af.laneOnlyCovers(onlyMarkets, show);
  const sd = !standdown.ok || (show && require('./lib/opening-night-lane/standdown').standsDown(standdown.value, show));
  if (covers && !sd) { console.log(`hold-check ${arg('show')}: lane-only, not stood down`); return 0; }
  console.log(`::notice::hold-check ${arg('show')}: ${!covers ? 'LANE_ONLY_MARKETS does not cover the show (shadow hold)' : 'LANE_STANDDOWN covers the show or is unreadable'}`);
  return 3;
}

async function main() {
  if (cmd === 'start-plan') return startPlan();
  if (cmd === 'night-wait') return nightWait();
  if (cmd === 'hold-check') return holdCheck();
  console.error('usage: lane-auto-fallback.js start-plan|night-wait|hold-check ...');
  return 2;
}

module.exports = { loadShows, findShow, readVars, readVarsLive, output, arg, flag };

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.log(`::error::lane-auto-fallback: ${e && e.message}`); process.exit(1); });
}
