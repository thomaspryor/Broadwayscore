#!/usr/bin/env node
'use strict';
/**
 * worktree-ignored-inputs.js (BRO-8178): may a worktree's gitignored files be
 * thrown away when gc-merged-worktrees.sh removes it?
 *
 * `git worktree remove` deletes ignored files without asking, and `git status`
 * never shows them, so the GC checks them separately (worktree_inputs_safe).
 * The first cut of that check (aeb3e3da615) allowed only node_modules/.next and
 * iOS build dirs. Every bootstrapped worktree also carries setup-local-data.sh
 * output (.env symlinks, data/*.json symlinks and copies, .cache/), so on
 * 2026-11-23 it kept 56 of 56 merged worktrees ("local inputs or probe
 * unavailable") and the disk filled again.
 *
 * The rule: an ignored entry is disposable when deleting it cannot lose
 * anything that does not exist somewhere else:
 *   - a symlink (removal deletes the link, never its target),
 *   - an empty directory,
 *   - a regenerable build/cache/audit-churn path (DISPOSABLE_PATTERNS),
 *   - a setup-local-data.sh plain copy (SETUP_COPIED_DATA_FILES; the main
 *     checkout or core-data repo is authoritative), reported back by name so
 *     the GC log records what was discarded,
 *   - a regular file byte-identical to the same path in the main checkout.
 * Anything else (data/finances/, a non-empty data/review-texts/ copy that may
 * hold unpushed review edits, a differing .env, a nested repo) keeps the
 * worktree.
 *
 * Built from a census of every ignored entry in all 92 worktrees on the Mac
 * (2026-11-23), not from setup-local-data.sh alone.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// setup-local-data.sh COPY_FILES + GENERATED_FILES, plus the generated
// site-image-versions.json. The parity test keeps this in step with the script.
const SETUP_COPIED_DATA_FILES = new Set([
  'audience-buzz.json', 'audience-reviews-lbo.json', 'awards.json', 'critic-consensus.json',
  'critic-registry.json', 'grosses.json', 'grosses-history.json', 'mezzanine-productions-raw.json',
  'opening-night-sent.json', 'season-payback-history.json',
  'cast-manifest.json', 'actor-slugs.json',
  'site-image-versions.json',
]);

// Regenerable output: build caches, test output, script-written audit churn.
// Matched against the path git prints (directories end in '/').
const DISPOSABLE_PATTERNS = [
  /^node_modules\/?$/,
  /^\.next\/$/,
  /^ios\/$/, // Expo CNG output in the app repo (only reached when git says it is ignored)
  /^ios\/(build|Pods)\/$/,
  /^\.expo\/$/,
  /^dist\/$/,
  /^(test-results|playwright-report)\/$/,
  /^\.claude\/visual-qa\/$/,
  /(^|\/)\.cache\/$/,
  /(^|\/)__pycache__\/$/,
  /^(tsconfig\.tsbuildinfo|next-env\.d\.ts|expo-env\.d\.ts)$/,
  /^data\/audit\/[^/].*[^/]$/, // ignored audit ledgers/logs (same class is_safe_dirty allows)
];

/**
 * Pure verdict for one entry.
 * @param {string} entry path as printed by `git ls-files --others --ignored --directory`
 * @param {{isSymlink?:boolean, isEmptyDir?:boolean, identicalToMain?:boolean}} facts
 * @returns {'symlink'|'empty-dir'|'disposable'|'setup-copy'|'identical-to-main'|null} null = must keep
 */
function classifyIgnoredEntry(entry, facts = {}) {
  const e = String(entry || '');
  if (!e) return 'disposable';
  if (facts.isSymlink) return 'symlink';
  if (facts.isEmptyDir) return 'empty-dir';
  if (DISPOSABLE_PATTERNS.some((re) => re.test(e))) return 'disposable';
  const m = /^data\/([^/]+)$/.exec(e);
  if (m && SETUP_COPIED_DATA_FILES.has(m[1])) return 'setup-copy';
  if (facts.identicalToMain) return 'identical-to-main';
  return null;
}

/** Pure: fold a list of {entry, facts} into one decision. */
function decideIgnoredInputs(items) {
  const discardedCopies = [];
  for (const { entry, facts } of items) {
    const kind = classifyIgnoredEntry(entry, facts);
    if (kind === null) return { safe: false, blocker: entry, discardedCopies };
    if (kind === 'setup-copy') discardedCopies.push(entry);
  }
  return { safe: true, blocker: null, discardedCopies };
}

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

/** I/O: gather facts for each ignored entry of worktree `wt`. */
function gatherIgnoredInputs(wt, mainCheckout) {
  const out = execFileSync('git', ['--no-optional-locks', '-C', wt, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean).map((entry) => {
    const abs = path.join(wt, entry.replace(/\/$/, ''));
    const facts = {};
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* vanished: treat as nothing to lose */ }
    if (!st) return { entry: '', facts };
    facts.isSymlink = st.isSymbolicLink();
    if (st.isDirectory()) {
      try { facts.isEmptyDir = fs.readdirSync(abs).length === 0; } catch { facts.isEmptyDir = false; }
    } else if (st.isFile() && mainCheckout) {
      facts.identicalToMain = sameBytes(abs, path.join(mainCheckout, entry));
    }
    return { entry, facts };
  });
}

function main(argv) {
  const get = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; };
  const wt = get('worktree');
  const mainCheckout = get('main');
  if (!wt) { console.error('usage: worktree-ignored-inputs.js --worktree=<path> [--main=<main checkout>]'); return 2; }
  let items;
  try { items = gatherIgnoredInputs(wt, mainCheckout); } catch (err) {
    console.error(`probe failed: ${String(err.message).split('\n')[0]}`);
    return 1;
  }
  const r = decideIgnoredInputs(items);
  // Exit 0 for BOTH verdicts so gc_probe (which drops output on a nonzero
  // exit) passes the keep reason through; nonzero means the probe failed.
  if (!r.safe) { console.log(`keeps: ${r.blocker}`); return 0; }
  console.log(r.discardedCopies.length ? `discards setup copies: ${r.discardedCopies.join(' ')}` : 'ok');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { classifyIgnoredEntry, decideIgnoredInputs, gatherIgnoredInputs, SETUP_COPIED_DATA_FILES, DISPOSABLE_PATTERNS };
