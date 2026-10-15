'use strict';
/**
 * Absolute paths for macOS system binaries that live outside the default
 * non-login PATH (BRO-5209). lsof is /usr/sbin/lsof on macOS; headless
 * `claude -p` jobs run with PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin,
 * so a bare spawn('lsof') fails with ENOENT there. Every liveness guard treats
 * that failure as "in use / unknown -> keep", so the GC silently reclaimed
 * nothing from those contexts and its tests failed in them.
 * Spawn `LSOF` instead of the string 'lsof' (enforced by system-bin.test.mjs).
 */
const fs = require('fs');

function resolveSystemBin(name, dirs = ['/usr/sbin', '/sbin', '/usr/bin', '/bin'], exists = fs.existsSync) {
  for (const d of dirs) {
    const p = `${d}/${name}`;
    if (exists(p)) return p;
  }
  return name; // fall back to PATH lookup (Linux CI: /usr/bin/lsof is covered above anyway)
}

module.exports = { resolveSystemBin, LSOF: resolveSystemBin('lsof') };
