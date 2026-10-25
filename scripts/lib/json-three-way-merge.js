#!/usr/bin/env node
'use strict';

/**
 * Key-wise 3-way merge of two JSON documents against their common base
 * (BRO-4688). Used by push-with-retry.sh's autostash restore when `git
 * merge-file` reports a text conflict on a .json file: a pretty-printed JSON
 * object conflicts as text whenever both sides touch nearby lines (two runs
 * each auto-registering an outlet in data/outlet-registry.json, a later
 * `lastUpdated`), even though no single value changed on both sides.
 *
 * Rules, applied recursively to plain objects (arrays and scalars are atomic):
 *   - both sides equal                -> that value
 *   - only one side changed from base -> the changed side (adds and deletes)
 *   - both changed, both objects      -> recurse key by key
 *   - both changed, both ISO-8601 timestamps -> the later one (freshness
 *     stamps like `lastUpdated`; the earlier stamp is the one dropped value)
 *   - anything else                   -> conflict; the whole merge fails
 * Apart from that stamp, no side's change is dropped: a true clash fails and
 * the caller keeps reporting the conflict. Unlike the core-data-merge-registry mergers (built
 * for the post-rebase reconcile, where "ours" is already blended and wins
 * shared keys), the base decides who changed what, so a stale snapshot never
 * reverts an upstream edit.
 *
 * Key order follows `theirs`, with keys only `ours` has appended in its order.
 *
 * CLI: node json-three-way-merge.js <base> <ours> <theirs> <out>
 *   Writes the merge to <out> in theirs' layout (indent, trailing newline) and
 *   exits 0; exits 1 on a conflict or any read/parse error (writes nothing).
 *   Also exits 1 when ours or theirs would not re-serialize byte-identically
 *   (other formatting, CRLF, integers past 2^53): rewriting would churn or
 *   corrupt the file, so the caller reports a conflict instead.
 *   A missing/empty <base> counts as "no base" ({} for objects).
 */

const fs = require('fs');

const CONFLICT = Symbol('conflict');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeValue(base, ours, theirs) {
  if (same(ours, theirs)) return ours;
  if (same(ours, base)) return theirs;
  if (same(theirs, base)) return ours;
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    return mergeObject(isPlainObject(base) ? base : {}, ours, theirs);
  }
  if (typeof ours === 'string' && typeof theirs === 'string' && ISO_RE.test(ours) && ISO_RE.test(theirs)) {
    const a = Date.parse(ours);
    const b = Date.parse(theirs);
    if (Number.isFinite(a) && Number.isFinite(b)) return a > b ? ours : theirs;
  }
  return CONFLICT;
}

function mergeObject(base, ours, theirs) {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // Insertion-ordered Set: theirs' keys, then ours-only, then base-only (a key
  // both sides deleted; merges to undefined and is dropped).
  const keys = new Set([...Object.keys(theirs), ...Object.keys(ours), ...Object.keys(base)]);
  const out = {};
  for (const k of keys) {
    const b = has(base, k) ? base[k] : undefined;
    const o = has(ours, k) ? ours[k] : undefined;
    const t = has(theirs, k) ? theirs[k] : undefined;
    const m = mergeValue(b, o, t);
    if (m === CONFLICT) return CONFLICT;
    // defineProperty: a literal "__proto__" key must stay a key.
    if (m !== undefined) Object.defineProperty(out, k, { value: m, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * @returns {{ok: true, merged: any} | {ok: false}}
 */
function mergeJson(base, ours, theirs) {
  const m = mergeValue(base, ours, theirs);
  return m === CONFLICT ? { ok: false } : { ok: true, merged: m };
}

function layoutOf(text) {
  const m = text.match(/^[{[]\r?\n([ \t]+)/);
  return { indent: m ? m[1] : 0, newline: text.endsWith('\n') };
}

function serialize(value, text) {
  const { indent, newline } = layoutOf(text);
  return JSON.stringify(value, null, indent) + (newline ? '\n' : '');
}

function roundTrips(text, value) {
  return serialize(value, text) === text;
}

function main(argv) {
  const [baseP, oursP, theirsP, outP] = argv;
  if (!outP) return 1;
  try {
    const baseText = fs.existsSync(baseP) ? fs.readFileSync(baseP, 'utf8') : '';
    const oursText = fs.readFileSync(oursP, 'utf8');
    const ours = JSON.parse(oursText);
    const theirsText = fs.readFileSync(theirsP, 'utf8');
    const theirs = JSON.parse(theirsText);
    if (!roundTrips(oursText, ours) || !roundTrips(theirsText, theirs)) return 1;
    const base = baseText.trim() ? JSON.parse(baseText) : (isPlainObject(theirs) ? {} : null);
    const res = mergeJson(base, ours, theirs);
    if (!res.ok) return 1;
    fs.writeFileSync(outP, serialize(res.merged, theirsText));
    return 0;
  } catch {
    return 1;
  }
}

module.exports = { mergeJson, layoutOf };

if (require.main === module) process.exit(main(process.argv.slice(2)));
