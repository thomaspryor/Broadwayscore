'use strict';

/**
 * Cross-show duplicate fingerprint for a review's fullText, with a persistent
 * on-disk memo (BRO-7744).
 *
 * rebuild-all-reviews.js fingerprints every review with
 * sha256(cleanText(fullText) lowercased, whitespace stripped). cleanText runs
 * dozens of regex passes, and over ~56k reviews that was ~165s of the ~8 min
 * rebuild on press night. The fingerprint is a pure function of the text and
 * the cleaning code, so a run can reuse the previous run's answer for every
 * review whose text did not change.
 *
 * Cache safety: entries are keyed on sha256(fullText). The whole file is
 * thrown away unless its version matches, and the version hashes the source
 * of every repo module cleanText runs (walked from the live require graph),
 * THIS file (so the transform below is covered too), every process.env name
 * those sources read, and the Node major (regex/Unicode behaviour).
 * Any edit to that code invalidates the whole cache, so a stale fingerprint
 * cannot be served.
 *
 * Off switch: REBUILD_FP_CACHE=off computes every fingerprint fresh and never
 * touches disk.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { cleanText } = require('./text-cleaning');

const MIN_LEN = 200;
const DEFAULT_PATH = path.join(__dirname, '..', '..', '.cache', 'rebuild-fp-cache.json');

/**
 * Every repo source file cleanText can run: text-cleaning.js and everything it
 * requires (transitively, node_modules excluded), plus this file. Derived from
 * the live require graph so a new dependency of cleanText is versioned
 * automatically instead of relying on a hand-kept list.
 */
function versionedSources() {
  const seen = new Set();
  const walk = (mod) => {
    if (!mod || seen.has(mod.filename) || mod.filename.includes(`${path.sep}node_modules${path.sep}`)) return;
    seen.add(mod.filename);
    for (const child of mod.children) walk(child);
  };
  walk(require.cache[require.resolve('./text-cleaning')]);
  seen.add(__filename);
  return [...seen].sort();
}

/** Env var names read by those sources (dot or bracket access). REBUILD_FP_CACHE only picks the file. */
function versionedEnv(sources) {
  const names = new Set();
  for (const f of sources) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])/g)) names.add(m[1] || m[2]);
  }
  names.delete('REBUILD_FP_CACHE');
  return [...names].sort();
}

/**
 * The uncached computation. Returns the 16-hex fingerprint, or null when the
 * cleaned, whitespace-stripped text is too short to fingerprint.
 */
function computeFingerprint(fullText) {
  const cleaned = (cleanText(fullText) || '').toLowerCase().replace(/\s+/g, '');
  if (cleaned.length <= MIN_LEN) return null;
  return crypto.createHash('sha256').update(cleaned).digest('hex').substring(0, 16);
}

function codeVersion() {
  const h = crypto.createHash('sha256');
  const sources = versionedSources();
  for (const f of sources) h.update(path.relative(__dirname, f)).update('\0').update(fs.readFileSync(f));
  for (const k of versionedEnv(sources)) h.update(`${k}=${process.env[k] || ''}\0`);
  h.update(`node${process.versions.node.split('.')[0]}`);
  return h.digest('hex');
}

/**
 * @param {{ cachePath?: string|null }} [opts] cachePath null (or env
 *   REBUILD_FP_CACHE=off) disables the disk memo; default is
 *   REBUILD_FP_CACHE or .cache/rebuild-fp-cache.json at the repo root.
 */
function createFingerprintMemo(opts = {}) {
  const envPath = process.env.REBUILD_FP_CACHE;
  const cachePath = 'cachePath' in opts ? opts.cachePath : (envPath === 'off' ? null : (envPath || DEFAULT_PATH));
  const version = codeVersion();
  let prior = new Map();
  if (cachePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (raw && raw.version === version && raw.entries && typeof raw.entries === 'object') {
        prior = new Map(Object.entries(raw.entries));
      }
    } catch { /* missing or corrupt cache: start cold */ }
  }
  const used = new Map();
  const stats = { hits: 0, misses: 0, loaded: prior.size };

  function fingerprint(fullText) {
    const key = crypto.createHash('sha256').update(fullText).digest('base64');
    let fp = used.get(key);
    if (fp === undefined) {
      fp = prior.get(key);
      if (fp === undefined) {
        stats.misses++;
        fp = computeFingerprint(fullText) || '';
      } else {
        stats.hits++;
      }
      used.set(key, fp);
    }
    return fp || null;
  }

  /**
   * Writes only the entries this run used, so the file never grows past the
   * corpus. `computed` (fingerprints this run could not reuse) lets CI skip
   * re-uploading a cache that barely changed.
   */
  function save() {
    if (!cachePath) return false;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version, computed: stats.misses, entries: Object.fromEntries(used) }));
      fs.renameSync(tmp, cachePath);
      return true;
    } catch (e) {
      console.warn(`  [fp-memo] could not save ${cachePath}: ${e.message}`);
      return false;
    }
  }

  return { fingerprint, save, stats, cachePath };
}

module.exports = { createFingerprintMemo, computeFingerprint, versionedSources, versionedEnv, MIN_LEN };
