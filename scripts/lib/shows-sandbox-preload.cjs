'use strict';
// Test-only preload (node -r): rebinds scripts/lib/shows-write-guard to the
// throwaway file named by SHOWS_SANDBOX_FILE, so a script under test can run
// its real main() without touching data/shows.json.
if (!process.env.SHOWS_SANDBOX_FILE) throw new Error('shows-sandbox-preload: SHOWS_SANDBOX_FILE is not set');
const Module = require('module');
const fs = require('fs');
const path = require('path');
// SHOWS_SANDBOX_GUARD_PATH lets the preload's own test aim the guard at a
// decoy, so a broken guard can never damage the real file.
const realShows = process.env.SHOWS_SANDBOX_GUARD_PATH || path.join(__dirname, '..', '..', 'data', 'shows.json');
// Resolved once: the real file (through a symlink) and its directory.
let realShowsResolved = realShows;
try { realShowsResolved = fs.realpathSync(realShows); } catch {}

function isRealShows(p) {
  if (p instanceof URL) p = p.protocol === 'file:' ? p.pathname : null;
  else if (Buffer.isBuffer(p)) p = p.toString();
  if (typeof p !== 'string') return false;
  const abs = path.resolve(p);
  if (abs === realShows || abs === realShowsResolved) return true;
  // A temp sibling (shows.json.tmp.<pid>) or the lock dir also counts: the
  // sandbox must never write next to the real file.
  const base = path.basename(abs);
  const dir = path.dirname(abs);
  const realDirs = new Set([path.dirname(realShows), path.dirname(realShowsResolved)]);
  try { if (realDirs.has(fs.realpathSync(dir)) && base.startsWith('shows.json')) return true; } catch {}
  return realDirs.has(dir) && base.startsWith('shows.json');
}

const refuse = () => { throw new Error('sandbox: refusing to write real shows.json'); };
// Belt and braces: any write, rename, copy or delete that reaches the real
// shows.json (or a shows.json* sibling) throws. Path arguments only.
const PATH_ARGS = {
  writeFileSync: [0], appendFileSync: [0], writeFile: [0], appendFile: [0],
  renameSync: [0, 1], rename: [0, 1], copyFileSync: [1], copyFile: [1],
  unlinkSync: [0], unlink: [0], rmSync: [0], rm: [0], createWriteStream: [0],
  openSync: [0], open: [0],
};
const WRITE_FLAG = /[wa+]/;
const C = fs.constants;
const WRITE_BITS = C.O_WRONLY | C.O_RDWR | C.O_APPEND | C.O_CREAT | C.O_TRUNC;
const opensForWrite = (flags) => (typeof flags === 'number' ? (flags & WRITE_BITS) !== 0 : WRITE_FLAG.test(typeof flags === 'string' ? flags : 'r'));
for (const [fn, idxs] of Object.entries(PATH_ARGS)) {
  const orig = fs[fn];
  if (typeof orig !== 'function') continue;
  fs[fn] = function guarded(...a) {
    if (fn === 'openSync' || fn === 'open') {
      if (opensForWrite(a[1]) && isRealShows(a[0])) refuse();
    } else if (idxs.some((i) => isRealShows(a[i]))) refuse();
    return orig.apply(this, a);
  };
}
for (const fn of ['writeFile', 'appendFile', 'rename', 'copyFile', 'unlink', 'rm', 'open']) {
  const orig = fs.promises[fn];
  const idxs = PATH_ARGS[fn];
  fs.promises[fn] = function guarded(...a) {
    const hit = fn === 'open' ? opensForWrite(a[1]) && isRealShows(a[0]) : idxs.some((i) => isRealShows(a[i]));
    if (hit) return Promise.reject(new Error('sandbox: refusing to write real shows.json'));
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
      sandboxed = {
        ...real,
        SHOWS_PATH: process.env.SHOWS_SANDBOX_FILE,
        LOCK_DIR: g.lockDir,
        loadShows: g.loadShows,
        saveShows: g.saveShows,
        // A script that builds its own guard (createShowsWriteGuard(SHOWS_PATH))
        // gets the sandbox one too, whatever path it passes.
        // Options (e.g. { dryRun: true }) are honoured on the sandbox file.
        createShowsWriteGuard: (_p, opts) => (opts ? real.createShowsWriteGuard(process.env.SHOWS_SANDBOX_FILE, opts) : g),
      };
    }
    return sandboxed;
  }
  return realLoad.apply(this, arguments);
};
