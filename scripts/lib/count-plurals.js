// BRO-6410: port of the app's bare-count scanner (BRO-6269).
// Limit this guard to the show/review nouns covered by the web card.
'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');

// Matches JSX and template interpolations, including explicit JSX spaces.
// Exclude the next JSX prop and code such as `shows.push(...)`.
const BARE_COUNT = /\$?\{([^{}]+)\}(?:\{' '\}|&nbsp;|\s)+(shows|reviews)\b(?!\s*=|\.[A-Za-z_$])/g;

// File -> expression -> reason the count cannot render as 1.
const ALLOWED = {
  'src/components/VideoReviewsShelf.tsx': {
    'reviews.length': 'The aggregate branch requires reviews.length >= 2; the single branch says review.',
  },
  'src/components/HomePageClient.tsx': {
    'totalReviews.toLocaleString()': 'Site-wide critic-review total, in the thousands.',
  },
  'src/components/OffBroadwayPageClient.tsx': {
    totalShows: 'Whole Off-Broadway catalog total, not the filtered result count.',
  },
  'src/components/OffWestEndPageClient.tsx': {
    totalShows: 'Whole Off-West End catalog total, not the filtered result count.',
  },
};

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function findBareCounts(src, allowed = {}) {
  const code = stripComments(src);
  const lines = code.split('\n');
  const hits = [];
  for (const m of code.matchAll(BARE_COUNT)) {
    const expr = m[1].trim();
    if (Object.hasOwn(allowed, expr) || /\.toFixed\(\d\)$/.test(expr)) continue;
    const line = code.slice(0, m.index).split('\n').length;
    hits.push({ line, expr, noun: m[2], text: lines[line - 1].trim() });
  }
  return hits;
}

function listSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(file);
    return /\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
  });
}

function scanSource(root) {
  return listSourceFiles(join(root, 'src')).flatMap(file => {
    const rel = relative(root, file).split('\\').join('/');
    return findBareCounts(readFileSync(file, 'utf8'), ALLOWED[rel])
      .map(hit => ({ file: rel, ...hit }));
  });
}

module.exports = { ALLOWED, findBareCounts, listSourceFiles, scanSource, stripComments };
