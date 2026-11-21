'use strict';
/**
 * Absolute paths for system binaries that live outside the default non-login
 * PATH (BRO-5209). On macOS lsof and sysctl are in /usr/sbin; headless
 * `claude -p` jobs (and some launchd plists) run with
 * PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin, so spawning the bare
 * name fails with ENOENT there. Every liveness guard treats that failure as
 * "in use / unknown -> keep", so the worktree GC silently reclaimed nothing
 * from those contexts. Any sbin-resident binary belongs here; spawn the
 * exported constant, never the bare string (enforced by
 * tests/unit/system-bin.test.mjs, which reads SBIN_BINARIES).
 */
const fs = require('fs');

const SBIN_BINARIES = ['lsof', 'sysctl'];
const DEFAULT_DIRS = ['/usr/sbin', '/sbin', '/usr/bin', '/bin'];

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSystemBin(name, dirs = DEFAULT_DIRS, isExecutable = isExecutableFile) {
  for (const d of dirs) {
    const p = `${d}/${name}`;
    if (isExecutable(p)) return p;
  }
  return name; // fall back to PATH lookup
}

module.exports = {
  resolveSystemBin,
  SBIN_BINARIES,
  LSOF: resolveSystemBin('lsof'),
  SYSCTL: resolveSystemBin('sysctl'),
};
