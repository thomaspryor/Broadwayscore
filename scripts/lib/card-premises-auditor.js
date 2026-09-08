/**
 * card-premises-auditor.js — does an armed card's `node --test`/`npx tsx
 * --test` acceptance command name a file that actually exists?
 *
 * BRO-2977: isSafeCheckCommand (autonomous-triage-core.js) only validates the
 * SHAPE of a command — never that the file it names is real — so a card
 * whose acceptance criteria hallucinated or mistyped a test path is "armed"
 * and dispatchable, and only fails at RUN time, which nothing does for a
 * still-open card. Four such cards were found by hand in one bounded run of
 * audit-stale-open-premises.js (BRO-2968): their own command can never pass,
 * so they can never reach linear-brain.js's Done gate. This module turns
 * that silent starvation into a listed defect, wired into
 * audit-card-verifiability.js's existing sweep.
 *
 * MUST resolve against origin/main, not the caller's local checkout: a
 * worktree legitimately lacks gitignored paths, and a naive fs.existsSync
 * would report those as "missing" — the same class of mistake an earlier
 * version of BRO-2968's audit made (reporting an environment artefact as a
 * live bug). `git cat-file -e origin/main:<path>` and its null-on-transient-
 * failure convention are copied from autofix-canary.js's
 * markerExistsOnOriginMain, which already solved this exact problem for a
 * different marker path (CLAUDE.md §15 — one implementation would be nicer,
 * but that function is git-fetch-coupled to a single caller's marker path
 * story; isPathAbsentFromTreeError, the actually-shared piece, IS reused
 * as-is below).
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const { extractCheckPaths } = require('./autonomous-triage-core.js');
const { repoDepthArgs } = require('./shallow-fetch-args.js');
const { isPathAbsentFromTreeError } = require('./autofix-canary.js');

const REPO = path.join(__dirname, '..', '..');

// Narrows extractCheckPaths (which also matches `test -f <docs|memory path>`
// — not a test file at all) down to the two forms whose path group names
// actual runnable *.test.mjs/*.test.js/*.test.ts files.
function isNodeTestCommand(cmd) {
  return /^(node --test|npx tsx --test)\b/.test(String(cmd || '').trim());
}

// Pure: reuses the SAME regex/path-group extraction isSafeCheckCommand
// already validated the shape of, so there is no second parser to drift.
function extractTestFilePaths(cmd) {
  if (!isNodeTestCommand(cmd)) return [];
  return extractCheckPaths(cmd);
}

/**
 * Does `relPath` exist in origin/main's tree right now?
 * @returns {boolean|null} true=present, false=CONFIRMED absent, null=could
 *   not resolve this run (fetch/git failure) — never scored as "missing".
 */
function pathExistsOnOriginMain(relPath, { repo = REPO, log = () => {} } = {}) {
  try {
    execFileSync('git', ['cat-file', '-e', `origin/main:${relPath}`], { cwd: repo, timeout: 10000, stdio: 'pipe' });
    return true;
  } catch (err) {
    if (isPathAbsentFromTreeError(err)) return false;
    log(`[card-premises-auditor] WARN could not check origin/main for ${relPath}: ${String(err.message).slice(0, 120)}`);
    return null;
  }
}

// Depth-bound the fetch (same reasoning as autofix-canary.js's
// markerExistsOnOriginMain): most CI checkouts are shallow, and an unbounded
// `git fetch origin main` from one pulls the whole repo instead of the delta.
function fetchOriginMain({ repo = REPO, log = () => {} } = {}) {
  const depthArgs = repoDepthArgs({ repoRoot: repo });
  try {
    // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
    execFileSync('git', ['fetch', ...depthArgs, '--quiet', 'origin', 'main'], { cwd: repo, timeout: 30000, stdio: 'pipe' });
    return true;
  } catch (err) {
    log(`[card-premises-auditor] WARN could not fetch origin/main: ${String(err.message).slice(0, 120)}`);
    return false;
  }
}

/**
 * Pure core: which of these armed cards name a `node --test`/`npx tsx --test`
 * file that `existsFn` reports as confirmed-missing?
 *
 * A path `existsFn` returns null for (unresolved this run) is never counted
 * as missing — same fail-open contract as the git-backed existsFn itself, so
 * a network blip can never manufacture a false "this card can never close".
 *
 * @param {Array<{id,name,url,cmd}>} cards
 * @param {(relPath:string)=>boolean|null} existsFn
 * @returns {Array<{id,name,url,cmd,missingPaths:string[]}>}
 */
function auditCardTestPaths(cards, existsFn) {
  const flagged = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const paths = extractTestFilePaths(card && card.cmd);
    if (!paths.length) continue;
    const missingPaths = paths.filter((p) => existsFn(p) === false);
    if (missingPaths.length) {
      flagged.push({ id: card.id, name: card.name, url: card.url, cmd: card.cmd, missingPaths });
    }
  }
  return flagged;
}

/**
 * I/O wrapper: fetches origin/main once, then checks every armed card's
 * `node --test` path against it. Skips the fetch entirely when no card is a
 * `node --test`-shaped candidate (cheap common case).
 *
 * A failed fetch bails out to [] rather than falling through to whatever
 * origin/main happens to be cached locally: `git cat-file -e` reads the
 * local ref regardless of whether the fetch above actually refreshed it, so
 * proceeding on a fetch failure could report a file that landed upstream
 * SINCE the last successful fetch as "confirmed missing" — the exact false
 * positive this whole module exists to avoid (adversarial review finding).
 * Same fail-open contract as autofix-canary.js's markerExistsOnOriginMain:
 * "could not resolve this run" is never scored as a defect.
 */
function findCardsWithMissingTestFiles(evaluatedCards, opts = {}) {
  const candidates = (Array.isArray(evaluatedCards) ? evaluatedCards : [])
    .filter((c) => c && c.armed && isNodeTestCommand(c.cmd));
  if (!candidates.length) return [];
  if (!fetchOriginMain(opts)) return [];
  const cache = new Map();
  const existsFn = (p) => {
    if (!cache.has(p)) cache.set(p, pathExistsOnOriginMain(p, opts));
    return cache.get(p);
  };
  return auditCardTestPaths(candidates, existsFn);
}

module.exports = {
  isNodeTestCommand,
  extractTestFilePaths,
  pathExistsOnOriginMain,
  fetchOriginMain,
  auditCardTestPaths,
  findCardsWithMissingTestFiles,
  REPO,
};
