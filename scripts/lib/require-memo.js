'use strict';
/**
 * BRO-7766: memoize relative require() resolution for long batch scripts.
 *
 * Many guards in scripts/lib/ call `require('./x')` inside per-review hot
 * functions (lazy, to dodge circular imports). Node re-resolves each call
 * (trySelf -> findParentPackageJSON -> stat walk up the tree), which cost
 * ~14s of a ~270s rebuild-all-reviews.js run in a CPU profile.
 *
 * installRequireMemo() wraps Module.prototype.require so a relative id
 * ('./x', '../x') is resolved once per calling module. The module itself
 * still comes from Node's own cache, and only when that entry exists and has
 * finished loading; anything else (first load, a module mid-way through a
 * circular load, a cache entry a test deleted) falls through to the original
 * require, so what a call returns is unchanged.
 */
const Module = require('module');

const MARK = Symbol.for('broadwayscore.requireMemo');

function installRequireMemo() {
  const proto = Module.prototype;
  if (proto.require[MARK]) return false;
  const original = proto.require;
  const resolved = new Map();
  function memoRequire(id) {
    if (typeof id === 'string' && (id.startsWith('./') || id.startsWith('../')) && this && this.id) {
      // Keyed per calling MODULE, and the first call for a key always goes through
      // Node's require: that records the parent->child edge in module.children,
      // which fingerprint-memo.js reads to version its cache. Repeat calls from the
      // same module add no edge, so skipping them changes nothing.
      const key = this.id + '\0' + id;
      const filename = resolved.get(key);
      if (filename !== undefined) {
        const cached = Module._cache[filename];
        if (cached && cached.loaded) return cached.exports;
      }
      const exported = original.call(this, id);
      try {
        resolved.set(key, Module._resolveFilename(id, this));
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
