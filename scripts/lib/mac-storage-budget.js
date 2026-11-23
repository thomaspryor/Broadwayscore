'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Only enrolled Macs share an on-disk budget. A Linux CI runner or an
// unenrolled developer machine keeps its existing job-admission behavior.
const cli = path.join(os.homedir(), '.bsc-mac-runner-storage', 'disk-budget.py');

function acquireStorage({ directory, sizeGiB, floorGiB }) {
  if (process.platform !== 'darwin') return () => {};
  try { fs.accessSync(cli, fs.constants.R_OK); } catch (error) {
    if (error.code === 'ENOENT') return () => {};
    throw error;
  }
  let token;
  try {
    token = execFileSync('/usr/bin/python3', [cli, 'acquire', '--path', directory,
      '--size-gib', String(sizeGiB), '--floor-gib', String(floorGiB), '--pid', String(process.pid)],
    { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('Storage reservation did not return a token');
  } catch (error) {
    const message = String(error.stderr || '').trim() || error.message;
    throw Object.assign(new Error(message), { code: 'BSC_DISK_PRESSURE' });
  }
  return () => {
    try {
      execFileSync('/usr/bin/python3', [cli, 'release', '--token', token],
        { timeout: 8000, killSignal: 'SIGKILL', stdio: 'ignore' });
    } catch (error) {
      console.warn('[storage-budget] Could not release a job reservation:', error.message);
    }
  };
}

module.exports = { acquireStorage };
