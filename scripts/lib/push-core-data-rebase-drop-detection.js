#!/usr/bin/env node
'use strict';

/**
 * Detect and re-apply this job's own core-data edits that the push-conflict
 * rebase in .github/actions/push-core-data/action.yml silently dropped
 * (BRO-4972).
 *
 * Why: the retry loop runs `git rebase -X ours FETCH_HEAD` (a timed fetch plus a local rebase since BRO-4966; formerly `git pull --rebase -X ours origin main`). In a
 * rebase the sides are swapped, so "ours" is the upstream being rebased onto
 * and "theirs" is our local commit being replayed. Every conflicting hunk
 * therefore resolves to the REMOTE, and when every hunk conflicts the whole
 * commit is dropped ("patch contents already upstream") while the job still
 * prints "Core data pushed successfully". Live: backfill-historical-metadata
 * lost 22 and then 33 synopses (runs 38026560444, 38059972694) because
 * fetch-show-images had pushed images edits on the adjacent lines of the same
 * rows. reconcileShowsJson (reconcile-shows-fields.js) only pulls remote
 * values INTO the post-rebase file; nothing put ours back.
 *
 * How: a field-level 3-way check per record. base = the checkout snapshot
 * (what the job started from), ours = the job's committed copy before any
 * push attempt (its intent), current = the post-rebase, post-reconcile file.
 * Every leaf where ours differs from base is one of this job's edits. If
 * current no longer carries ours' value there:
 *   - current still equals base  -> the rebase dropped it: re-apply.
 *   - current differs from both  -> a concurrent writer changed the same
 *     field: keep remote (what the rebase already chose) and report it as a
 *     conflict. Keeping remote is deliberate: a job that calls push-core-data
 *     twice compares against a stale job-start base on the second call, so
 *     "ours wins" there would revert a newer concurrent value.
 * Edits to fields the job never touched are never written, so a concurrent
 * writer's change to them stands (BRO-5011: a fetch that kept the baseline
 * thumbnail must not restore it over a plan that nulled it).
 *
 * Arrays of objects that all carry a unique string `id` are matched by id
 * (shows.json `shows`), so adding or deleting whole records re-applies too.
 * Other arrays are atomic leaves, except an array whose elements carry ids
 * that are missing or duplicated: re-applying that atomically could revert
 * many concurrent rows, so it is reported as lost but never written.
 *
 * Only files in FILE_SPECS are checked. The other multi-writer core files
 * have their own merge functions (merge-commercial-data, merge-reviews-json,
 * the core-data-merge-registry), and their unkeyed arrays would make an
 * atomic re-apply revert a remote union.
 */

const fs = require('fs');

const FILE_SPECS = {
  'shows.json': { keyField: 'id' },
};

const MISSING = Symbol('missing');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function same(a, b) {
  if (a === MISSING || b === MISSING) return a === b;
  return deepEqual(a, b);
}

/** 'keyed' when every element is an object with a unique string key; 'atomic' for no ids at all; 'unkeyable' otherwise. */
function arrayKind(arr, keyField) {
  if (!Array.isArray(arr) || arr.length === 0) return 'empty';
  let withKey = 0;
  const seen = new Set();
  for (const el of arr) {
    if (isPlainObject(el) && typeof el[keyField] === 'string' && el[keyField] !== '') {
      if (seen.has(el[keyField])) return 'unkeyable';
      seen.add(el[keyField]);
      withKey++;
    }
  }
  if (withKey === 0) return 'atomic';
  return withKey === arr.length ? 'keyed' : 'unkeyable';
}

function keyedArrays(keyField, ...arrays) {
  const kinds = arrays.filter(Array.isArray).map((a) => arrayKind(a, keyField));
  if (kinds.some((k) => k === 'unkeyable')) return 'unkeyable';
  if (kinds.some((k) => k === 'keyed')) return kinds.every((k) => k === 'keyed' || k === 'empty') ? 'keyed' : 'unkeyable';
  return 'atomic';
}

/**
 * Leaf-level edits from base to ours. Each change: { path, ours, base,
 * unkeyable } where path segments are object keys or { key } array-element
 * selectors, and ours/base may be MISSING (added/deleted).
 */
