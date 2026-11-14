'use strict';
// BRO-7110: a cloud container's node_modules was a shell (558 of 927 package
// dirs empty). Probing a few packages missed it, and land-local-check then
// spent 33 minutes failing every gate on both sides. Every declared dependency
// must have its package.json; one that does not is the cheap, complete tell.
//
// A worktree's node_modules is a link to the main checkout's install, so the
// check reads the package.json of the checkout that OWNS node_modules: that is
// the one `npm ci` there installs. (A branch that adds a dependency is the
// deps-changed path's business, not an incomplete install.)
const fs = require('fs');
const path = require('path');

/** -> the directory whose node_modules <root>/node_modules is (follows a link), or null if there is none */
function nodeModulesOwner(root) {
  try {
    return path.dirname(fs.realpathSync(path.join(root, 'node_modules')));
  } catch {
    return null;
  }
}

/**
 * -> { owner, missing }: owner is the checkout that holds the install (null when <root> has no
 * node_modules: nothing to judge), missing the names in its package.json dependencies and
 * devDependencies with no node_modules/<name>/package.json ([] if package.json is unreadable).
 */
function missingDeclaredPackages(root, { exists = (p) => fs.existsSync(p), owner = nodeModulesOwner(root), readPkg } = {}) {
  if (!owner) return { owner: null, missing: [] };
  let pkg;
  try {
    pkg = readPkg ? readPkg(owner) : JSON.parse(fs.readFileSync(path.join(owner, 'package.json'), 'utf8'));
  } catch {
    return { owner, missing: [] };
  }
  const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  return { owner, missing: names.filter((n) => !exists(path.join(owner, 'node_modules', n, 'package.json'))) };
}

module.exports = { missingDeclaredPackages, nodeModulesOwner };
