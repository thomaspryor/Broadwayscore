'use strict';

/**
 * Show-id rename: plan + apply (2026 data audit, Sprint 5 / S5-T6 + S5-T8).
 *
 * A show id is the URL and the key in every file listed in
 * scripts/lib/show-id-keyed-files.js, across three repos (web, core-data,
 * review-texts). There is no other tool to rename one. This module:
 *
 *   planShowIdRename(oldId, newId, trees)  — pure decision logic. Reads the
 *     trees it is pointed at (never writes), and returns every key, field,
 *     path and directory the rename would change, every refusal reason, the
 *     mentions that would still be left afterwards (residual scan), the
 *     source files that hard-code the id, and the Supabase SQL to run.
 *   applyShowIdRename(plan)                — executes a plan: JSON rewrites
 *     through the repo's write guards (shows.json → shows-write-guard,
 *     commercial.json → commercial-write-guard, audience-buzz.json →
 *     audience-buzz-write-guard, review files → review-write-guard's
 *     safeWriteReview, everything else → atomic tmp+rename), then `git mv`
 *     (or rename, when the path is not tracked) for id-named dirs/files,
 *     then the inner `showId` re-stamp of the moved review files.
 *   buildSqlMigration(oldId, newId)        — the UPDATE per Supabase table
 *     with a show_id column (printed, never run).
 *
 * Invariants:
 *   - refuses when the target id already exists anywhere (shows.json id/slug/
 *     alias, any registered map key, any id-named path) or is retired;
 *   - refuses when the old id is missing from shows.json — except to RESUME
 *     a partial apply (new id present with the old id already in its
 *     `aliases`), so a crash mid-apply is recoverable by re-running;
 *   - retires nothing, never edits retired-show-ids.json / deleted-shows.json;
 *   - never touches a tree it was not pointed at: core-data files are reached
 *     through the web checkout's data/ mirror only when no --core-data is
 *     given (that is how every other script in this repo reaches them), and
 *     the plan prints which real path each write lands on.
 *
 * The CLI wrapper is scripts/rename-show-id.js; the test is
 * tests/unit/rename-show-id.test.mjs (runs both plan and apply on temp
 * copies of a three-tree fixture — CLAUDE.md §15: it requires this module).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SHOW_ID_KEYED_FILES } = require('./show-id-keyed-files');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const YEAR_SUFFIX_RE = /-\d{4}$/;
const MAX_FILE_BYTES = 96 * 1024 * 1024;
const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.core-data-checkout']);
const CODE_SCAN_DIRS = ['src', 'scripts', 'tests', '.github', 'supabase'];
const CODE_SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.sh', '.md', '.sql']);
const RESIDUAL_CAP_PER_FILE = 25;

// ---------------------------------------------------------------------------
// Supabase (S5-T8). Determined from the repo itself — supabase-schema.sql,
// supabase/migrations/*.sql, src/types/database.ts and the app code that
// queries each table. Nothing here is guessed from a live schema.
// ---------------------------------------------------------------------------

/** Tables whose `show_id`-class column holds a shows.json id. */
const SUPABASE_SHOW_ID_TABLES = [
  { table: 'reviews', column: 'show_id', declaredIn: 'supabase-schema.sql',
    confirmedBy: ['src/types/database.ts', 'src/hooks/useMyRating.ts (.from(\'reviews\'))'] },
  { table: 'watchlist', column: 'show_id', declaredIn: 'supabase-schema.sql',
    confirmedBy: ['src/types/database.ts', 'src/hooks/useWatchlist.ts (.from(\'watchlist\'))'],
    note: 'UNIQUE(user_id, show_id)' },
  { table: 'list_items', column: 'show_id', declaredIn: 'supabase-schema.sql',
    confirmedBy: ['src/hooks/useUserLists.ts (.from(\'list_items\'))'],
    note: 'UNIQUE(list_id, show_id)' },
  { table: 'seen_unrated', column: 'show_id', declaredIn: 'supabase/migrations/20261005_profile_onboarding.sql',
    confirmedBy: ['src/components/onboarding/WelcomeSheet.tsx', 'src/app/my-shows/MyShowsClient.tsx'],
    note: 'PRIMARY KEY(user_id, show_id)' },
];

/** JSONB columns that embed shows.json ids (need jsonb rewrites, not a plain UPDATE). */
const SUPABASE_JSONB_SHOW_ID_COLUMNS = [
  { table: 'fantasy_entries', column: 'picks', kind: 'jsonb array of show ids',
    declaredIn: 'supabase-schema.sql', confirmedBy: ['src/config/fantasy.ts:215 (`picks: string[]; // show IDs`)'] },
  { table: 'fantasy_entries', column: 'picks_prices_snapshot', kind: 'jsonb object keyed by show id',
    declaredIn: 'supabase/migrations/20260419_fantasy_price_lock.sql', confirmedBy: ['src/app/api/fantasy/draft/route.ts'] },
];

/** Columns that LOOK like show ids but hold something else — listed so nobody re-adds them. */
const SUPABASE_SHOW_ID_LOOKALIKES = [
  { table: 'unmatched_imports', column: 'mezz_show_id', holds: 'Mezzanine Show objectId',
    declaredIn: 'supabase/migrations/20260714_unmatched_imports.sql' },
  { table: 'unmatched_imports', column: 'resolved_show_id', holds: 'diary-shows.json id (scripts/resolve-unmatched-imports.js sets it from the diary entry, never from shows.json)',
    declaredIn: 'supabase/migrations/20260714_unmatched_imports.sql' },
  { table: 'import_fetch_log', column: 'slug', holds: 'Show-Score profile slug',
    declaredIn: 'supabase/migrations/20260713_import_fetch_log.sql' },
  { table: 'user_show_stubs', column: 'mezz_prod_id', holds: 'Mezzanine Production objectId',
    declaredIn: 'supabase/migrations/20260714e_user_show_stubs.sql' },
];

/** Tables the repo references without a CREATE TABLE anywhere in it — columns unknown, cannot confirm. */
const SUPABASE_UNVERIFIED_TABLES = [
  { table: 'push_tokens', referencedIn: 'supabase/migrations/20260422_security_advisor_fixes.sql (ALTER POLICY only), supabase/functions/delete-account/index.ts' },
];

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @returns {{ statements: string[], jsonbStatements: string[], text: string }}
 */
