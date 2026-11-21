'use strict';

/**
 * land-merge-drivers.js (BRO-7631): the `-c merge.<name>.driver=...` arguments a land rebase passes to git.
 *
 * .gitattributes declares merge drivers (merge=ours, merge=keyed-jsonl) but a CI runner registers none,
 * and an undefined driver makes git text-merge silently. So every declared bot-state / ledger file still
 * conflicted in land.yml (about 65 of 143 captured conflict refusals in 30 days). The rebase paths
 * (land-rebase.sh via `node land-merge-drivers.js args <dir>`, land-branch.js via driverConfigArgs) pass these.
 *
 * `ours` (land-merge-driver.sh) keeps main's copy whole only for autostash=regenerated paths and text-merges the rest.
 * -c settings do not survive into a later `git rebase --continue`, so every continue must pass these again.
 * Helpers load from the BASE tree (callers `git show` them) so an old branch still gets them.
 * Kill switch: LAND_MERGE_DRIVERS_DISABLED=true.
 */

const path = require('path');

// name -> command template; %O %A %B %P are filled in by git.
// Files a caller must materialise beside each other (from the base tree) before using the args.
const DRIVER_FILES = ['land-merge-driver.sh', 'merge-keyed-jsonl.js', 'land-merge-drivers.js'];

const DRIVERS = {
  ours: (dir) => `bash '${path.join(dir, 'land-merge-driver.sh')}' %O %A %B %P`,
  'keyed-jsonl': (dir) => `node '${path.join(dir, 'merge-keyed-jsonl.js')}' %O %A %B %P`,
};

/** Names of the drivers this module registers (the class-guard test compares them with .gitattributes). */
const DRIVER_NAMES = Object.keys(DRIVERS);

/** @returns {string[]} git args like ['-c', 'merge.ours.driver=...']; [] when disabled. */
function driverConfigArgs(dir, env = process.env) {
  if (env.LAND_MERGE_DRIVERS_DISABLED === 'true') return [];
  return DRIVER_NAMES.flatMap((n) => ['-c', `merge.${n}.driver=${DRIVERS[n](dir)}`]);
}

if (require.main === module && process.argv[2] === 'args') {
  // One arg per line, for land-rebase.sh.
  process.stdout.write(driverConfigArgs(process.argv[3]).join('\n'));
}

module.exports = { driverConfigArgs, DRIVER_NAMES, DRIVERS, DRIVER_FILES };
