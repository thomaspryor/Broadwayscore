'use strict';
// Test-only preload (node -r): rebinds scripts/lib/shows-write-guard to the
// throwaway file named by SHOWS_SANDBOX_FILE, so a script under test can run
// its real main() without touching data/shows.json.
if (!process.env.SHOWS_SANDBOX_FILE) throw new Error('shows-sandbox-preload: SHOWS_SANDBOX_FILE is not set');
const Module = require('module');
const fs = require('fs');
const path = require('path');
const realShows = path.join(__dirname, '..', '..', 'data', 'shows.json');
// Belt and braces: any write that reaches the real shows.json (even through a symlink) throws.
for (const fn of ['writeFileSync', 'renameSync', 'copyFileSync']) {
  const orig = fs[fn];
  fs[fn] = function guarded(...a) {
    for (const x of a) {
      if (typeof x !== 'string') continue;
      let rp = x; try { rp = fs.realpathSync(x); } catch {}
      if (x === realShows || rp === realShows || (fs.existsSync(realShows) && rp === fs.realpathSync(realShows))) throw new Error('sandbox: refusing to write real shows.json');
    }
    return orig.apply(this, a);
  };
}
const guardPath = path.join(__dirname, 'shows-write-guard.js');
const realLoad = Module._load;
let sandboxed = null;
Module._load = function patched(request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent); } catch { return null; } })();
  if (resolved === guardPath) {
    if (!sandboxed) {
      const real = realLoad.apply(this, arguments);
      const g = real.createShowsWriteGuard(process.env.SHOWS_SANDBOX_FILE);
      sandboxed = { ...real, SHOWS_PATH: process.env.SHOWS_SANDBOX_FILE, LOCK_DIR: g.lockDir, loadShows: g.loadShows, saveShows: g.saveShows };
    }
    return sandboxed;
  }
  return realLoad.apply(this, arguments);
};
