#!/usr/bin/env node
/**
 * land-gauntlet-merge.js — merge two split gauntlet result dirs into one
 * (BRO-7324 step B). 
 *
 * Called from land.yml on the branch tree: `node scripts/lib/land-gauntlet-merge.js <dirA> <dirB>`.
 * Runner A and runner B each ran land-gauntlet.sh on the same rebased tree:
 * every gate whole on exactly one of them, and the node unit batch split with
 * GAUNTLET_SHARD=k/n (node's own --test-shard). This writes the union into
 * dirA so every reader of a result dir (land-gate-delta.js --red-gates,
 * --rerun-scope and the verdict, land-gate-timing.js, the next-base artifact)
 * reads the same files as from one runner, plus the shard manifests that
 * land-gate-delta.js uses to refuse an incomplete split.
 *
 * Fail-closed order: dirA's meta.json is marked `sharded` FIRST, so a merge
 * that dies half way leaves a dir the verdict refuses, never one it reads as a
 * smaller unsplit run. A tree mismatch or a malformed shard pair exits 1
 * (infrastructure failure). A part or gate that is missing is NOT a merge
 * error: it is written into the manifest as a null part, and the verdict
 * refuses the gate with the reason.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { GATES, shardPart } = require('./land-gate-delta.js');

const SHARDED_GATES = new Set(['unit-tests-node']);
// Files a gate writes beside its own: they must come from the runner that ran it
// (tsc-tree-status feeds land.yml's tsc-stamp seed-export).
const ADJACENT = { tsc: ['tsc-tree-status'] };

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readExit(dir, gate) {
  const raw = readText(path.join(dir, `${gate}.exit`));
  if (raw === null) return undefined; // the gate never ran here
  const t = raw.trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
}
function readLines(file) {
  const t = readText(file);
  return t === null ? null : t.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** A gate one runner ran whole. Every gate writes a log: none means lost evidence. */
function wholePart(gate, dir) {
  const text = readText(path.join(dir, `${gate}.log`));
  const p = shardPart(gate, { exit: readExit(dir, gate), text: text || '' }, { whole: true });
  return text === null ? { ...p, finished: false } : p;
}

/** Pure. "k/n" -> {k, n} or null. */
function parseShard(s) {
  const m = /^([1-9]\d?)\/([1-9]\d?)$/.exec(String(s || ''));
  if (!m) return null;
  const k = Number(m[1]); const n = Number(m[2]);
  return k >= 1 && k <= n && n >= 2 && n <= 16 ? { k, n } : null;
}

