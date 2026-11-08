'use strict';
// BRO-7110: a cloud container's node_modules was a shell (558 of 927 package
// dirs empty). Probing a few packages missed it, and land-local-check then
// spent 33 minutes failing every gate on both sides. Every declared dependency
// must have its package.json; one that does not is the cheap, complete tell.
const fs = require('fs');
const path = require('path');

/** -> names in <root>/package.json dependencies/devDependencies with no node_modules/<name>/package.json ([] if package.json is unreadable) */
function missingDeclaredPackages(root, exists = fs.existsSync, readPkg = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))) {
  let pkg;
  try { pkg = readPkg(); } catch { return []; }
  const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  return names.filter((n) => !exists(path.join(root, 'node_modules', n, 'package.json')));
}

module.exports = { missingDeclaredPackages };
