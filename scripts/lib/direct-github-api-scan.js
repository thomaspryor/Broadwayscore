/**
 * Pure scanner for BRO-134: finds scripts that call api.github.com directly
 * (hand-rolled fetchJSON/apiGet/httpsGet copies) instead of going through
 * scripts/lib/gh-api-client.js, which logs every call to the shared ledger.
 */
'use strict';

const HELPER_DEF = /(?:function|const|let)\s+(fetchJSON|apiGet|httpsGet|githubGet|githubJSON|ghFetch|getJSON)\b/;

/**
 * @param {string} file repo-relative path
 * @param {string} text file contents
 * @returns {null | {file: string, usesClient: boolean, helpers: string[]}}
 *   null when the file does not talk to api.github.com at all.
 */
function scanFile(file, text) {
  if (!/api\.github\.com/.test(text)) return null;
  const helpers = [];
  for (const line of text.split('\n')) {
    const m = HELPER_DEF.exec(line);
    if (m) helpers.push(m[1]);
  }
  return { file, usesClient: /gh-api-client(\.js)?['"]/.test(text), helpers };
}

/**
 * @param {Array<{file:string,text:string}>} files
 * @param {Set<string>|string[]} baseline files already known to call directly
 * @returns {{direct: string[], newDirect: string[], staleBaseline: string[]}}
 */
function classify(files, baseline) {
  const base = new Set(baseline);
  const direct = [];
  for (const { file, text } of files) {
    const r = scanFile(file, text);
    if (r && !r.usesClient) direct.push(file);
  }
  direct.sort();
  const newDirect = direct.filter((f) => !base.has(f));
  const staleBaseline = [...base].filter((f) => !direct.includes(f)).sort();
  return { direct, newDirect, staleBaseline };
}

module.exports = { scanFile, classify };
