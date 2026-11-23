'use strict';
/**
 * BRO-8165: pure rule behind tests/unit/trace-excludes-bulk-data.test.mjs.
 * A top-level data/<file> over the limit that a server function can trace
 * (BRO-8147: nft follows path.join(__dirname,'..','data') and copies data/)
 * must be excluded in next.config.js outputFileTracingExcludes, or declared a
 * runtime read. Tracked sizes alone miss the big private core-data files, so
 * the test feeds this both tracked blobs and any on-disk files it finds.
 */

// Minimal glob: star = any run without a slash, double-star-slash = zero or more dirs, double-star = anything. Anchored.
function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0000/g, '.*') + '$');
}

/**
 * @param {{path: string, bytes: number}[]} files   repo-relative, e.g. 'data/shows.json'
 * @param {string[]} excludes                        outputFileTracingExcludes globs
 * @param {Set<string>|string[]} runtimeReads        top-level files a server route reads at runtime
 * @param {number} limitBytes
 * @returns {string[]} human-readable offenders
 */
function topLevelDataOffenders(files, excludes, runtimeReads, limitBytes) {
  const reads = new Set(runtimeReads);
  const globs = excludes.map(globToRegExp);
  const seen = new Map();
  for (const f of files) {
    if (!/^data\/[^/]+$/.test(f.path)) continue; // top-level files only
    seen.set(f.path, Math.max(seen.get(f.path) || 0, f.bytes)); // tracked + on-disk: keep the larger
  }
  return [...seen]
    .filter(([p, bytes]) => bytes > limitBytes && !reads.has(p) && !globs.some((re) => re.test(p)))
    .map(([p, bytes]) => `${p} (${(bytes / 1e6).toFixed(1)}MB)`)
    .sort();
}

module.exports = { globToRegExp, topLevelDataOffenders };