function buildSqlMigration(oldId, newId) {
  const o = sqlLiteral(oldId);
  const n = sqlLiteral(newId);
  const statements = SUPABASE_SHOW_ID_TABLES.map(
    (t) => `UPDATE ${t.table} SET ${t.column} = ${n} WHERE ${t.column} = ${o};`
  );
  const jsonbStatements = [
    // picks: jsonb array of ids
    `UPDATE fantasy_entries SET picks = (SELECT COALESCE(jsonb_agg(CASE WHEN elem = to_jsonb(${o}::text) THEN to_jsonb(${n}::text) ELSE elem END), '[]'::jsonb) FROM jsonb_array_elements(picks) AS elem) WHERE picks @> jsonb_build_array(${o}::text);`,
    // picks_prices_snapshot: jsonb object keyed by id
    `UPDATE fantasy_entries SET picks_prices_snapshot = (picks_prices_snapshot - ${o}) || jsonb_build_object(${n}, picks_prices_snapshot -> ${o}) WHERE picks_prices_snapshot ? ${o};`,
  ];
  const lines = [];
  lines.push(`-- Supabase migration: rename show id ${oldId} -> ${newId}`);
  lines.push('-- Generated by scripts/rename-show-id.js (S5-T8). Printed, never run by the tool.');
  lines.push('-- Pattern: supabase/migrations/TEMPLATE_rename_show_id.sql.txt');
  lines.push('-- Tables confirmed from the repo (supabase-schema.sql / migrations / src):');
  for (const t of SUPABASE_SHOW_ID_TABLES) {
    lines.push(`--   ${t.table}.${t.column} (${t.declaredIn}; ${t.confirmedBy.join(', ')})${t.note ? ` — ${t.note}` : ''}`);
  }
  lines.push('-- Pre-flight (expect the counts you see in the app; 0 rows is fine):');
  for (const t of SUPABASE_SHOW_ID_TABLES) {
    lines.push(`--   SELECT count(*) FROM ${t.table} WHERE ${t.column} = ${o};`);
  }
  lines.push('BEGIN;');
  lines.push(...statements);
  lines.push('-- JSONB columns that embed show ids (review, then uncomment):');
  for (const c of SUPABASE_JSONB_SHOW_ID_COLUMNS) {
    lines.push(`--   ${c.table}.${c.column}: ${c.kind} (${c.declaredIn}; ${c.confirmedBy.join(', ')})`);
  }
  for (const s of jsonbStatements) lines.push(`-- ${s}`);
  lines.push('COMMIT;');
  lines.push('-- Not shows.json ids (left alone): ' + SUPABASE_SHOW_ID_LOOKALIKES.map((c) => `${c.table}.${c.column} = ${c.holds}`).join('; '));
  lines.push('-- Unverifiable (no CREATE TABLE in the repo): ' + SUPABASE_UNVERIFIED_TABLES.map((t) => `${t.table} (${t.referencedIn})`).join('; '));
  return { statements, jsonbStatements, text: lines.join('\n') + '\n' };
}

