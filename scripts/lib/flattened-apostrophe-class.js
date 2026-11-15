/**
 * flattened-apostrophe-class.js (BRO-7357): finds regex character classes that list the straight apostrophe
 * twice and no curly one, e.g. /['']/g. That is almost always /['’]/g with the curly quote flattened to ASCII
 * by an editor or paste, so titles typed with ’ (It’s A Wonderful Life) silently fail to match. It cost the
 * review-forecast v2 shadow its Show Score input for It’s A Wonderful Life (the scraper rejected the page).
 * Fix: write curly quotes as ‘ ’ escapes, which cannot be flattened.
 * Pure: takes source text, returns hits. tests/unit/flattened-apostrophe-class.test.mjs scans the repo.
 */
'use strict';

const CURLY = /[‘’ʼ]|\\u2018|\\u2019|\\u02BC|\\u02bc/i;

/** Returns [{ line, text }] for each regex-literal class with '' and no curly apostrophe (comment lines skipped). */
function findFlattenedApostropheClasses(src) {
  const hits = [];
  String(src).split('\n').forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const code = l.replace(/\s\/\/.*$/, ''); // drop a trailing // comment
    const re = /\/\[((?:\\.|[^\]\\\n])*)\]/g;
    let m;
    while ((m = re.exec(code))) {
      if (/''/.test(m[1]) && !CURLY.test(m[1])) hits.push({ line: i + 1, text: t.slice(0, 160) });
    }
  });
  return hits;
}

module.exports = { findFlattenedApostropheClasses };
