#!/usr/bin/env node
'use strict';
/**
 * check-registry-merge.js (BRO-3566)
 *
 * data/outlet-registry.json is one big JSON file many sessions edit. Git
 * merges it line by line, so when two branches touch the same outlet git can
 * keep one side's value without a conflict marker. That silently undid
 * main's chichester-observer domain fix during BRO-1343.
 *
 * This compares the merged file with its three inputs, per outlet and per
 * field (and per key of _aliasIndex):
 *   REGRESSION: a field only one side changed, but the result does not have
 *               that side's value (a fix was lost or an old value came back).
 *   CONFLICT:   both sides changed the same field to different values. A line
 *               merge picks one silently; a person should look.
 * Array fields (aliases, domainAliases) merge as sets: adds and removals from
 * both sides are expected in the result.
 *
 * land.yml runs it after the rebase (advisory). Usage:
 *   node scripts/check-registry-merge.js --ancestor=REF --ours=REF --theirs=REF [--result=REF]
 *   (--result defaults to the working-tree file)
 * Exit: 0 clean or could not check, 1 findings.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REL = 'data/outlet-registry.json';
const USAGE = `check-registry-merge.js: per-outlet 3-way check of ${REL} after a merge or rebase.

Usage:
  node scripts/check-registry-merge.js --ancestor=REF --ours=REF --theirs=REF [--result=REF]
  node scripts/check-registry-merge.js --help, -h    print this usage and exit
`;

// Key-order-insensitive equality; undefined means "absent".
function canon(v) {
  if (v === undefined) return '<absent>';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const same = (x, y) => canon(x) === canon(y);

// Expected merge of one value. {conflict:true} when both sides changed it differently.
function expect3(a, o, t) {
  if (same(o, a)) return { value: t };
  if (same(t, a) || same(o, t)) return { value: o };
  if ([a, o, t].every((x) => x === undefined || Array.isArray(x))) {
    // Set merge: union of both sides minus anything either side removed.
    const A = new Set((a || []).map(canon));
    const removed = new Set([...A].filter((x) => !(o || []).map(canon).includes(x) || !(t || []).map(canon).includes(x)));
    const out = new Map();
    for (const x of [...(o || []), ...(t || [])]) if (!removed.has(canon(x))) out.set(canon(x), x);
    return { value: [...out.values()], set: true };
  }
  return { conflict: true };
}

// Arrays (aliases, domainAliases) are sets here: a re-sort is not a change.
function sameResult(r, e) {
  if (!Array.isArray(e.value)) return same(r, e.value);
  if (!Array.isArray(r)) return false;
  const want = new Set(e.value.map(canon));
  const got = new Set(r.map(canon));
  return want.size === got.size && [...want].every((x) => got.has(x));
}

function checkKeys(prefix, A = {}, O = {}, T = {}, R = {}, findings) {
  const keys = new Set([...Object.keys(A), ...Object.keys(O), ...Object.keys(T), ...Object.keys(R)]);
  for (const k of keys) {
    const e = expect3(A[k], O[k], T[k]);
    const where = `${prefix}${k}`;
    if (e.conflict) {
      findings.push({ kind: 'CONFLICT', path: where, detail: `both sides changed it: ours=${canon(O[k])} theirs=${canon(T[k])} result=${canon(R[k])}` });
    } else if (!sameResult(R[k], e)) {
      findings.push({ kind: 'REGRESSION', path: where, detail: `expected ${canon(e.value)}, result has ${canon(R[k])}` });
    }
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Pure: the four parsed registries in, findings out.
function checkRegistryMerge(A, O, T, R) {
  const findings = [];
  const outlets = (x) => (x && x.outlets) || {};
  const ids = new Set([A, O, T, R].flatMap((x) => Object.keys(outlets(x))));
  for (const id of ids) {
    const [a, o, t, r] = [A, O, T, R].map((x) => outlets(x)[id]);
    const e = expect3(a, o, t);
    if (!e.conflict && same(r, e.value)) continue;
    if ([a, o, t, r].every((x) => x === undefined || isObj(x)) && o !== undefined && t !== undefined && r !== undefined) {
      checkKeys(`outlets.${id}.`, a || {}, o, t, r, findings);
    } else if (e.conflict) {
      findings.push({ kind: 'CONFLICT', path: `outlets.${id}`, detail: `one side removed the outlet, the other changed it (result ${r === undefined ? 'removed' : 'kept'} it)` });
    } else {
      findings.push({ kind: 'REGRESSION', path: `outlets.${id}`, detail: `expected ${e.value === undefined ? 'removed' : 'present'}, result has it ${r === undefined ? 'removed' : 'present'}` });
    }
  }
  checkKeys('_aliasIndex.', A && A._aliasIndex, O && O._aliasIndex, T && T._aliasIndex, R && R._aliasIndex, findings);
  return findings;
}

function readAt(ref, cwd) {
  if (!ref) return JSON.parse(fs.readFileSync(path.join(cwd, REL), 'utf8'));
  const out = execFileSync('git', ['show', `${ref}:${REL}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const arg = (n) => { const hit = argv.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(n.length + 3) : undefined; };
  const refs = { ancestor: arg('ancestor'), ours: arg('ours'), theirs: arg('theirs') };
  if (!refs.ancestor || !refs.ours || !refs.theirs) { console.error(USAGE); return 2; }
  let docs;
  try {
    docs = [refs.ancestor, refs.ours, refs.theirs, arg('result')].map((r) => readAt(r, cwd));
  } catch (err) {
    console.log(`outlet-registry merge check: COULD NOT CHECK (${String(err.message).split('\n')[0]})`);
    return 0;
  }
  const findings = checkRegistryMerge(...docs);
  if (!findings.length) { console.log('outlet-registry merge check: clean'); return 0; }
  const ci = Boolean(process.env.GITHUB_ACTIONS);
  for (const f of findings.slice(0, 50)) {
    const line = `${f.kind} ${f.path}: ${f.detail}`;
    console.log(ci ? `::warning title=outlet-registry merge ${f.kind}::${line}` : line);
  }
  if (findings.length > 50) console.log(`(+${findings.length - 50} more)`);
  console.log(`outlet-registry merge check: ${findings.length} finding(s). Check ${REL} by hand before trusting this merge.`);
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { checkRegistryMerge, expect3, main };