/** Pure. The merged exit of a split gate: 0 only when every part is 0. */
function mergedExit(parts) {
  if (parts.every((p) => p && p.exit === 0)) return 0;
  const odd = parts.find((p) => p && Number.isInteger(p.exit) && p.exit !== 0 && p.exit !== 1);
  return odd ? odd.exit : 1;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Merge dirB into dirA. -> { ok, problems[], gates } ; ok=false only for
 * merge-level errors (sha/root/tree differ, bad shard pair, unreadable meta,
 * the parts sliced different file lists).
 */
function mergeGauntletDirs(dirA, dirB, { gates = GATES } = {}) {
  const metaA = readJson(path.join(dirA, 'meta.json'));
  const metaB = readJson(path.join(dirB, 'meta.json'));
  // Mark first: whatever happens next, the verdict sees a split run whose merge
  // has not finished (mergeIncomplete is dropped only by the final meta write),
  // so a crash mid-merge, or stale manifests in a reused dir, never read as done.
  const marked = { ...(metaA || {}), sharded: true, mergeIncomplete: true };
  fs.mkdirSync(dirA, { recursive: true });
  for (const f of fs.readdirSync(dirA)) if (f.endsWith('.shards.json')) fs.rmSync(path.join(dirA, f), { force: true });
  writeAtomic(path.join(dirA, 'meta.json'), `${JSON.stringify(marked, null, 2)}\n`);

  const problems = [];
  if (!metaA || !metaB) problems.push(`meta.json unreadable in ${!metaA ? dirA : dirB}`);
  const sA = parseShard(metaA && metaA.shard); const sB = parseShard(metaB && metaB.shard);
  if (!sA || !sB || sA.n !== 2 || sB.n !== 2 || sA.k === sB.k) problems.push(`the two runs are not parts 1/2 and 2/2 of one split (got ${metaA && metaA.shard}, ${metaB && metaB.shard})`);
  for (const k of ['sha', 'root', 'tree']) {
    if (!metaA || !metaB || !metaA[k] || metaA[k] !== metaB[k]) problems.push(`the two runs differ in ${k} (${metaA && metaA[k]} vs ${metaB && metaB[k]})`);
  }
  // A scoped run records the full list in .files but runs a narrower one, so
  // equal lists would prove nothing: a split run must be unscoped.
  for (const d of [dirA, dirB]) if (fs.existsSync(path.join(d, 'SCOPED'))) problems.push(`${d} is a scoped run; a split run must judge whole gates`);
  if (problems.length) return { ok: false, problems, gates: [] };

  const byPart = { [`${sA.k}/${sA.n}`]: dirA, [`${sB.k}/${sB.n}`]: dirB };
  const n = sA.n;
  const expected = Array.from({ length: n }, (_, i) => `${i + 1}/${n}`);
  const done = [];

  for (const gate of gates) {
    if (SHARDED_GATES.has(gate)) {
      // Both parts must have sliced ONE list: otherwise a file can fall in no slice.
      const lists = expected.map((k) => readLines(path.join(byPart[k], `${gate}.files`)));
      const ranLists = lists.filter((l, i) => l !== null || readExit(byPart[expected[i]], gate) !== undefined);
      if (ranLists.length > 1 && ranLists.some((l) => !l || [...l].sort().join('\n') !== [...ranLists[0]].sort().join('\n'))) {
        return { ok: false, problems: [`${gate}: the parts sliced different file lists, so some file may have run in no part`], gates: done };
      }
      const parts = {}; const logs = []; const files = []; let secs = null;
      for (const k of expected) {
        const dir = byPart[k];
        const exit = readExit(dir, gate);
        const text = readText(path.join(dir, `${gate}.log`)) || '';
        parts[k] = exit === undefined ? null : shardPart(gate, { exit, text });
        if (exit !== undefined) logs.push(`# ── part ${k} ──\n${text}`);
        if (exit !== undefined) for (const f of readLines(path.join(dir, `${gate}.files`)) || []) if (!files.includes(f)) files.push(f);
        const s = Number((readText(path.join(dir, `${gate}.secs`)) || '').trim());
        if ((readText(path.join(dir, `${gate}.secs`)) || '').trim() && Number.isFinite(s)) secs = secs === null ? s : Math.max(secs, s);
      }
      const ran = expected.filter((k) => parts[k]);
      writeAtomic(path.join(dirA, `${gate}.shards.json`), `${JSON.stringify({ expected, parts }, null, 2)}\n`);
      if (ran.length === 0) { fs.rmSync(path.join(dirA, `${gate}.exit`), { force: true }); done.push(gate); continue; }
      writeAtomic(path.join(dirA, `${gate}.log`), logs.join('\n'));
      writeAtomic(path.join(dirA, `${gate}.files`), files.length ? `${files.join('\n')}\n` : '');
      if (secs === null) fs.rmSync(path.join(dirA, `${gate}.secs`), { force: true }); else writeAtomic(path.join(dirA, `${gate}.secs`), `${secs}\n`);
      writeAtomic(path.join(dirA, `${gate}.exit`), `${mergedExit(expected.map((k) => parts[k]))}\n`);
      done.push(gate);
      continue;
    }
    // A whole gate: exactly one runner ran it.
    const inA = readExit(dirA, gate) !== undefined; const inB = readExit(dirB, gate) !== undefined;
    let part = null;
    if (inA && inB) {
      // Both ran it: ambiguous, refuse (never pick one).
      fs.rmSync(path.join(dirA, `${gate}.exit`), { force: true });
    } else if (inB) {
      for (const ext of ['exit', 'log', 'files', 'secs']) {
        const src = path.join(dirB, `${gate}.${ext}`);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dirA, `${gate}.${ext}`));
        else fs.rmSync(path.join(dirA, `${gate}.${ext}`), { force: true });
      }
      for (const f of ADJACENT[gate] || []) {
        const src = path.join(dirB, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dirA, f)); else fs.rmSync(path.join(dirA, f), { force: true });
      }
      part = wholePart(gate, dirB);
    } else if (inA) {
      part = wholePart(gate, dirA);
    }
    if (!inA && !inB) for (const f of ADJACENT[gate] || []) fs.rmSync(path.join(dirA, f), { force: true });
    const entry = { expected: ['1/1'], parts: { '1/1': part } };
    if (inA && inB) entry.note = 'both runners ran this gate';
    writeAtomic(path.join(dirA, `${gate}.shards.json`), `${JSON.stringify(entry, null, 2)}\n`);
    done.push(gate);
  }

  // Rewrite meta.json the way land-gauntlet.sh's writer does, from the files.
  const present = fs.readdirSync(dirA).filter((f) => f.endsWith('.exit')).map((f) => f.replace(/\.exit$/, '')).sort();
  const exits = Object.fromEntries(present.map((g) => [g, Number((readText(path.join(dirA, `${g}.exit`)) || '').trim())]));
  const gateSecs = {};
  for (const g of present) { const v = Number((readText(path.join(dirA, `${g}.secs`)) || '').trim()); if ((readText(path.join(dirA, `${g}.secs`)) || '').trim() && Number.isFinite(v)) gateSecs[g] = v; }
  const meta = {
    ...metaA, gates: present, exits, gateSecs, sharded: true,
    shards: expected, wallMs: Math.max(Number(metaA.wallMs) || 0, Number(metaB.wallMs) || 0),
    partWallMs: { [metaA.shard]: metaA.wallMs, [metaB.shard]: metaB.wallMs },
  };
  delete meta.shard;
  writeAtomic(path.join(dirA, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { ok: true, problems: [], gates: done };
}

module.exports = { mergeGauntletDirs, parseShard, mergedExit, SHARDED_GATES };

if (require.main === module) {
  const [dirA, dirB] = process.argv.slice(2);
  if (!dirA || !dirB) { console.error('usage: land-gauntlet-merge.js <dirA> <dirB>'); process.exit(2); }
  const r = mergeGauntletDirs(dirA, dirB);
  if (!r.ok) { for (const p of r.problems) console.error(`::error::split merge refused: ${p}`); process.exit(1); }
  console.log(`merged ${dirB} into ${dirA}: ${r.gates.length} gate(s)`);
}
