'use strict';
// Test-only preload (node -r): rebinds scripts/lib/shows-write-guard to the
// throwaway file named by SHOWS_SANDBOX_FILE, so a script under test can run
// its real main() without touching data/shows.json.
const Module = require('module');
const path = require('path');
const guardPath = path.join(__dirname, 'shows-write-guard.js');
const realLoad = Module._load;
let sandboxed = null;
Module._load = function patched(request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent); } catch { return null; } })();
  if (resolved === guardPath) {
    if (!sandboxed) {
      const real = realLoad.apply(this, arguments);
      const g = real.createShowsWriteGuard(process.env.SHOWS_SANDBOX_FILE);
      sandboxed = { ...real, SHOWS_PATH: process.env.SHOWS_SANDBOX_FILE, loadShows: g.loadShows, saveShows: g.saveShows };
    }
    return sandboxed;
  }
  return realLoad.apply(this, arguments);
};
