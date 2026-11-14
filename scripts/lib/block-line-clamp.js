// BRO-7189: Tailwind emits `.block{display:block}` after `.line-clamp-N`
// (which needs `display:-webkit-box`), so an element carrying both classes
// silently loses its clamp and wraps. Video critic names wrapped to two lines
// and stretched the whole card. line-clamp-N is already block-level: drop
// `block`. Responsive variants (`sm:block`) are a different rule and allowed.
'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');

const CLASS_STRING = /className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

function findConflicts(source) {
  const hits = [];
  for (const m of source.matchAll(CLASS_STRING)) {
    const classes = (m[1] ?? m[2] ?? m[3]).split(/\s+/);
    if (classes.includes('block') && classes.some(c => /^line-clamp-\d+$/.test(c))) {
      hits.push({ line: source.slice(0, m.index).split('\n').length, classes: classes.join(' ') });
    }
  }
  return hits;
}

function listSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listSourceFiles(p);
    return /\.(tsx|jsx)$/.test(e.name) ? [p] : [];
  });
}

function scanTree(root) {
  return listSourceFiles(join(root, 'src')).flatMap(f =>
    findConflicts(readFileSync(f, 'utf8')).map(h => ({ file: relative(root, f), ...h })));
}

module.exports = { findConflicts, listSourceFiles, scanTree };
