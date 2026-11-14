#!/usr/bin/env node
/**
 * visual-auto-ship-arm.js (BRO-7495) — turns visual auto-ship ON. Kept out of scripts/visual-approval.js on purpose:
 * workers use that CLI, and only the owner's go-ahead (or a session acting on the card's RECHECK-AFTER) arms this.
 *
 *   node scripts/visual-auto-ship-arm.js            # show whether the criteria hold, change nothing
 *   node scripts/visual-auto-ship-arm.js --confirm  # set the repo variable VISUAL_AUTO_SHIP=on (refuses unless criteria hold)
 *   node scripts/visual-auto-ship-arm.js --disarm   # set it to off (the instant kill switch)
 */
'use strict';
const { spawnSync } = require('child_process');
const { main: report } = require('./visual-shadow-report.js');

function setVar(value) {
  const r = spawnSync('gh', ['variable', 'set', 'VISUAL_AUTO_SHIP', '--body', value, '--repo', 'thomaspryor/Broadwayscore'], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`[arm] could not set VISUAL_AUTO_SHIP (${(r.stderr || r.error || '').toString().trim()}). Set the repo variable VISUAL_AUTO_SHIP to ${value} in GitHub: Settings, Secrets and variables, Actions, Variables.`); return 1; }
  console.log(`[arm] VISUAL_AUTO_SHIP=${value}`);
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--disarm')) return setVar('off');
  const code = await report(['--since=2026-11-14']);
  if (!argv.includes('--confirm')) return code;
  if (code !== 0) { console.error('[arm] refusing: the arming criteria do not hold yet'); return 1; }
  return setVar('on');
}
if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error(`[arm] ${e.stack || e.message}`); process.exitCode = 3; });
module.exports = { main };
