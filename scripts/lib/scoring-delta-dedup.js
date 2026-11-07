'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isReviewTextFile } = require('./review-text-sidecars');

// Hash the local dependency graph as well as the exported predicates. A
// constant or private helper change must not look like identical guards.
function loadDedupGuards(libDir) {
  const seen = new Set();
  const hash = crypto.createHash('sha256');
  function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const src = fs.readFileSync(path.join(libDir, name), 'utf8');
    hash.update(name).update(src);
    const deps = [...src.matchAll(/require\(\s*['"]\.\/([A-Za-z0-9_.-]+?)(?:\.js)?['"]\s*\)/g)]
      .map(m => `${m[1]}.js`).sort();
    for (const dep of deps) if (fs.existsSync(path.join(libDir, dep))) visit(dep);
  }
  for (const name of ['duplicate-of-exclusion.js', 'cross-outlet-cycle.js', 'syndication-pairs.js', 'review-normalization.js', 'review-guards.js']) visit(name);
  return {
    __duplicateOfLib: require(path.join(libDir, 'duplicate-of-exclusion.js')),
    __crossOutletCycleLib: require(path.join(libDir, 'cross-outlet-cycle.js')),
    __syndicationLib: require(path.join(libDir, 'syndication-pairs.js')),
    __dedupNormalizeOutlet: require(path.join(libDir, 'review-normalization.js')).normalizeOutlet,
    __dedupFingerprint: hash.digest('hex'),
  };
}

/**
 * Recreate the old show directory for reference guards that read siblings.
 * Only changed shows need a snapshot. Nothing writes to the source corpus.
 * The caller owns tempRoot and removes it on exit.
 */
function createBaselineShowSnapshot(showDir, changes, tempRoot) {
  const showId = path.basename(showDir);
  const changed = new Map([...changes].filter(([key]) => key.startsWith(`${showId}/`))
    .map(([key, value]) => [path.basename(key), value.old]));
  if (!changed.size) return showDir;
  const dest = path.join(tempRoot, showId);
  fs.mkdirSync(dest, { recursive: true });
  let currentNames;
  try { currentNames = fs.readdirSync(showDir); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    currentNames = []; // The last review (or the whole show directory) was deleted.
  }
  const names = new Set([...currentNames, ...changed.keys()]);
  for (const name of names) {
    if (!isReviewTextFile(name)) continue;
    if (changed.has(name)) {
      const old = changed.get(name);
      if (old !== null) fs.writeFileSync(path.join(dest, name), JSON.stringify(old));
    } else {
      fs.copyFileSync(path.join(showDir, name), path.join(dest, name));
    }
  }
  return dest;
}

module.exports = { loadDedupGuards, createBaselineShowSnapshot };