// ---------------------------------------------------------------------------
// small fs helpers
// ---------------------------------------------------------------------------

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function realpathOr(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function yearlessSlug(id) { return id.replace(YEAR_SUFFIX_RE, ''); }

// Where a write to `filePath` must land: rename() onto a symlink replaces
// the link with a regular file (orphaning the core-data target) — same trap
// scripts/lib/atomic-shows-write.js and retired-show-ids.js resolve.
function resolveWriteTarget(filePath) {
  try { return fs.realpathSync(filePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let link = null;
  try { if (fs.lstatSync(filePath).isSymbolicLink()) link = fs.readlinkSync(filePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (link === null) return filePath;
  return resolveWriteTarget(path.resolve(path.dirname(filePath), link));
}

function atomicWriteText(filePath, text) {
  const target = resolveWriteTarget(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
  return target;
}

/** Detect the indent + trailing-newline convention of a JSON text so a rewrite does not reformat the file. */
function detectJsonFormat(text) {
  const m = /^[\s﻿]*[[{]\r?\n([ \t]+)\S/.exec(text);
  return { indent: m ? m[1] : 0, trailingNewline: text.endsWith('\n') };
}

function serializeJson(doc, format) {
  const body = format.indent ? JSON.stringify(doc, null, format.indent) : JSON.stringify(doc);
  return format.trailingNewline ? body + '\n' : body;
}

// ---------------------------------------------------------------------------
// JSON path utilities
// ---------------------------------------------------------------------------

function joinPath(base, seg) {
  if (typeof seg === 'number') return `${base}[${seg}]`;
  return base ? `${base}.${seg}` : seg;
}

/**
 * Resolve `keyPath` (array of segments, '*' = every element/value) against a
 * document. Returns [{ value, path }] for every container reached.
 */
function resolveContainers(doc, keyPath) {
  let current = [{ value: doc, path: '' }];
  for (const seg of keyPath) {
    const next = [];
    for (const { value, path: p } of current) {
      if (value === null || typeof value !== 'object') continue;
      if (seg === '*') {
        if (Array.isArray(value)) value.forEach((v, i) => next.push({ value: v, path: joinPath(p, i) }));
        else for (const k of Object.keys(value)) next.push({ value: value[k], path: joinPath(p, k) });
      } else if (Object.prototype.hasOwnProperty.call(value, seg)) {
        next.push({ value: value[seg], path: joinPath(p, seg) });
      }
    }
    current = next;
  }
  return current.filter((c) => c.value !== null && typeof c.value === 'object');
}

/** Rename a key in place, keeping the object's key order (diff-friendly). */
function renameKeyInPlace(obj, oldKey, newKey) {
  const entries = Object.entries(obj);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) obj[k === oldKey ? newKey : k] = v;
}

function colonRename(key, oldKey, newKey) {
  if (!key.includes(':')) return key === oldKey ? newKey : key;
  const segs = key.split(':');
  let changed = false;
  const out = segs.map((s) => { if (s === oldKey) { changed = true; return newKey; } return s; });
  return changed ? out.join(':') : key;
}

/**
 * Apply one registry entry's shape to a parsed document. Mutates `doc`.
 * @returns {Array<{op:string, at:string, from:string, to:string}>} edits
 *   (throws on a key collision — the caller turns that into a refusal at
 *   plan time, so apply never sees one)
 */
function applyShape(doc, entry, ctx) {
  const keyedBy = entry.keyedBy || 'id';
  let oldKey; let newKey;
  if (keyedBy === 'slug') {
    if (!ctx.slugChanged) return [];
    oldKey = ctx.oldSlug; newKey = ctx.newSlug;
  } else {
    oldKey = ctx.oldId; newKey = ctx.newId;
  }
  const edits = [];
  const ignore = new Set(entry.ignoreKeys || []);
  for (const { value: container, path: base } of resolveContainers(doc, entry.keyPath)) {
    if (entry.shape === 'map') {
      if (!isPlainObject(container)) continue;
      for (const key of Object.keys(container)) {
        if (ignore.has(key)) continue;
        const renamed = entry.keyStyle === 'colon-segments' ? colonRename(key, oldKey, newKey) : (key === oldKey ? newKey : key);
        if (renamed === key) continue;
        if (Object.prototype.hasOwnProperty.call(container, renamed)) {
          const err = new Error(`key ${JSON.stringify(renamed)} already exists at ${base || '<root>'}`);
          err.code = 'KEY_COLLISION';
          throw err;
        }
        renameKeyInPlace(container, key, renamed);
        edits.push({ op: 'rename-key', at: joinPath(base, key), from: key, to: renamed });
      }
    } else if (entry.shape === 'records') {
      if (!Array.isArray(container)) continue;
      container.forEach((rec, i) => {
        if (!isPlainObject(rec)) return;
        if (rec[entry.idField] === oldKey) {
          rec[entry.idField] = newKey;
          edits.push({ op: 'set-field', at: joinPath(joinPath(base, i), entry.idField), from: oldKey, to: newKey });
        }
        if (entry.slugField && ctx.slugChanged && rec[entry.slugField] === ctx.oldSlug) {
          rec[entry.slugField] = ctx.newSlug;
          edits.push({ op: 'set-field', at: joinPath(joinPath(base, i), entry.slugField), from: ctx.oldSlug, to: ctx.newSlug });
        }
      });
    } else if (entry.shape === 'list') {
      if (!Array.isArray(container)) continue;
      container.forEach((v, i) => {
        if (v === oldKey) { container[i] = newKey; edits.push({ op: 'replace-value', at: joinPath(base, i), from: oldKey, to: newKey }); }
      });
    } else if (entry.shape === 'id-values') {
      const walk = (node, p) => {
        if (Array.isArray(node)) node.forEach((v, i) => { if (v === oldKey) { node[i] = newKey; edits.push({ op: 'replace-value', at: joinPath(p, i), from: oldKey, to: newKey }); } else walk(v, joinPath(p, i)); });
        else if (isPlainObject(node)) for (const k of Object.keys(node)) { if (node[k] === oldKey) { node[k] = newKey; edits.push({ op: 'replace-value', at: joinPath(p, k), from: oldKey, to: newKey }); } else walk(node[k], joinPath(p, k)); }
      };
      walk(container, base);
    }
  }
  return edits;
}

/**
 * Generic pass over a whole document: every string VALUE equal to the old id
 * becomes the new id (cross-row refs like originalProductionId, showId on
 * review/cast/llm-score files, slug fields that equal the id), and every
 * '/images/shows/<old-id>/…' path segment follows the image directory move.
 * Keys are never touched here (unregistered id-keyed maps must be added to
 * the registry; they surface in the residual scan instead). Mutates `doc`.
 */
// `aliases` arrays are the one designed home for an old id (build-slug-
// redirects.js turns them into redirects), so neither pass looks inside them.
const ALIAS_KEYS = new Set(['aliases']);

function genericPass(doc, ctx, edits, skipKeys = ALIAS_KEYS) {
  const imageRe = new RegExp(`(^|/)images/shows/${escapeRe(ctx.oldId)}(?=/|$)`);
  const visit = (node, p) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        const at = joinPath(p, i);
        if (typeof v === 'string') { const r = rewriteString(v); if (r !== null) { node[i] = r.to; edits.push({ op: r.op, at, from: v, to: r.to }); } }
        else visit(v, at);
      });
    } else if (isPlainObject(node)) {
      for (const k of Object.keys(node)) {
        if (skipKeys.has(k)) continue;
        const v = node[k];
        const at = joinPath(p, k);
        if (typeof v === 'string') { const r = rewriteString(v); if (r !== null) { node[k] = r.to; edits.push({ op: r.op, at, from: v, to: r.to }); } }
        else visit(v, at);
      }
    }
  };
  const prefix = `${ctx.oldId}/`;
  const rewriteString = (s) => {
    if (s === ctx.oldId) return { op: 'replace-value', to: ctx.newId };
    if (!s.includes(ctx.oldId)) return null;
    if (imageRe.test(s)) return { op: 'replace-path', to: s.replace(imageRe, `$1images/shows/${ctx.newId}`) };
    // '<id>/<file>' is the review-texts-relative review id (failed-fetches
    // reviewId, audit `file` fields); the directory moves, so it follows.
    if (s.startsWith(prefix)) return { op: 'replace-prefix', to: `${ctx.newId}/${s.slice(prefix.length)}` };
    return null;
  };
  visit(doc, '');
}

/** Find remaining mentions of `needle` (keys or substrings of string values) in a document. */
function findMentions(doc, needle, cap = RESIDUAL_CAP_PER_FILE, skipKeys = ALIAS_KEYS) {
  const hits = [];
  let total = 0;
  const push = (h) => { total++; if (hits.length < cap) hits.push(h); };
  const visit = (node, p) => {
    if (Array.isArray(node)) node.forEach((v, i) => visit(v, joinPath(p, i)));
    else if (isPlainObject(node)) {
      for (const k of Object.keys(node)) {
        if (skipKeys.has(k)) continue;
        if (k.includes(needle)) push({ at: joinPath(p, k), kind: k === needle ? 'key' : 'key-substring' });
        visit(node[k], joinPath(p, k));
      }
    } else if (typeof node === 'string' && node.includes(needle)) {
      push({ at: p || '<root>', kind: node === needle ? 'value' : 'value-substring', value: node.length > 160 ? node.slice(0, 157) + '...' : node });
    }
  };
  visit(doc, '');
  return { hits, total };
}

// ---------------------------------------------------------------------------
// registry resolution against concrete trees
// ---------------------------------------------------------------------------

/**
 * @param {{web?: string, coreData?: string|null, reviewTexts?: string|null}} treesIn
 * @returns {{web: string, coreData: string|null, reviewTexts: string|null, reviewTextsVia: string|null}}
 */
function resolveTrees(treesIn = {}) {
  const web = path.resolve(treesIn.web || REPO_ROOT);
  const coreData = treesIn.coreData ? path.resolve(treesIn.coreData) : null;
  let reviewTexts = treesIn.reviewTexts ? path.resolve(treesIn.reviewTexts) : null;
  let reviewTextsVia = null;
  if (!reviewTexts) {
    // Same resolution every other script uses: the web checkout's
    // data/review-texts (a symlink to the private clone, or a real dir).
    const candidate = path.join(web, 'data', 'review-texts');
    if (isDir(candidate)) { reviewTexts = realpathOr(candidate); reviewTextsVia = candidate; }
  }
  return { web, coreData, reviewTexts, reviewTextsVia };
}

function treeRoot(entry, trees) {
  if (entry.repo === 'web') return trees.web;
  if (entry.repo === 'core-data') return trees.coreData;
  return trees.reviewTexts;
}

/** Expand `*` segments in a registry path against the tree ('aggregator-archive/*' → one per source dir). */
function expandPathGlob(root, relPath) {
  if (!relPath.includes('*')) return [relPath];
  let acc = [''];
  for (const seg of relPath.split('/')) {
    const next = [];
    for (const a of acc) {
      if (!seg.includes('*')) { next.push(a ? `${a}/${seg}` : seg); continue; }
      const dir = path.join(root, a);
      if (!isDir(dir)) continue;
      const re = new RegExp('^' + seg.split('*').map(escapeRe).join('.*') + '$');
      for (const name of fs.readdirSync(dir).sort()) {
        if (!name.startsWith('.') && re.test(name)) next.push(a ? `${a}/${name}` : name);
      }
    }
    acc = next;
  }
  return acc;
}

/**
 * Concrete targets for an entry: {abs, display, root, entry, viaMirror}.
 * Returns { targets, skipped } — skipped carries a reason when the tree is
 * not available or nothing on disk matches.
 */
function locateEntry(entry, trees) {
  let root = treeRoot(entry, trees);
  let viaMirror = false;
  let relPath = entry.path;
  if (!root) {
    if (entry.repo === 'core-data' && entry.webMirror) { root = trees.web; relPath = entry.webMirror; viaMirror = true; }
    else return { targets: [], skipped: `${entry.repo} tree not given` };
  }
  const label = (rel) => `${entry.repo}:${viaMirror ? `${entry.path} (via web ${rel})` : (rel === '.' ? '' : rel)}`;
  const rels = expandPathGlob(root, relPath);
  if (!rels.length) return { targets: [], skipped: 'no path matches the registry glob' };
  const targets = [];
  let lastSkip = null;
  for (const rel of rels) {
    const base = path.join(root, rel);
    if (entry.glob) {
      if (!isDir(base)) { lastSkip = 'directory missing'; continue; }
      const re = new RegExp('^' + entry.glob.split('*').map(escapeRe).join('.*') + '$');
      const found = fs.readdirSync(base).filter((f) => re.test(f) && !f.startsWith('.')).sort();
      if (!found.length) lastSkip = 'no files match glob';
      for (const f of found) targets.push({ abs: path.join(base, f), display: label(path.posix.join(rel, f)), root, entry, viaMirror });
    } else if (entry.shape === 'dir' || entry.shape === 'file') {
      if (!isDir(base)) { lastSkip = 'directory missing'; continue; }
      targets.push({ abs: base, display: label(rel), root, entry, viaMirror, relPath: rel });
    } else {
      if (!isFile(base)) { lastSkip = 'file missing'; continue; }
      targets.push({ abs: base, display: label(rel), root, entry, viaMirror, relPath: rel });
    }
  }
  return { targets, skipped: targets.length ? null : (lastSkip || 'nothing found') };
}

/** Old/new concrete paths for a dir/file entry. */
function idPaths(entry, ctx) {
  const pattern = entry.shape === 'dir' ? '{id}' : entry.pattern;
  const fill = (id) => pattern.replace('{id}', id);
  return { oldName: fill(ctx.oldId), newName: fill(ctx.newId), isGlob: pattern.includes('*') };
}

function listMatching(dir, name, isGlob) {
  if (!isGlob) return exists(path.join(dir, name)) ? [name] : [];
  const re = new RegExp('^' + name.split('*').map(escapeRe).join('.*') + '$');
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort();
}

function gitTracked(root, rel) {
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

/** JSON/JSONL files inside a moved dir (flat + one level of subdirs), or the file itself. */
function innerJsonFiles(abs) {
  if (isFile(abs)) return /\.(json|jsonl)$/.test(abs) ? [abs] : [];
  const out = [];
  const walk = (d, depth) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (isDir(p)) { if (depth < 2 && !SCAN_SKIP_DIRS.has(f)) walk(p, depth + 1); }
      else if (/\.(json|jsonl)$/.test(f)) out.push(p);
    }
  };
  walk(abs, 0);
  return out;
}

// ---------------------------------------------------------------------------
// document rewrite (shared by plan and apply)
// ---------------------------------------------------------------------------

/**
 * Parse `text` (JSON, or JSONL when `jsonl`), apply every entry in
 * `entries` plus the generic pass, and return the mutated doc(s) + edits +
 * residual mentions. Pure w.r.t. the filesystem.
 */
function rewriteText(text, entries, ctx, { jsonl = false, skipGenericKeys } = {}) {
  const skip = skipGenericKeys ? new Set(skipGenericKeys) : ALIAS_KEYS;
  if (jsonl) {
    const lines = text.split('\n');
    const edits = [];
    let residual = { hits: [], total: 0 };
    const out = lines.map((line, i) => {
      if (!line.trim()) return line;
      let doc;
      try { doc = JSON.parse(line); } catch { return line; }
      const lineEdits = [];
      genericPass(doc, ctx, lineEdits, skip);
      lineEdits.forEach((e) => edits.push({ ...e, at: `line ${i + 1}: ${e.at}` }));
      const m = findMentions(doc, ctx.oldId);
      residual = { hits: residual.hits.concat(m.hits.map((h) => ({ ...h, at: `line ${i + 1}: ${h.at}` }))).slice(0, RESIDUAL_CAP_PER_FILE), total: residual.total + m.total };
      return lineEdits.length ? JSON.stringify(doc) : line;
    });
    return { edits, residual, text: out.join('\n'), doc: null };
  }
  const doc = JSON.parse(text);
  const edits = [];
  for (const entry of entries) {
    if (entry.rewrite === false) continue;
    if (['map', 'records', 'list', 'id-values'].includes(entry.shape)) edits.push(...applyShape(doc, entry, ctx));
  }
  genericPass(doc, ctx, edits, skip);
  return { edits, residual: findMentions(doc, ctx.oldId), text: null, doc };
}

/** Group edits into counts for the summary line. */
function countEdits(edits) {
  const c = { keys: 0, fields: 0, refs: 0, paths: 0 };
  for (const e of edits) {
    if (e.op === 'rename-key') c.keys++;
    else if (e.op === 'set-field') c.fields++;
    else if (e.op === 'replace-path' || e.op === 'replace-prefix') c.paths++;
    else c.refs++;
  }
  return c;
}

// ---------------------------------------------------------------------------
// residual + code scans (read-only)
// ---------------------------------------------------------------------------

function walkFiles(root, onFile, { skipDirs = SCAN_SKIP_DIRS, followSymlinkDirs = false } = {}) {
  const visit = (dir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        let target;
        try { target = fs.statSync(p); } catch { continue; }
        if (target.isDirectory()) { if (followSymlinkDirs && !skipDirs.has(name)) visit(p); continue; }
        onFile(p, target);
        continue;
      }
      if (st.isDirectory()) { if (!skipDirs.has(name)) visit(p); }
      else onFile(p, st);
    }
  };
  visit(root);
}