function diffJson(base, ours, keyField = 'id', path = []) {
  if (same(base, ours)) return [];
  if (isPlainObject(base) && isPlainObject(ours)) {
    const out = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(ours)]);
    for (const k of keys) {
      const b = Object.prototype.hasOwnProperty.call(base, k) ? base[k] : MISSING;
      const o = Object.prototype.hasOwnProperty.call(ours, k) ? ours[k] : MISSING;
      out.push(...diffJson(b, o, keyField, [...path, k]));
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(ours)) {
    const kind = keyedArrays(keyField, base, ours);
    if (kind === 'keyed') {
      const bm = new Map(base.map((e) => [e[keyField], e]));
      const om = new Map(ours.map((e) => [e[keyField], e]));
      const out = [];
      for (const k of new Set([...bm.keys(), ...om.keys()])) {
        out.push(...diffJson(bm.has(k) ? bm.get(k) : MISSING, om.has(k) ? om.get(k) : MISSING, keyField, [...path, { key: k }]));
      }
      return out;
    }
    return [{ path, base, ours, unkeyable: kind === 'unkeyable' }];
  }
  return [{ path, base, ours, unkeyable: false }];
}

/** Value at path in doc, or MISSING. */
function getAt(doc, path, keyField = 'id') {
  let cur = doc;
  for (const seg of path) {
    if (cur === MISSING || cur === undefined) return MISSING;
    if (typeof seg === 'object') {
      if (!Array.isArray(cur)) return MISSING;
      const el = cur.find((e) => isPlainObject(e) && e[keyField] === seg.key);
      if (el === undefined) return MISSING;
      cur = el;
    } else {
      if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return MISSING;
      cur = cur[seg];
    }
  }
  return cur;
}

function clone(v) {
  return v === MISSING ? MISSING : JSON.parse(JSON.stringify(v));
}

/** Write (or delete, for MISSING) value at path in doc. Returns false if the parent is gone. */
function setAt(doc, path, value, keyField = 'id') {
  if (path.length === 0) return false;
  let parent = doc;
  for (const seg of path.slice(0, -1)) {
    const next = getAt(parent, [seg], keyField);
    if (next === MISSING || next === null || typeof next !== 'object') return false;
    parent = next;
  }
  const last = path[path.length - 1];
  if (typeof last === 'object') {
    if (!Array.isArray(parent)) return false;
    const idx = parent.findIndex((e) => isPlainObject(e) && e[keyField] === last.key);
    if (value === MISSING) {
      if (idx >= 0) parent.splice(idx, 1);
    } else if (idx >= 0) {
      parent[idx] = clone(value);
    } else {
      parent.push(clone(value));
    }
    return true;
  }
  if (!isPlainObject(parent)) return false;
  if (value === MISSING) delete parent[last];
  else parent[last] = clone(value);
  return true;
}

function formatPath(path) {
  return path.map((s) => (typeof s === 'object' ? `[${s.key}]` : `.${s}`)).join('').replace(/^\./, '') || '(root)';
}

/**
 * Compare this job's edits (base -> ours) against current.
 * @returns {{ edits: number, lost: Array, conflicts: Array, unkeyable: Array }}
 *   lost = edits current dropped back to base (safe to re-apply);
 *   conflicts = edits where current holds a third value;
 *   unkeyable = lost edits on arrays that cannot be re-applied safely.
 */
function findLostChanges(base, ours, current, keyField = 'id') {
  const edits = diffJson(base, ours, keyField);
  const lost = [];
  const conflicts = [];
  const unkeyable = [];
  for (const e of edits) {
    const cur = getAt(current, e.path, keyField);
    if (same(cur, e.ours)) continue;
    const entry = { path: e.path, label: formatPath(e.path), ours: e.ours, base: e.base, current: cur };
    if (e.unkeyable) unkeyable.push(entry);
    else if (same(cur, e.base)) lost.push(entry);
    else conflicts.push(entry);
  }
  return { edits: edits.length, lost, conflicts, unkeyable };
}

