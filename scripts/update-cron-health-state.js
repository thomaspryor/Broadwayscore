#!/usr/bin/env node
'use strict';

/**
 * update-cron-health-state.js — writes data/audit/cron-health-state.json for
 * check-cron-health.yml and decides which stale crons have been broken long
 * enough to escalate (card #647, root cause (b)).
 *
 * Replaces the inline `jq -n` state write in the workflow. The reason it is a
 * script and not more shell: the escalation boundary is a real decision, and
 * CLAUDE.md rule 15 says a decision gets extracted to scripts/lib/ and tested
 * against the real function (scripts/lib/cron-stale-streak.test.mjs), not
 * re-implemented in a test fixture.
 *
 * Inputs (env, matching the workflow's existing shell variables):
 *   CURRENT_STALE     newline-separated friendly names stale at this check
 *   REDISPATCHED_NOW  newline-separated names self-healed this check
 *   STATE_FILE        defaults to data/audit/cron-health-state.json
 *   ESCALATE_AFTER_DAYS  defaults to 3
 *
 * Output: writes the state file and, if $GITHUB_OUTPUT is set, appends
 *   escalate_names=<;-separated>
 *   escalate_count=<n>
 * for the workflow's escalation step to consume.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { DEFAULT_ESCALATE_AFTER_DAYS, updateStaleStreaks } = require('./lib/cron-stale-streak');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_STATE_FILE = path.join(REPO_ROOT, 'data', 'audit', 'cron-health-state.json');

const USAGE = `update-cron-health-state.js — persist cron-health state + decide escalations

Reads CURRENT_STALE / REDISPATCHED_NOW from the environment (newline-separated
friendly names), writes STATE_FILE, and emits escalate_names/escalate_count to
$GITHUB_OUTPUT for crons stale ESCALATE_AFTER_DAYS (default ${DEFAULT_ESCALATE_AFTER_DAYS}) consecutive checks.

Options:
  --state-file=PATH   Override STATE_FILE
  --help              This message`;

function splitLines(value) {
  return String(value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return 0;
  }
  const { readState, writeState } = await import('./lib/cron-health-state.mjs');
  const fileArg = process.argv.slice(2).find((a) => a.startsWith('--state-file='));
  const stateFile = fileArg ? fileArg.slice('--state-file='.length) : process.env.STATE_FILE || DEFAULT_STATE_FILE;

  const prev = readState(stateFile);

  const currentStale = splitLines(process.env.CURRENT_STALE);
  const redispatched = splitLines(process.env.REDISPATCHED_NOW);
  const escalateAfterDays = Number(process.env.ESCALATE_AFTER_DAYS) || DEFAULT_ESCALATE_AFTER_DAYS;

  const { staleStreak, escalate, recovered } = updateStaleStreaks(prev, currentStale, { escalateAfterDays });

  const next = {
    stale: currentStale.slice().sort(),
    redispatched,
    staleStreak,
    updatedAt: new Date().toISOString(),
  };
  writeState(next, stateFile);

  for (const name of currentStale) {
    const days = (staleStreak[name] || {}).days || 0;
    const mark = days >= escalateAfterDays ? '🚨 ESCALATE' : '  ';
    console.log(`${mark} ${name}: stale ${days} consecutive day(s)`);
  }
  if (recovered.length) console.log(`✅ Streak cleared: ${recovered.join(', ')}`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `escalate_names=${escalate.join(';')}\nescalate_count=${escalate.length}\n`
    );
  }
  console.log(`${escalate.length} cron(s) at or past the ${escalateAfterDays}-day escalation boundary.`);
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code));

module.exports = { splitLines };