/** Mentions of `needle` in every JSON/JSONL under `roots`, excluding realpaths in `exclude`. */
function scanResidual(roots, needle, exclude) {
  const found = [];
  const seen = new Set();
  for (const { root, label } of roots) {
    if (!root || !isDir(root)) continue;
    walkFiles(root, (p, st) => {
      if (!/\.(json|jsonl)$/.test(p) || st.size > MAX_FILE_BYTES) return;
      const real = realpathOr(p);
      if (seen.has(real) || exclude.has(real)) return;
      seen.add(real);
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
      if (!text.includes(needle)) return;
      const rel = path.relative(root, p);
      if (p.endsWith('.jsonl')) {
        const hits = []; let total = 0;
        text.split('\n').forEach((line, i) => {
          if (!line.includes(needle)) return;
          let doc; try { doc = JSON.parse(line); } catch { total++; if (hits.length < RESIDUAL_CAP_PER_FILE) hits.push({ at: `line ${i + 1}`, kind: 'unparsed' }); return; }
          const m = findMentions(doc, needle);
          total += m.total;
          m.hits.forEach((h) => { if (hits.length < RESIDUAL_CAP_PER_FILE) hits.push({ ...h, at: `line ${i + 1}: ${h.at}` }); });
        });
        found.push({ path: `${label}:${rel}`, abs: p, hits, total });
        return;
      }
      let doc;
      try { doc = JSON.parse(text); } catch { found.push({ path: `${label}:${rel}`, abs: p, hits: [{ at: '<unparsed>', kind: 'unparsed' }], total: 1 }); return; }
      const m = findMentions(doc, needle);
      if (m.total) found.push({ path: `${label}:${rel}`, abs: p, hits: m.hits, total: m.total });
    });
  }
  return found;
}