/**
 * Re-apply the job's dropped edits onto `current` (mutated). Conflicts and
 * unkeyable arrays are left as current has them and returned for reporting.
 */
function reapplyLostChanges(base, ours, current, keyField = 'id') {
  const found = findLostChanges(base, ours, current, keyField);
  const reapplied = [];
  const failed = [];
  for (const l of found.lost) {
    if (setAt(current, l.path, l.ours, keyField)) reapplied.push(l);
    else failed.push(l);
  }
  // A re-apply that cannot land because the parent row was deleted upstream is
  // the remote's intent: report it as a conflict, never as a lost edit.
  found.conflicts.push(...failed);
  const after = findLostChanges(base, ours, current, keyField);
  return {
    edits: found.edits,
    reapplied,
    failed,
    conflicts: found.conflicts,
    unkeyable: found.unkeyable,
    stillLost: after.lost.filter((l) => !failed.includes(l) && !failed.some((f) => f.label === l.label)).length + after.unkeyable.length,
  };
}

function preview(list, n = 15) {
  const labels = list.map((x) => x.label);
  return labels.slice(0, n).join(', ') + (labels.length > n ? ` (+${labels.length - n} more)` : '');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

/**
 * CLI used by push-core-data/action.yml after the post-rebase reconcile:
 *   node push-core-data-rebase-drop-detection.js --file shows.json \
 *     --base <snapshot> --ours <pre-push copy> --current <checkout file> [--write]
 * Prints GitHub annotations. Exit 0 unless PUSH_CORE_DATA_DROP_STRICT=1 and
 * an edit is still lost after re-apply (advisory first, CLAUDE.md rule 19).
 */
function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const args = parseArgs(argv);
  const file = args.file;
  const spec = FILE_SPECS[file];
  if (!spec) {
    log(`push-core-data drop check: ${file} is not in FILE_SPECS, skipped`);
    return 0;
  }
  let base;
  let ours;
  let current;
  try {
    base = JSON.parse(fs.readFileSync(args.base, 'utf8'));
    ours = JSON.parse(fs.readFileSync(args.ours, 'utf8'));
    current = JSON.parse(fs.readFileSync(args.current, 'utf8'));
  } catch (e) {
    log(`::warning::push-core-data drop check skipped for ${file}: cannot read base/ours/current (${e.message}); a rebase-dropped edit would go unnoticed this run`);
    return 0;
  }
  const r = args.write ? reapplyLostChanges(base, ours, current, spec.keyField) : null;
  const found = r || (() => {
    const f = findLostChanges(base, ours, current, spec.keyField);
    return { edits: f.edits, reapplied: [], failed: f.lost, conflicts: f.conflicts, unkeyable: f.unkeyable, stillLost: f.lost.length + f.unkeyable.length };
  })();

  if (found.reapplied.length > 0) {
    fs.writeFileSync(args.current, JSON.stringify(current, null, 2) + '\n');
    log(`::warning::push-core-data: the rebase dropped ${found.reapplied.length} of this job's ${found.edits} edit(s) in ${file}; re-applied: ${preview(found.reapplied)}`);
  }
  if (found.conflicts.length > 0) {
    log(`::warning::push-core-data: ${found.conflicts.length} edit(s) in ${file} were also changed by a concurrent push; kept the remote value: ${preview(found.conflicts)}`);
  }
  if (found.stillLost > 0) {
    const lostList = [...found.failed, ...found.unkeyable];
    log(`::error::push-core-data: ${found.stillLost} of this job's edit(s) in ${file} are NOT in the commit being pushed: ${preview(lostList)}`);
    if (env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `- push-core-data: ${found.stillLost} edit(s) in ${file} lost in rebase: ${preview(lostList)}\n`); } catch { /* best effort */ }
    }
    if (env.PUSH_CORE_DATA_DROP_STRICT === '1') return 2;
  }
  return 0;
}

module.exports = {
  FILE_SPECS,
  MISSING,
  diffJson,
  findLostChanges,
  reapplyLostChanges,
  main,
};

if (require.main === module) {
  process.exitCode = main();
}
