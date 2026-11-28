'use strict';
// BRO-7996: review-text files whose `showId` field disagrees with their folder.
// The rebuild trusts the FOLDER; this lists records where the field disagrees.
const fs = require('fs');
const path = require('path');

function findShowIdFolderMismatches(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.')) continue;
    for (const f of fs.readdirSync(path.join(root, d.name))) {
      if (!f.endsWith('.json')) continue;
      let j; try { j = JSON.parse(fs.readFileSync(path.join(root, d.name, f), 'utf8')); } catch { continue; }
      if (j && typeof j.showId === 'string' && j.showId && j.showId !== d.name) {
        out.push({ folder: d.name, file: f, showId: j.showId, publishDate: j.publishDate || null, wrongProduction: !!j.wrongProduction });
      }
    }
  }
  return out;
}
module.exports = { findShowIdFolderMismatches };
