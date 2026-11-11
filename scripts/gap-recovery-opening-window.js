#!/usr/bin/env node
/**
 * gap-recovery-opening-window.js (BRO-7389): NYT subscriber text recovery for
 * shows in their opening window, run every 20 min by launchd
 * (scripts/launchd/com.broadwayscore.gap-recovery-opening-window.plist).
 * Same driver, kill switch, run lock and ceilings as the nightly; it only
 * narrows to nytimes + shows opened in the last few days. Cheap when there is
 * nothing to do (no window shows, or no open NYT gap: the driver exits fast).
 *
 * Usage: node scripts/gap-recovery-opening-window.js [--dry-run] [--list]
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { selectOpeningWindowShows, driverArgsFor, inNightlyWindow } = require('./lib/gap-recovery-opening-window');

const ROOT = path.join(__dirname, '..');
const log = (m) => console.log(`[gap-opening ${new Date().toISOString()}] ${m}`);

function main() {
  const dry = process.argv.includes('--dry-run');
  if (inNightlyWindow() && !process.argv.includes('--list')) { log('nightly window (01:20-03:10): skipping so the nightly never finds the lock held'); return 0; }
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const ids = selectOpeningWindowShows(Array.isArray(raw) ? raw : raw.shows);
  log(`${ids.length} show(s) in opening window${ids.length ? ': ' + ids.join(', ') : ''}`);
  if (process.argv.includes('--list')) return 0;
  let worst = 0;
  for (const id of ids) {
    const args = [path.join(__dirname, 'gap-recovery-driver.js'), ...driverArgsFor(id), ...(dry ? ['--dry-run'] : [])];
    const r = spawnSync(process.execPath, args, {
      cwd: ROOT, env: { ...process.env, TIME_BUDGET_MIN: process.env.TIME_BUDGET_MIN || '15' },
      stdio: 'inherit', timeout: 20 * 60000, killSignal: 'SIGTERM',
    });
    if (r.error) log(`${id}: driver error: ${r.error.message}`);
    const code = r.status === null ? 1 : r.status;
    log(`${id}: driver exit ${code}`);
    if (code === 3) return 0; // another recovery run holds the lock: next tick retries
    worst = Math.max(worst, code); // 2 = shows.json unreadable (a real fault); no-GUI is exit 0 + browser_unavailable rows
  }
  return worst;
}

process.exit(main());
