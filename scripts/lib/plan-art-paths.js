#!/usr/bin/env node
'use strict';
/**
 * BRO-7683: the art directories (public/images/shows/<id>) of the add-show actions in one or more actions files,
 * only those that exist, one per line. Workflows stage exactly these instead of the whole images directory, so art
 * another step left behind is never committed under the wrong plan.
 *
 *   node scripts/lib/plan-art-paths.js /tmp/actions-a.json [/tmp/actions-b.json ...]
 */
const fs = require('fs');
const path = require('path');

function artPaths(actionLists, root) {
  const out = [];
  for (const list of actionLists) {
    for (const a of list || []) {
      const id = a && a.type === 'add-show' && a.show && a.show.id;
      if (!id || !/^[a-z0-9-]+$/.test(id)) continue;
      const rel = path.join('public', 'images', 'shows', id);
      if (fs.existsSync(path.join(root, rel)) && !out.includes(rel)) out.push(rel);
    }
  }
  return out;
}

if (require.main === module) {
  const lists = process.argv.slice(2).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  for (const p of artPaths(lists, process.cwd())) console.log(p);
}
module.exports = { artPaths };
