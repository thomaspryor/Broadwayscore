'use strict';
/**
 * Expiry for "acknowledged finding" baselines (BRO-3364).
 *
 * Several audits keep a committed list of finding keys the owner already
 * triaged (card #643 pattern): data/audit/outlet-heartbeat-baseline.json,
 * star-score-mismatch-baseline.json, score-vs-models-baseline.json. The
 * digest alerts only on keys NOT in the list. Before this module an ack was
 * forever: an outlet baselined during a 2026 summer opening drought would stay
 * silenced if its extractor broke for real a year later.
 *
 * Shape (backward compatible, `keys` stays the list every reader used):
 *   { _meta: {...}, keys: [k...], entries: { k: { timestamp, ttlDays } } }
 *
 * Rules:
 *   - an entry older than ttlDays (default 90) is EXPIRED: the key re-enters
 *     the audit's normal alert logic (for the outlet heartbeat that is the
 *     usual 2-week red streak, so a recovered outlet never alerts);
 *   - a key with no entry (a file written before this module) stays active,
 *     so a reader never mass-expires an old file; the committed files were
 *     migrated with real ack dates and baseline-ttl.test.mjs keeps them so;
 *   - re-running --write-baseline KEEPS each surviving key's original
 *     timestamp, so a bulk re-ack cannot silently renew old acks. Renewing is
 *     explicit: --renew-baseline=<key>[,<key>...] re-acks just the keys you
 *     re-triaged; bare --renew-baseline re-acks every listed key.
 *   - --write-baseline/--renew-baseline rebuild the WHOLE file from one scan,
 *     so the audits refuse them together with a --show scope (a per-show
 *     write would drop every other show's acks).
 *   - keys expiring within 7 days are named in the audit's own digest line
 *     (describeExpiry), not a separate alert: expiry itself is the alert path.
 */

const DAY_MS = 86_400_000;
const DEFAULT_TTL_DAYS = 90;
const WARN_WITHIN_DAYS = 7;

function entryExpiresAtMs(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const t = Date.parse(entry.timestamp);
  const ttl = Number(entry.ttlDays);
  if (!Number.isFinite(t) || !Number.isFinite(ttl) || ttl <= 0) return null;
  return t + ttl * DAY_MS;
}

function docKeys(doc) {
  return doc && Array.isArray(doc.keys) ? doc.keys : [];
}

/** Keys still acknowledged at `nowMs` (legacy keys with no entry count as active). */
function activeBaselineKeys(doc, nowMs = Date.now()) {
  const out = new Set();
  for (const k of docKeys(doc)) {
    const exp = entryExpiresAtMs(doc.entries && doc.entries[k]);
    if (exp === null || nowMs < exp) out.add(k);
  }
  return out;
}

/** Keys whose ack has expired at `nowMs`. */
function expiredBaselineKeys(doc, nowMs = Date.now()) {
  return docKeys(doc).filter((k) => {
    const exp = entryExpiresAtMs(doc.entries && doc.entries[k]);
    return exp !== null && nowMs >= exp;
  });
}

/** Active keys that expire within `withinDays`, soonest first. */
function expiringSoon(doc, nowMs = Date.now(), withinDays = WARN_WITHIN_DAYS) {
  const rows = [];
  for (const k of docKeys(doc)) {
    const exp = entryExpiresAtMs(doc.entries && doc.entries[k]);
    if (exp !== null && nowMs < exp && exp - nowMs <= withinDays * DAY_MS) {
      rows.push({ key: k, expiresAt: new Date(exp).toISOString() });
    }
  }
  return rows.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

/**
 * Suffix for an audit's digest line, '' when nothing is expiring or expired.
 * e.g. "; 2 ack(s) expire within 7d (guardian::broadway, wsj::broadway) — re-triage, then --renew-baseline=<key> per key (bare flag renews all)"
 */
function describeExpiry(doc, nowMs = Date.now(), { renewCommand = '--renew-baseline', maxNames = 5 } = {}) {
  const soon = expiringSoon(doc, nowMs);
  const expired = expiredBaselineKeys(doc, nowMs);
  const parts = [];
  if (soon.length) {
    const names = soon.slice(0, maxNames).map((r) => r.key).join(', ') + (soon.length > maxNames ? ', …' : '');
    parts.push(`${soon.length} ack(s) expire within ${WARN_WITHIN_DAYS}d (${names})`);
  }
  if (expired.length) parts.push(`${expired.length} ack(s) expired (those findings alert normally again if still present)`);
  // Name the per-key form (inside the command's backticks when it has them).
  const cmd = renewCommand.endsWith('`') ? `${renewCommand.slice(0, -1)}=<key>\`` : `${renewCommand}=<key>`;
  return parts.length ? `; ${parts.join('; ')} — re-triage, then ${cmd} per key (bare flag renews all)` : '';
}

/**
 * Build the baseline document a --write-baseline run writes.
 * A key already in `prevDoc` keeps its timestamp/ttl unless `renew` (true for
 * every key, or a Set naming the keys to renew); a key no
 * longer found is dropped; a new key is stamped `nowMs`.
 */
/**
 * Read --renew-baseline from argv: null (absent), true (bare: renew all), or
 * the Set of keys named in --renew-baseline=k1,k2.
 */
function parseRenewArg(argv) {
  let out = null;
  for (const a of argv) {
    if (a === '--renew-baseline') out = true;
    else if (a.startsWith('--renew-baseline=')) {
      const keys = a.slice('--renew-baseline='.length).split(',').map((k) => k.trim()).filter(Boolean);
      if (out !== true) out = new Set([...(out || []), ...keys]);
    }
  }
  return out;
}

/**
 * Keys named for renewal that are not in `keys` (a typo would renew nothing).
 * An empty `--renew-baseline=` reports '(no key given)' so callers refuse it.
 */
function unknownRenewKeys(renew, keys) {
  if (!(renew instanceof Set)) return [];
  if (renew.size === 0) return ['(no key given)'];
  const have = new Set(keys);
  return [...renew].filter((k) => !have.has(k));
}

function buildBaseline(keys, prevDoc, { nowMs = Date.now(), ttlDays = DEFAULT_TTL_DAYS, renew = false, meta = {} } = {}) {
  const sorted = [...new Set(keys)].sort();
  const prevEntries = (prevDoc && prevDoc.entries) || {};
  const prevKeys = new Set(docKeys(prevDoc));
  const entries = {};
  const nowIso = new Date(nowMs).toISOString();
  let renewed = 0;
  let kept = 0;
  let added = 0;
  for (const k of sorted) {
    const prev = prevEntries[k];
    const renewThis = renew instanceof Set ? renew.has(k) : !!renew;
    if (!renewThis && prev && entryExpiresAtMs(prev) !== null) {
      entries[k] = { timestamp: prev.timestamp, ttlDays: Number(prev.ttlDays) };
      kept++;
    } else {
      entries[k] = { timestamp: nowIso, ttlDays };
      if (prevKeys.has(k)) renewed++; else added++;
    }
  }
  return {
    doc: { _meta: { ...meta, count: sorted.length, ttlDays }, keys: sorted, entries },
    stats: { kept, renewed, added, dropped: [...prevKeys].filter((k) => !entries[k]).length },
  };
}

module.exports = {
  DAY_MS,
  DEFAULT_TTL_DAYS,
  WARN_WITHIN_DAYS,
  activeBaselineKeys,
  expiredBaselineKeys,
  expiringSoon,
  describeExpiry,
  buildBaseline,
  parseRenewArg,
  unknownRenewKeys,
};
