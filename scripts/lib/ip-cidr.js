/**
 * Pure IPv4/CIDR containment helpers for check-bd-blacklist.js.
 *
 * IPv6 and anything unparseable returns null from parseCidr, and
 * cidrContains treats unparseable input as NOT contained — callers that
 * auto-delete based on containment therefore fail safe (leave the entry
 * alone and alert instead).
 */

/** "a.b.c.d" → unsigned 32-bit int, or null if not a valid IPv4 address. */
function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** "a.b.c.d" or "a.b.c.d/nn" → { base, bits }, or null if unparseable. */
function parseCidr(s) {
  const [ip, maskStr, extra] = String(s).trim().split('/');
  if (extra !== undefined) return null;
  const base = ipToInt(ip);
  if (base === null) return null;
  let bits = 32;
  if (maskStr !== undefined) {
    if (!/^\d{1,2}$/.test(maskStr)) return null;
    bits = Number(maskStr);
    if (bits > 32) return null;
  }
  return { base, bits };
}

/** True when `inner` (IP or CIDR string) is fully inside `outer` (CIDR string). */
function cidrContains(outer, inner) {
  const o = parseCidr(outer);
  const i = parseCidr(inner);
  if (!o || !i) return false;
  if (i.bits < o.bits) return false; // inner is wider than outer
  // Compare network prefixes at the outer mask width. A /0 outer contains
  // everything; JS shifts are mod 32 so handle it explicitly.
  if (o.bits === 0) return true;
  const mask = (~0 << (32 - o.bits)) >>> 0;
  return ((o.base & mask) >>> 0) === ((i.base & mask) >>> 0);
}

/** True when `entry` is fully inside ANY of `ranges` (array of CIDR strings). */
function isCoveredByAny(entry, ranges) {
  return ranges.some((r) => cidrContains(r, entry));
}

/**
 * Partitions blacklist `entries` against GitHub Actions IPv4 `ghRanges` for
 * check-bd-blacklist.js: `ours` (auto-clear), `unknown` (parseable IPv4, not
 * GitHub — possible credential leak), `unclassified` (IPv6/junk, fails safe
 * by keeping it). Pure — no network, no I/O — so it's testable without
 * mocking the BD/GitHub APIs.
 */
function classifyBlacklistEntries(entries, ghRanges) {
  const ours = [];
  const unknown = [];
  const unclassified = [];
  for (const e of entries) {
    if (!parseCidr(e)) unclassified.push(e);
    else if (isCoveredByAny(e, ghRanges)) ours.push(e);
    else unknown.push(e);
  }
  return { ours, unknown, unclassified };
}

module.exports = { ipToInt, parseCidr, cidrContains, isCoveredByAny, classifyBlacklistEntries };
