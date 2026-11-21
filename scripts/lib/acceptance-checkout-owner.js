'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasLiveProcessInDir } = require('./gc-worktree-liveness.js');
const { hasLiveLease } = require('./worktree-live-lease-check.js');
const { holdsIgnoredWork } = require('./codex-runner.js');

const OWNER_FILE = '.acceptance-owner.json';

function processStart(pid) {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function writeOwner(dir) {
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({
    pid: process.pid, started: processStart(process.pid),
  }), { flag: 'wx', mode: 0o600 });
}

// Missing metadata is a legacy checkout. Unreadable metadata keeps the tree.
function ownerState(dir) {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? 'legacy' : 'unknown'; }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.started) return 'unknown';
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
  try { return processStart(owner.pid) === owner.started ? 'live' : 'dead'; }
  catch { return 'unknown'; }
}

function checkoutInUse(wt) {
  if (hasLiveProcessInDir(wt) || hasLiveLease(wt)) return true;
  try {
    const commands = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10000 });
    return commands.split('\n').some((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match && Number(match[1]) !== process.pid && match[2].includes(path.dirname(wt));
    });
  } catch { return true; }
}

function canReapCheckout(wt) {
  const owner = ownerState(path.dirname(wt));
  if (owner === 'live' || owner === 'unknown' || holdsIgnoredWork(wt) || checkoutInUse(wt)) return false;
  try {
    const dirty = execFileSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8', timeout: 30000,
    });
    return !dirty.trim();
  } catch { return false; }
}

if (require.main === module) {
  const [operation, wt] = process.argv.slice(2);
  if (!wt || !['owner', 'safe'].includes(operation)) process.exit(2);
  if (operation === 'owner') console.log(ownerState(path.dirname(wt)));
  else process.exit(canReapCheckout(wt) ? 0 : 1);
}

module.exports = { writeOwner, ownerState, checkoutInUse, canReapCheckout, OWNER_FILE };
