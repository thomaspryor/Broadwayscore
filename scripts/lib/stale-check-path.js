'use strict';
/**
 * stale-check-path.js — tell a STALE acceptance check apart from a broken fix
 * before the recheck runs it (BRO-7559).
 *
 * The recheck used to report every card whose command named a path absent
 * from main as "unverifiable", the same as a timeout, and never looked again.
 * Of 26 such Done cards (2026-11-15), 9 named tests that had since landed,
 * some named a test that had moved, and the rest named tests that never
 * reached main at all. Those are three different facts about the claim, so
 * this module names them:
 *
 *   ok       every named path exists: run the command as written
 *   moved    each missing path has exactly ONE tracked file with the same
 *            basename elsewhere: the command can be re-pointed at it
 *   missing  at least one path has no file of that name anywhere on main:
 *            the check is stale (never landed, deleted, or another repo)
 *
 * Deliberately NOT inside runVerify (acceptance-check-core.js): at close time
 * a missing path means "the branch has not merged yet" and close-time-verify
 * must keep refusing on missingPath. Only the recheck, which runs on a card
 * that is already Done, calls this (second-opinion finding).
 *
 * Also: isWholeSuiteCommand. `node scripts/run-unit-tests.js` re-runs every
 * unit test (10+ min) and says nothing about one card; 7 of 8 recheck
 * timeouts were this command. It is reported as a stale check to rewrite,
 * not started and SIGTERMed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractCheckPaths, isSafeCheckCommand } = require('./check-paths.js');

const GIT_TIMEOUT_MS = 30000;

// The whole unit suite, as the card filers write it. Anchored on both ends:
// a command that names a specific test file is a card check, not this.
const WHOLE_SUITE_RE = /^\s*(?:node\s+(?:\.\/)?scripts\/run-unit-tests\.js|npm\s+(?:run\s+)?test(?::unit)?)\s*$/;

function isWholeSuiteCommand(cmd) {
  return WHOLE_SUITE_RE.test(String(cmd || ''));
}

function listTrackedFiles(cwd) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd - the fresh checkout
 * @param {string} cmd - the card's safe-form command (untrusted)
 * @param {{trackedFiles?: string[]|null, exists?: (rel:string)=>boolean}} [o] - injectable for tests
 * @returns {{kind:'ok'} | {kind:'moved', cmd:string, moves:{from:string,to:string}[]} | {kind:'missing', missing:string[], detail:string}}
 */
function resolveStaleCheck(cwd, cmd, o = {}) {
  const exists = o.exists || ((rel) => fs.existsSync(path.join(cwd, rel)));
  const missing = extractCheckPaths(cmd).filter((p) => !exists(p));
  if (!missing.length) return { kind: 'ok' };

  const tracked = o.trackedFiles !== undefined ? o.trackedFiles : listTrackedFiles(cwd);
  const moves = [];
  const unresolved = [];
  for (const p of missing) {
    const base = path.posix.basename(p);
    const candidates = (tracked || []).filter((f) => f !== p && path.posix.basename(f) === base && exists(f));
    if (candidates.length === 1) moves.push({ from: p, to: candidates[0] });
    else unresolved.push(p);
  }
  if (unresolved.length) {
    return {
      kind: 'missing',
      missing: unresolved,
      detail: `check is stale: ${unresolved.join(', ')} is not on main (no tracked file of that name). The test never landed, was deleted, or lives in another repo; this says nothing about the fix`,
    };
  }
  // Exact token swap: the check runner splits on whitespace with no quoting,
  // so a path is always one whole token. Never a substring replace.
  const fromTo = new Map(moves.flatMap((m) => [[m.from, m.to], [`./${m.from}`, m.to]]));
  const newCmd = String(cmd).trim().split(/\s+/).map((t) => (fromTo.has(t) ? fromTo.get(t) : t)).join(' ');
  if (!isSafeCheckCommand(newCmd)) {
    return { kind: 'missing', missing: moves.map((m) => m.from), detail: `check is stale: ${moves.map((m) => m.from).join(', ')} moved, but the re-pointed command failed safe-form validation` };
  }
  return { kind: 'moved', cmd: newCmd, moves };
}

/**
 * The verdict of a check that ran on a RE-POINTED path. The card never named
 * that file, so its result is about the stale check, not the claim: a pass is
 * marked staleCheck (decideAutoClose refuses to close on it) and a fail is
 * 'unverifiable' with cause 'moved-fail', never routed as a real regression.
 * @param {object} r - runVerify's result merged onto the target
 * @param {{moves:{from:string,to:string}[]}} stale - resolveStaleCheck's 'moved' result
 * @param {string} ranCmd - the re-pointed command that actually ran
 */
function applyMovedResult(r, stale, ranCmd) {
  const moved = stale.moves.map((m) => `${m.from} -> ${m.to}`).join(', ');
  const out = { ...r, staleCheck: { kind: 'moved', moves: stale.moves }, ranCmd, detail: `check is stale (moved ${moved})${r.detail ? `; ${r.detail}` : ''}` };
  if (r.status === 'fail') { out.status = 'unverifiable'; out.cause = 'moved-fail'; }
  return out;
}

module.exports = { resolveStaleCheck, isWholeSuiteCommand, applyMovedResult, listTrackedFiles, WHOLE_SUITE_RE };
