'use strict';
/**
 * BRO-7766: memoize relative require() resolution for long batch scripts.
 *
 * Many guards in scripts/lib/ call `require('./x')` inside per-review hot
 * functions (lazy, to dodge circular imports). Node re-resolves each call
 * (trySelf -> findParentPackageJSON -> stat walk up the tree), which cost
 * ~14s of a ~270s rebuild-all-reviews.js run in a CPU profile.
 *
 * installRequireMemo() wraps Module.prototype.require so an id (relative,
 * package or builtin; BRO-7766 follow-up: bare 'fs'/'path' calls still cost
 * ~11s in trySelf) is resolved once per calling module. The module itself
 * still comes from Node's own cache, and only when that entry exists and has
 * finished loading; anything else (first load, a module mid-way through a
 * circular load, a cache entry a test deleted) falls through to the original
 * require, so what a call returns is unchanged.
 */
const Module = require('module');

const MARK = Symbol.for('broadwayscore.requireMemo');

function installRequireMemo() {
  const proto = Module.prototype;
  // Kill switch (rollback without a code change): REQUIRE_MEMO=off.
  if (String(process.env.REQUIRE_MEMO || '').toLowerCase() === 'off') return false;
  if (proto.require[MARK]) return false;
  const original = proto.require;
  // A Module._load / _resolveFilename hook installed AFTER the memo (a sandbox
  // preload, tsx, module-alias) must see every call, so the memo steps aside.
  const loadAtInstall = Module._load;
  const resolveAtInstall = Module._resolveFilename;
  const resolved = new WeakMap(); // calling Module object -> Map(request -> filename)
  function memoRequire(id) {
    if (typeof id === 'string' && id.length && this && typeof this === 'object'
        && Module._load === loadAtInstall && Module._resolveFilename === resolveAtInstall) {
      // Keyed per calling MODULE, and the first call for a key always goes through
      // Node's require: that records the parent->child edge in module.children,
      // which fingerprint-memo.js reads to version its cache. Repeat calls from the
      // same module add no edge, so skipping them changes nothing.
      // Keyed by the Module object, so a reloaded copy of a file starts fresh.
      let perModule = resolved.get(this);
      if (!perModule) { perModule = new Map(); resolved.set(this, perModule); }
      const hit = perModule.get(id);
      if (hit !== undefined) {
        // Builtins ('fs', 'path', 'node:os') have no Module._cache entry; their
        // exports object is a process-wide singleton, so it is held directly.
        // A bare builtin id is overridable via require.cache[id] under stock require.
        if (hit.builtin) { if (Module._cache[id] === undefined) return hit.exports; }
        else {
          const cached = Module._cache[hit.filename];
          if (cached && cached.loaded) return cached.exports;
        }
      }
      const exported = original.call(this, id);
      try {
        if (Module.isBuiltin(id)) {
          // Only remember the real builtin, never a require.cache override of it.
          if (Module._cache[id] === undefined) perModule.set(id, { builtin: true, exports: exported });
          else perModule.delete(id);
        }
        else perModule.set(id, { filename: Module._resolveFilename(id, this) });
      } catch { /* unresolvable ids keep taking the normal path */ }
      return exported;
    }
    return original.call(this, id);
  }
  memoRequire[MARK] = true;
  proto.require = memoRequire;
  return true;
}

module.exports = { installRequireMemo };
