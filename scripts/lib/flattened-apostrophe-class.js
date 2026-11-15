/**
 * flattened-apostrophe-class.js (BRO-7357): finds regex character classes that list the straight apostrophe
 * twice and no curly one, e.g. /['']/g. That is almost always /['’]/g with the curly quote flattened to ASCII
 * by an editor or paste, so titles typed with ’ (It’s A Wonderful Life) silently fail to match. It cost the
 * review-forecast v2 shadow its Show Score input for It’s A Wonderful Life (the scraper rejected the page).
 * Fix: write curly quotes as ‘ ’ escapes, which cannot be flattened.
 * Text scan, not a parser: a regex-shaped string literal is counted and new RegExp("['']") is missed (both rare);
 * the per-file baseline absorbs the former.
 * Pure: takes source text, returns hits. tests/unit/flattened-apostrophe-class.test.mjs scans the repo.
 */
'use strict';

const CURLY_DQ = /[“”„]|\\u201[cd]|\\u201e/i;
const CURLY = /[‘’ʼ]|\\u2018|\\u2019|\\u02BC|\\u02bc/i;

/** Bodies of regex literals on one line: a '/' after ( , = : [ ! & | ? { ; or line start opens one (not division, not a string). */
function regexLiteralBodies(code) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '/' || code[i + 1] === '/' || code[i + 1] === '*') continue;
    const prev = code.slice(0, i).trimEnd().slice(-1);
    if (prev && !'(,=:[!&|?{;'.includes(prev) && !/(?:^|[^\w$])return$/.test(code.slice(0, i).trimEnd())) continue;
    let j = i + 1, inClass = false;
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === '\\') { j++; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    if (j >= code.length) continue;
    out.push(code.slice(i + 1, j));
    i = j;
  }
  return out;
}

/** Returns [{ line, text }] for each regex-literal class with '' and no curly apostrophe (comment lines skipped). */
function findFlattenedApostropheClasses(src) {
  const hits = [];
  String(src).split('\n').forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const code = l.replace(/\s\/\/.*$/, ''); // drop a trailing // comment
    for (const body of regexLiteralBodies(code)) {
      const re = /\[((?:\\.|[^\]\\\n])*)\]/g; // every class inside the literal, mid-regex too (BRO-7514 review)
      let m;
      while ((m = re.exec(body))) {
        const flatSingle = /''/.test(m[1]) && !CURLY.test(m[1]);
        const flatDouble = /""/.test(m[1]) && !CURLY_DQ.test(m[1]);
        if (flatSingle || flatDouble) hits.push({ line: i + 1, text: t.slice(0, 160) });
      }
    }
  });
  return hits;
}

module.exports = { findFlattenedApostropheClasses };
