'use strict';

// Pure occupancy audit for GitHub Actions caches (BRO-3902). Rule (m) in
// audit-workflow-hygiene.js only catches run-id KEYS; it cannot see a huge
// static-key cache or an unbounded count of small ones. GitHub caps a repo at
// 10 GiB and LRU-evicts the WHOLE namespace when it is exceeded (BRO-3887:
// 28 GiB, hourly eviction, ~7K scraper credits/day). This takes the live
// `gh cache list --json key,sizeInBytes,createdAt` rows and returns violations.

const GIB = 1024 ** 3;
const LIMIT_BYTES = 10 * GIB;
const DEFAULTS = {
  totalBytes: 8 * GIB, // warn well before the 10 GiB cap
  entryBytes: 1 * GIB, // any single entry this big is a smell
  maxEntriesPerPrefix: 6, // churn signature: many live entries, one key family
};

// Collapse the variable tail of a key (run id, content hash, timestamp) so
// entries from one cache family share a prefix.
function keyPrefix(key) {
  return String(key || '')
    .replace(/(^|[-_.])\d{6,}(?=[-_.]|$)/g, '$1#') // run ids anywhere in the key
    .replace(/[-_.]?[0-9a-f]{12,}$/i, '-')
    .replace(/[-_.]?\d{6,}$/, '-')
    .replace(/(-\d{1,5})+$/, '-');
}

function fmt(bytes) {
  return `${(bytes / GIB).toFixed(2)} GiB`;
}

/**
 * @param {Array<{key:string,sizeInBytes:number,createdAt?:string}>} entries
 * @param {Partial<typeof DEFAULTS>} [opts]
 * @returns {{totalBytes:number, violations:Array<{kind:string,message:string}>}}
 */
function auditCacheEntries(entries, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const rows = Array.isArray(entries) ? entries : [];
  const violations = [];
  const total = rows.reduce((n, e) => n + (Number(e.sizeInBytes) || 0), 0);

  if (total > cfg.totalBytes) {
    violations.push({
      kind: 'total',
      message: `cache total ${fmt(total)} exceeds ${fmt(cfg.totalBytes)} (repo limit ${fmt(LIMIT_BYTES)}; over it GitHub evicts every cache)`,
    });
  }
  for (const e of rows) {
    const size = Number(e.sizeInBytes) || 0;
    if (size > cfg.entryBytes) {
      violations.push({ kind: 'entry', message: `entry ${e.key} is ${fmt(size)} (> ${fmt(cfg.entryBytes)})` });
    }
  }
  const byPrefix = new Map();
  for (const e of rows) {
    const p = keyPrefix(e.key);
    const g = byPrefix.get(p) || { count: 0, bytes: 0 };
    g.count += 1;
    g.bytes += Number(e.sizeInBytes) || 0;
    byPrefix.set(p, g);
  }
  for (const [p, g] of byPrefix) {
    if (g.count > cfg.maxEntriesPerPrefix) {
      violations.push({
        kind: 'churn',
        message: `${g.count} live entries share key prefix "${p}" (${fmt(g.bytes)}; > ${cfg.maxEntriesPerPrefix})`,
      });
    }
  }
  return { totalBytes: total, violations };
}

module.exports = { auditCacheEntries, keyPrefix, DEFAULTS, LIMIT_BYTES };

// BRO-7506: detection (auditCacheEntries) only warned, so the repo kept crossing
// the cap between looks and the SERP-eviction probe went red again (BRO-6322,
// BRO-6826, BRO-6993). This is the self-heal half. ALLOW-list, not deny-list:
// only families GitHub rebuilds on its own may be evicted; anything else
// (bd-serp-cache-*, digest-*, money-monthly-baseline-* ...) is never touched.
const HEAL_TARGET_BYTES = 6 * GIB;
const EVICTABLE_PREFIXES = ['nextjs-cache-', 'node-cache-', 'playwright-'];
const MAX_EVICTIONS_PER_RUN = 50;
// Refs whose newest entry per family is what real builds restore (main deploys, staging previews).
const KEEP_REFS = ['refs/heads/main', 'refs/heads/staging'];

function selectEntriesToEvict(
  entries,
  { totalBytes, targetBytes = HEAL_TARGET_BYTES, keepRefs = KEEP_REFS, maxEvictions = MAX_EVICTIONS_PER_RUN } = {},
) {
  const rows = Array.isArray(entries) ? entries : [];
  const size = (e) => Number(e.sizeInBytes) || 0;
  // Pass the authoritative total (actions/cache/usage) when known: the listing
  // is capped at 1000 rows and can undercount.
  let total = Number.isFinite(totalBytes) ? totalBytes : rows.reduce((n, e) => n + size(e), 0);
  if (total <= targetBytes) return [];
  const ts = (e) => new Date(e.lastAccessedAt || e.createdAt || 0).getTime() || 0;
  const family = (e) => `${e.ref}|${keyPrefix(e.key)}`;
  const newestPerFamily = new Map();
  for (const e of rows) {
    const f = family(e);
    const cur = newestPerFamily.get(f);
    if (!cur || ts(e) > ts(cur)) newestPerFamily.set(f, e);
  }
  const candidates = rows
    .filter((e) => EVICTABLE_PREFIXES.some((p) => String(e.key || '').startsWith(p)))
    // the newest entry of each family on the kept refs is what builds restore
    .filter((e) => !(keepRefs.includes(e.ref) && newestPerFamily.get(family(e)) === e))
    .sort((a, b) => {
      const ao = keepRefs.includes(a.ref) ? 1 : 0;
      const bo = keepRefs.includes(b.ref) ? 1 : 0;
      if (ao !== bo) return ao - bo; // orphans on land/* and PR refs first
      if (ts(a) !== ts(b)) return ts(a) - ts(b);
      return size(b) - size(a);
    });
  const out = [];
  for (const e of candidates) {
    if (total <= targetBytes || out.length >= maxEvictions) break;
    out.push(e);
    total -= size(e);
  }
  return out;
}

module.exports.selectEntriesToEvict = selectEntriesToEvict;
module.exports.HEAL_TARGET_BYTES = HEAL_TARGET_BYTES;
module.exports.EVICTABLE_PREFIXES = EVICTABLE_PREFIXES;
