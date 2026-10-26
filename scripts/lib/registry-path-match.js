'use strict';

// One matcher for "does this repo path belong to this registry entry"
// (BRO-2782). Before this, five call sites each hand-rolled
// `path.endsWith(entry.file.replace(/^data\//, ''))`, so a registry entry
// that covers a directory of per-item files could not be added without
// patching all of them in step.
//
// An entry `file` without `*` is a plain file, matched by suffix exactly as
// before. A `file` ending in `/*.json` (e.g. 'audit/triage/*.json') covers the
// .json files DIRECTLY inside that directory: no nested paths, no other
// extensions, and the directory must be a whole path segment.

const cache = new Map();

function toRegExp(rel) {
  let re = cache.get(rel);
  if (!re) {
    const star = rel.indexOf('*');
    if (star === -1 || !rel.endsWith('/*.json') || star !== rel.length - '*.json'.length) {
      throw new Error(`registry-path-match: unsupported glob '${rel}' (only a trailing '/*.json' is supported)`);
    }
    const dir = rel.slice(0, star).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(^|/)${dir}[^/]+\\.json$`);
    cache.set(rel, re);
  }
  return re;
}

/** @param {string} entryFile registry `file` (with or without a leading `data/`)
 *  @param {string} filePath repo-relative path */
function registryPathMatches(entryFile, filePath) {
  const rel = String(entryFile).replace(/^data\//, '');
  const f = String(filePath);
  return rel.includes('*') ? toRegExp(rel).test(f) : f.endsWith(rel);
}

module.exports = { registryPathMatches };