/** Source files (src/, scripts/, tests/, .github/, supabase/) that mention the id — report only. */
function scanCodeRefs(web, needle) {
  const found = [];
  for (const d of CODE_SCAN_DIRS) {
    const root = path.join(web, d);
    if (!isDir(root)) continue;
    walkFiles(root, (p, st) => {
      if (!CODE_SCAN_EXT.has(path.extname(p)) || st.size > 8 * 1024 * 1024) return;
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
      if (text.includes(needle)) found.push(path.relative(web, p));
    });
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function loadShowsJson(showsPath) {
  const parsed = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = Array.isArray(parsed) ? parsed : parsed.shows;
  if (!Array.isArray(shows)) throw new Error(`${showsPath}: expected { shows: [...] }`);
  return shows;
}

/**
 * Compute the rename plan. Reads the trees; never writes.
 *
 * @param {string} oldId
 * @param {string} newId
 * @param {{web?: string, coreData?: string|null, reviewTexts?: string|null, scanCode?: boolean}} [treesIn]
 *   web defaults to this repo's root. coreData/reviewTexts default to null /
 *   the web checkout's data/review-texts. `scanCode: false` skips the
 *   src/scripts mention scan (tests).
 * @returns {object} plan — `ok` is false when `refusals` is non-empty.
 */
function planShowIdRename(oldId, newId, treesIn = {}) {
  const trees = resolveTrees(treesIn);
  const plan = {
    oldId, newId, trees, ok: true, refusals: [], resume: false,
    showsPath: null, row: null, oldSlug: null, newSlug: null, slugChanged: false, aliases: null,
    changes: [], moves: [], skipped: [], residual: [], codeRefs: [], sql: null, summary: null,
  };
  const refuse = (msg) => { plan.refusals.push(msg); plan.ok = false; };

  if (typeof oldId !== 'string' || !ID_RE.test(oldId)) refuse(`old id ${JSON.stringify(oldId)} is not a valid show id (lowercase slug with a year suffix, e.g. the-show-2026)`);
  if (typeof newId !== 'string' || !ID_RE.test(newId)) refuse(`new id ${JSON.stringify(newId)} is not a valid show id (lowercase slug with a year suffix, e.g. the-show-2027)`);
  if (oldId === newId) refuse('old and new id are identical');
  if (!plan.ok) { plan.sql = buildSqlMigration(String(oldId), String(newId)); return plan; }

  // shows.json — source of truth; core-data clone when given, else the web checkout's data/shows.json.
  plan.showsPath = trees.coreData ? path.join(trees.coreData, 'shows.json') : path.join(trees.web, 'data', 'shows.json');
  if (!isFile(plan.showsPath)) {
    refuse(`shows.json not found at ${plan.showsPath} (pass --core-data=<clone> or run scripts/setup-local-data.sh)`);
    plan.sql = buildSqlMigration(oldId, newId);
    return plan;
  }
  let shows;
  try { shows = loadShowsJson(plan.showsPath); } catch (e) { refuse(`cannot read ${plan.showsPath}: ${e.message}`); plan.sql = buildSqlMigration(oldId, newId); return plan; }

  const oldRow = shows.find((s) => s && s.id === oldId);
  const newRow = shows.find((s) => s && s.id === newId);
  if (!oldRow) {
    if (newRow && Array.isArray(newRow.aliases) && newRow.aliases.includes(oldId)) {
      // A previous apply already renamed the row (crash/interruption after
      // the shows.json write). Continue with the remaining files.
      plan.resume = true;
      plan.row = newRow;
    } else {
      const bySlug = shows.find((s) => s && s.slug === oldId);
      refuse(`old id ${oldId} is not in ${plan.showsPath}${bySlug ? ` (it is the slug of ${bySlug.id} — rename the id, not the slug)` : ''}`);
    }
  } else {
    plan.row = oldRow;
    if (newRow) refuse(`target id ${newId} already exists in shows.json (${newRow.title || 'untitled'}, ${newRow.venue || 'no venue'}) — a merge is not a rename`);
  }
  for (const s of shows) {
    if (!s || s === plan.row) continue;
    if (s.slug === newId) refuse(`target id ${newId} is already the slug of ${s.id}`);
    if (Array.isArray(s.aliases) && s.aliases.includes(newId)) refuse(`target id ${newId} is already an alias of ${s.id}`);
  }
  if (plan.row) {
    // Retired ids never come back (scripts/lib/retired-show-ids.js).
    const retiredPath = path.join(path.dirname(plan.showsPath), 'retired-show-ids.json');
    if (isFile(retiredPath)) {
      try {
        const retired = JSON.parse(fs.readFileSync(retiredPath, 'utf8'));
        if (Array.isArray(retired) && retired.some((e) => e && e.id === newId)) refuse(`target id ${newId} is retired (${retiredPath}) — retired ids must never come back`);
      } catch (e) { refuse(`cannot read ${retiredPath}: ${e.message}`); }
    }
    plan.oldSlug = plan.resume ? (plan.row.slug === newId ? oldId : plan.row.slug) : (plan.row.slug || oldId);
    plan.newSlug = plan.oldSlug === oldId ? newId : plan.oldSlug;
    plan.slugChanged = plan.oldSlug !== plan.newSlug;
    const existing = Array.isArray(plan.row.aliases) ? plan.row.aliases : [];
    const aliases = [...existing];
    for (const a of [oldId, yearlessSlug(oldId)]) {
      if (a && a !== newId && a !== plan.newSlug && !aliases.includes(a)) aliases.push(a);
    }
    plan.aliases = aliases;
  }
  const ctx = { oldId, newId, oldSlug: plan.oldSlug, newSlug: plan.newSlug, slugChanged: plan.slugChanged };

  // Group registry entries by the real file they resolve to (the web
  // checkout's data/shows.json symlink and the core clone's shows.json are one
  // file; the tracked data/awards.json copy and the core awards.json are two).
  const groups = new Map(); // realpath → { targets:[], entries:[] }
  const handled = new Set(); // realpaths the plan rewrites (excluded from the residual scan)
  for (const entry of SHOW_ID_KEYED_FILES) {
    const { targets, skipped } = locateEntry(entry, trees);
    if (skipped) { plan.skipped.push({ path: `${entry.repo}:${entry.path}`, reason: skipped }); continue; }
    for (const t of targets) {
      const key = (entry.shape === 'dir' || entry.shape === 'file') ? `${t.entry.shape}:${realpathOr(t.abs)}:${entry.pattern || ''}` : realpathOr(t.abs);
      if (!groups.has(key)) groups.set(key, { ...t, entries: [] });
      else if (groups.get(key).display !== t.display) plan.skipped.push({ path: t.display, reason: `same file as ${groups.get(key).display}` });
      groups.get(key).entries.push(entry);
    }
  }

  if (plan.row) {
    for (const g of groups.values()) {
      const shape = g.entry.shape;
      if (shape === 'dir' || shape === 'file') {
        planMove(plan, g, ctx, handled);
        continue;
      }
      const real = realpathOr(g.abs);
      let text;
      try { text = fs.readFileSync(g.abs, 'utf8'); } catch (e) { plan.skipped.push({ path: g.display, reason: `unreadable: ${e.message}` }); continue; }
      const rewritable = g.entries.filter((e) => e.rewrite !== false);
      if (!rewritable.length) {
        if (text.includes(oldId)) {
          const gen = g.entries.find((e) => e.generated);
          plan.skipped.push({ path: g.display, reason: `mentions ${oldId} but is never rewritten — ${g.entries[0].note || 'registry says rewrite:false'}${gen ? ` (regenerate: ${gen.generated})` : ''}`, regenerate: gen ? gen.generated : null });
        }
        handled.add(real);
        continue;
      }
      if (!text.includes(oldId) && !(ctx.slugChanged && text.includes(ctx.oldSlug))) { plan.skipped.push({ path: g.display, reason: 'no occurrences' }); handled.add(real); continue; }
      let result;
      try { result = rewriteText(text, rewritable, ctx); } catch (e) {
        if (e.code === 'KEY_COLLISION') refuse(`${g.display}: ${e.message}`);
        else plan.skipped.push({ path: g.display, reason: `unparseable: ${e.message}` });
        handled.add(real);
        continue;
      }
      handled.add(real);
      if (!result.edits.length) {
        if (result.residual.total) plan.residual.push({ path: g.display, abs: g.abs, hits: result.residual.hits, total: result.residual.total, registered: true });
        plan.skipped.push({ path: g.display, reason: 'no occurrences' });
        continue;
      }
      const guardEntry = g.entries.find((e) => e.writeGuard && e.writeGuard !== 'atomic');
      const change = {
        kind: 'rewrite', repo: g.entry.repo, path: g.display, abs: g.abs, realpath: real, viaMirror: g.viaMirror,
        writeGuard: guardEntry ? guardEntry.writeGuard : 'atomic',
        entries: rewritable.map((e) => ({ shape: e.shape, keyPath: e.keyPath, keyedBy: e.keyedBy || 'id' })),
        entryIndexes: rewritable.map((e) => SHOW_ID_KEYED_FILES.indexOf(e)),
        edits: result.edits, counts: countEdits(result.edits),
        generated: (g.entries.find((e) => e.generated) || {}).generated || null,
      };
      if (real === realpathOr(plan.showsPath)) {
        change.isShowsJson = true;
        change.aliases = plan.aliases;
        change.edits.push({ op: 'set-aliases', at: `shows[id=${newId}].aliases`, from: JSON.stringify(Array.isArray(plan.row.aliases) ? plan.row.aliases : []), to: JSON.stringify(plan.aliases) });
      }
      plan.changes.push(change);
      if (result.residual.total) plan.residual.push({ path: g.display, abs: g.abs, hits: result.residual.hits, total: result.residual.total, registered: true });
    }
    // shows.json first: it is the source of truth and the resume marker.
    plan.changes.sort((a, b) => (b.isShowsJson ? 1 : 0) - (a.isShowsJson ? 1 : 0));
  }

  // Residual scan: everything else under the trees that still mentions the old id.
  const roots = [
    { root: path.join(trees.web, 'data'), label: 'web' },
    { root: path.join(trees.web, 'public', 'data'), label: 'web' },
    { root: trees.coreData, label: 'core-data' },
    { root: trees.reviewTexts, label: 'review-texts' },
  ];
  // display paths for the two web roots are relative to the root we scanned;
  // prefix them so they read as repo-relative.
  const residualRaw = [];
  for (const r of roots) {
    if (!r.root) continue;
    for (const hit of scanResidual([r], oldId, handled)) {
      const rel = hit.path.slice(r.label.length + 1);
      const prefix = r.label === 'web' ? path.relative(trees.web, r.root) + '/' : '';
      residualRaw.push({ ...hit, path: `${r.label}:${prefix}${rel}`, registered: false });
    }
  }
  plan.residual.push(...residualRaw);
  plan.codeRefs = treesIn.scanCode === false ? [] : scanCodeRefs(trees.web, oldId);
  plan.sql = buildSqlMigration(oldId, newId);

  plan.summary = {
    filesRewritten: plan.changes.length,
    keysRenamed: plan.changes.reduce((n, c) => n + c.counts.keys, 0),
    fieldsSet: plan.changes.reduce((n, c) => n + c.counts.fields, 0),
    refsRewritten: plan.changes.reduce((n, c) => n + c.counts.refs + c.counts.paths, 0),
    dirsMoved: plan.moves.filter((m) => m.isDir).length,
    filesMoved: plan.moves.filter((m) => !m.isDir).length,
    innerFilesRewritten: plan.moves.reduce((n, m) => n + m.inner.filter((i) => i.edits.length).length, 0),
    residualFiles: plan.residual.length,
    codeRefs: plan.codeRefs.length,
    refusals: plan.refusals.length,
  };
  return plan;
}

function planMove(plan, g, ctx, handled) {
  const entry = g.entry;
  const { oldName, newName, isGlob } = idPaths(entry, ctx);
  const matches = listMatching(g.abs, oldName, isGlob);
  const disp = (n) => (g.display.endsWith(':') ? `${g.display}${n}` : `${g.display}/${n}`);
  if (!matches.length) { plan.skipped.push({ path: disp(oldName), reason: 'not present' }); return; }
  for (const name of matches) {
    const from = path.join(g.abs, name);
    const toName = isGlob ? name.replace(ctx.oldId, ctx.newId) : newName;
    const to = path.join(g.abs, toName);
    if (exists(to)) { plan.refusals.push(`${disp(toName)} already exists — cannot move ${name} onto it`); plan.ok = false; }
    const rel = path.relative(g.root, from);
    const isDirMove = isDir(from);
    const tracked = gitTracked(g.root, rel);
    const inner = [];
    for (const f of innerJsonFiles(from)) {
      const real = realpathOr(f);
      handled.add(real);
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (!text.includes(ctx.oldId)) continue;
      let result;
      try { result = rewriteText(text, [], ctx, { jsonl: f.endsWith('.jsonl') }); } catch { inner.push({ abs: f, rel: path.relative(from, f) || path.basename(f), edits: [], unparseable: true }); continue; }
      const item = { abs: f, rel: path.relative(from, f) || path.basename(f), edits: result.edits, counts: countEdits(result.edits), jsonl: f.endsWith('.jsonl') };
      let locked = false;
      if (entry.writeGuard === 'review' && result.doc && result.doc._locked === true) locked = true;
      if (locked) item.locked = true;
      inner.push(item);
      if (result.residual.total) plan.residual.push({ path: `${disp(toName)}${isDirMove ? `/${item.rel}` : ''}`, abs: f, hits: result.residual.hits, total: result.residual.total, registered: true });
    }
    plan.moves.push({
      kind: 'move', repo: entry.repo, root: g.root, path: disp(name), from, to, toPath: disp(toName),
      relFrom: rel, relTo: path.relative(g.root, to), isDir: isDirMove, method: tracked ? 'git mv' : 'rename',
      writeGuard: entry.writeGuard || 'atomic', inner, generated: entry.generated || null,
    });
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function writeThroughGuard(change, doc, originalText) {
  const guard = change.writeGuard;
  if (guard === 'shows') {
    // Fresh object (no loadShows snapshot) so the guard writes the document
    // as-is under its lock + atomic write + shrink gate — its merge-by-id
    // would otherwise move the renamed row to the end of the array.
    const { createShowsWriteGuard } = require('./shows-write-guard');
    createShowsWriteGuard(change.abs).saveShows(doc);
    return 'shows-write-guard';
  }
  if (guard === 'commercial') {
    const { createCommercialWriteGuard } = require('./commercial-write-guard');
    createCommercialWriteGuard(change.abs).saveCommercial(doc);
    return 'commercial-write-guard';
  }
  if (guard === 'audience-buzz') {
    const { createAudienceBuzzWriteGuard } = require('./audience-buzz-write-guard');
    createAudienceBuzzWriteGuard(change.abs).saveAudienceBuzz(doc);
    return 'audience-buzz-write-guard';
  }
  atomicWriteText(change.abs, serializeJson(doc, detectJsonFormat(originalText)));
  return 'atomic';
}

function moveTree(move) {
  if (move.method === 'git mv') {
    execFileSync('git', ['-C', move.root, 'mv', '--', move.relFrom, move.relTo], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    fs.mkdirSync(path.dirname(move.to), { recursive: true });
    fs.renameSync(move.from, move.to);
  }
}

/**
 * Execute a plan. Throws when the plan is not ok. Re-reads every file at
 * write time (the plan is a preview, not a snapshot to replay).
 * @param {object} plan  from planShowIdRename
 * @param {{log?: (line: string) => void}} [opts]
 * @returns {{ rewritten: string[], moved: string[], innerRewritten: string[], warnings: string[] }}
 */
function applyShowIdRename(plan, opts = {}) {
  if (!plan || !plan.ok) throw new Error(`refusing to apply: ${(plan && plan.refusals.join('; ')) || 'no plan'}`);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const ctx = { oldId: plan.oldId, newId: plan.newId, oldSlug: plan.oldSlug, newSlug: plan.newSlug, slugChanged: plan.slugChanged };
  const out = { rewritten: [], moved: [], innerRewritten: [], warnings: [] };

  // 1. JSON rewrites (shows.json first — see plan ordering).
  for (const change of plan.changes) {
    const text = fs.readFileSync(change.abs, 'utf8');
    const entries = change.entryIndexes.map((i) => SHOW_ID_KEYED_FILES[i]);
    const result = rewriteText(text, entries, ctx);
    if (change.isShowsJson) {
      const row = result.doc.shows.find((s) => s && s.id === plan.newId);
      if (!row) throw new Error(`${change.path}: renamed row ${plan.newId} not found after rewrite`);
      row.aliases = plan.aliases;
      result.edits.push({ op: 'set-aliases', at: `shows[id=${plan.newId}].aliases` });
    }
    if (!result.edits.length) { out.warnings.push(`${change.path}: nothing to change at apply time (already applied?)`); continue; }
    if (result.edits.length !== change.edits.length) out.warnings.push(`${change.path}: ${result.edits.length} edits at apply time vs ${change.edits.length} planned (file changed since the plan)`);
    const via = writeThroughGuard(change, result.doc, text);
    out.rewritten.push(change.path);
    log(`rewrote ${change.path} (${result.edits.length} edits via ${via})`);
  }

  // 2. Moves (git mv when tracked, rename otherwise).
  for (const move of plan.moves) {
    if (!exists(move.from)) {
      if (exists(move.to)) { out.warnings.push(`${move.path}: already moved to ${move.toPath}`); }
      else out.warnings.push(`${move.path}: source vanished since the plan`);
    } else {
      if (exists(move.to)) throw new Error(`${move.toPath} appeared since the plan — refusing to overwrite`);
      moveTree(move);
      out.moved.push(`${move.path} -> ${move.toPath} (${move.method})`);
      log(`${move.method}: ${move.path} -> ${move.toPath}`);
    }
    // 3. Inner re-stamp of the moved JSON files.
    for (const item of move.inner) {
      if (item.unparseable) { out.warnings.push(`${move.toPath}/${item.rel}: unparseable, showId not re-stamped`); continue; }
      const abs = path.join(move.to, path.relative(move.from, item.abs));
      const target = isFile(abs) ? abs : (isFile(move.to) ? move.to : null);
      if (!target) { out.warnings.push(`${move.toPath}/${item.rel}: missing after move`); continue; }
      const text = fs.readFileSync(target, 'utf8');
      const result = rewriteText(text, [], ctx, { jsonl: item.jsonl });
      if (!result.edits.length) continue;
      if (item.jsonl) {
        atomicWriteText(target, result.text);
      } else if (move.writeGuard === 'review') {
        const { safeWriteReview } = require('./review-write-guard');
        // force: the on-disk content is written back verbatim except for
        // the id fields, so nothing protected can be lost, and a `_locked`
        // file must still get its showId re-stamped (rebuild groups by
        // showId — a stale one would file the review under the old id).
        const r = safeWriteReview(target, result.doc, { force: true });
        if (!r.wrote) { out.warnings.push(`${move.toPath}/${item.rel}: safeWriteReview skipped (${r.skipped || 'unknown'})`); continue; }
      } else {
        atomicWriteText(target, serializeJson(result.doc, detectJsonFormat(text)));
      }
      out.innerRewritten.push(`${move.toPath}/${item.rel}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// text rendering for the CLI
// ---------------------------------------------------------------------------

function formatPlan(plan, { verbose = false, maxEdits = 6 } = {}) {
  const L = [];
  const t = plan.trees;
  L.push(`rename show id: ${plan.oldId} -> ${plan.newId}${plan.resume ? '  (RESUMING a partial apply: shows.json already renamed)' : ''}`);
  L.push(`  web:          ${t.web}`);
  L.push(`  core-data:    ${t.coreData || '(not given — core files reached through the web checkout\'s data/ mirror)'}`);
  L.push(`  review-texts: ${t.reviewTexts ? t.reviewTexts + (t.reviewTextsVia ? ` (via ${t.reviewTextsVia})` : '') : '(not given — review-texts entries skipped)'}`);
  if (plan.showsPath) L.push(`  shows.json:   ${plan.showsPath}${realpathOr(plan.showsPath) !== plan.showsPath ? ` -> ${realpathOr(plan.showsPath)}` : ''}`);
  if (plan.row) {
    L.push(`  row:          ${plan.row.title || '?'} @ ${plan.row.venue || '?'} (opens ${plan.row.openingDate || '?'})`);
    L.push(`  slug:         ${plan.oldSlug}${plan.slugChanged ? ` -> ${plan.newSlug}` : ' (unchanged; slug-keyed files untouched)'}`);
    L.push(`  aliases:      ${JSON.stringify(plan.aliases)}`);
  }
  if (plan.refusals.length) {
    L.push('');
    L.push(`REFUSED (${plan.refusals.length}):`);
    for (const r of plan.refusals) L.push(`  - ${r}`);
  }
  if (plan.changes.length) {
    L.push('');
    L.push(`JSON rewrites (${plan.changes.length} files):`);
    for (const c of plan.changes) {
      const parts = [];
      if (c.counts.keys) parts.push(`${c.counts.keys} key${c.counts.keys === 1 ? '' : 's'}`);
      if (c.counts.fields) parts.push(`${c.counts.fields} id field${c.counts.fields === 1 ? '' : 's'}`);
      if (c.counts.refs) parts.push(`${c.counts.refs} ref${c.counts.refs === 1 ? '' : 's'}`);
      if (c.counts.paths) parts.push(`${c.counts.paths} path${c.counts.paths === 1 ? '' : 's'}`);
      if (c.isShowsJson) parts.push('aliases');
      L.push(`  ${c.path}  [${c.writeGuard}]  ${parts.join(', ')}${c.generated ? `  (build output: ${c.generated})` : ''}`);
      const shown = verbose ? c.edits : c.edits.slice(0, maxEdits);
      for (const e of shown) L.push(`      ${e.op} ${e.at}${e.from !== undefined && e.op !== 'set-aliases' ? `: ${e.from} -> ${e.to}` : (e.op === 'set-aliases' ? `: ${e.to}` : '')}`);
      if (!verbose && c.edits.length > maxEdits) L.push(`      … +${c.edits.length - maxEdits} more`);
    }
  }
  if (plan.moves.length) {
    L.push('');
    L.push(`moves (${plan.moves.length}):`);
    for (const m of plan.moves) {
      const restamped = m.inner.filter((i) => i.edits.length).length;
      const locked = m.inner.filter((i) => i.locked).length;
      L.push(`  ${m.method}: ${m.path} -> ${path.basename(m.to)}${m.isDir ? '/' : ''}${restamped ? `  (${restamped} inner file${restamped === 1 ? '' : 's'} re-stamped via ${m.writeGuard === 'review' ? 'safeWriteReview' : 'atomic write'}${locked ? `, ${locked} _locked` : ''})` : ''}`);
      if (verbose) for (const i of m.inner) if (i.edits.length) L.push(`      ${i.rel}: ${i.edits.map((e) => e.at).join(', ')}`);
    }
  }
  const regen = plan.skipped.filter((s) => s.regenerate);
  if (regen.length) {
    L.push('');
    L.push('regenerate (not rewritten):');
    for (const s of regen) L.push(`  ${s.path}: ${s.regenerate}`);
  }
  const otherSkips = plan.skipped.filter((s) => !s.regenerate && s.reason !== 'no occurrences' && s.reason !== 'not present' && s.reason !== 'file missing');
  if (verbose && otherSkips.length) {
    L.push('');
    L.push('skipped:');
    for (const s of otherSkips) L.push(`  ${s.path}: ${s.reason}`);
  }
  if (plan.residual.length) {
    // data/audit/ holds dated report snapshots (opening-night-latency-*.json,
    // daily-snapshot.json, …) that legitimately record the id as it was on
    // that day; collapse them to one line unless --verbose.
    const isAudit = (r) => /^web:data\/audit\//.test(r.path);
    const audit = verbose ? [] : plan.residual.filter(isAudit);
    const rest = verbose ? plan.residual : plan.residual.filter((r) => !isAudit(r));
    L.push('');
    L.push(`still mentions ${plan.oldId} after the rename (${plan.residual.length} files — free text, foreign paths, unregistered keys or dated audit snapshots; review by hand):`);
    for (const r of rest) {
      L.push(`  ${r.path}  (${r.total} mention${r.total === 1 ? '' : 's'})`);
      for (const h of r.hits.slice(0, verbose ? r.hits.length : 3)) L.push(`      ${h.kind} ${h.at}${h.value ? `: ${h.value}` : ''}`);
    }
    if (audit.length) {
      const families = new Map();
      for (const r of audit) {
        const name = r.path.replace(/^web:data\/audit\//, '').replace(/\d{4}-\d{2}-\d{2}/g, '*');
        families.set(name, (families.get(name) || 0) + 1);
      }
      L.push(`  web:data/audit/ — ${audit.length} dated audit snapshot${audit.length === 1 ? '' : 's'} (${[...families].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ')}); --verbose lists them`);
    }
  }
  if (plan.codeRefs.length) {
    L.push('');
    L.push(`source files hard-coding ${plan.oldId} (edit by hand):`);
    for (const f of plan.codeRefs) L.push(`  ${f}`);
  }
  if (plan.summary) {
    L.push('');
    const s = plan.summary;
    L.push(`summary: ${s.filesRewritten} files rewritten (${s.keysRenamed} keys, ${s.fieldsSet} id fields, ${s.refsRewritten} refs/paths), ${s.dirsMoved} dirs + ${s.filesMoved} files moved, ${s.innerFilesRewritten} inner files re-stamped, ${s.residualFiles} files with residual mentions, ${s.codeRefs} code refs, ${s.refusals} refusals`);
  }
  return L.join('\n');
}

module.exports = {
  planShowIdRename,
  applyShowIdRename,
  buildSqlMigration,
  formatPlan,
  resolveTrees,
  // exported for tests / other tools
  rewriteText,
  applyShape,
  genericPass,
  findMentions,
  detectJsonFormat,
  serializeJson,
  yearlessSlug,
  SUPABASE_SHOW_ID_TABLES,
  SUPABASE_JSONB_SHOW_ID_COLUMNS,
  SUPABASE_SHOW_ID_LOOKALIKES,
  SUPABASE_UNVERIFIED_TABLES,
  ID_RE,
};
