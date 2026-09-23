'use strict';

/**
 * headless-wrapup-block — BRO-4064. A headless job's `res.resultText` (the
 * CLI's final printed message) is now plain English and no longer carries a
 * `THIS SESSION:` line (see headless-result-classifier.js's header for the
 * full story). The session DOES still record the real verdict, via
 * `wrapup-block --file <path>` (a Bash tool call whose tool_result is
 * wrapped in `WRAPUP-BLOCK RECORDED v1 ... WRAPUP-BLOCK END` and validated at
 * write time to end in a canonical `THIS SESSION: KEEP OPEN|CLOSE ME|IDLE —
 * <reason>` line) — that record just doesn't reach `res.resultText`, because
 * it lives in the session's own transcript file, not the CLI's stdout.
 *
 * This module finds that transcript and extracts the block, reusing
 * ~/.claude/hooks/lib/wrapup_block.py's `--find <transcript>` CLI rather than
 * reimplementing its scan (second-opinion review, BRO-4064 plan review,
 * 2026-09-23): that scanner already absorbed several adversarial-review
 * fixes for exactly this class of bug (sidechain filtering, staleness when
 * ANY tool call follows the wrapup-block call, a resumed session's stale
 * prior-attempt block) — a from-scratch port risked silently missing one.
 * `--find` exits 0 with `<reason>\n<block>\n` on stdout when a fresh block is
 * found, or 1 with just `<reason>\n` when it is absent/stale.
 *
 * `sessionTranscriptPath` computes the one path fact bsc-runner.js actually
 * has that a Stop hook never needs to derive (a Stop hook receives
 * `transcript_path` directly in its stdin JSON): Claude Code encodes a
 * session's cwd into its project directory name by replacing every
 * individual non-alphanumeric character with '-' (NOT collapsing runs — a
 * cwd containing "/.claude/" encodes to a literal double dash, "--claude").
 * Verified against real transcript directories on disk for this exact
 * worktree and a completed BRO-3925 job worktree; there is no public API for
 * this encoding, so this function is the one place it needs to be right.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyHeadlessResult } = require('./headless-result-classifier.js');

const WRAPUP_BLOCK_PY = path.join(os.homedir(), '.claude', 'hooks', 'lib', 'wrapup_block.py');

function sessionTranscriptPath(cwd, sessionId) {
  const encoded = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

/**
 * I/O: locate a headless job's own recorded wrapup-block, if a fresh one
 * exists. Never throws — a missing transcript, missing python3, or missing
 * wrapup_block.py all degrade to "no block found" so callers fall back to
 * classifying `resultText` (today's behavior), never crash the job runner.
 * @param {{cwd: string, sessionId: string}} opts
 * @returns {{block: string|null, reason: string}}
 */
function findRecordedWrapupBlock({ cwd, sessionId } = {}) {
  if (!cwd || !sessionId) return { block: null, reason: 'missing cwd or sessionId' };
  // Same kill switch wrapup_block.py's own --merge path honors (ship-check
  // finding, Codex adversarial review, 2026-09-23): without this, disabling
  // wrapup-block recording fleet-wide via WRAPUP_BLOCK_DISABLED=1 would stop
  // NEW blocks from being written but this reader would keep trusting
  // whatever old block still happens to sit in a transcript — the rollback
  // switch wouldn't actually roll this integration back.
  if (process.env.WRAPUP_BLOCK_DISABLED === '1') return { block: null, reason: 'wrapup-block-disabled' };
  const transcriptPath = sessionTranscriptPath(cwd, sessionId);
  if (!fs.existsSync(transcriptPath)) return { block: null, reason: 'transcript-not-found' };
  if (!fs.existsSync(WRAPUP_BLOCK_PY)) return { block: null, reason: 'wrapup_block.py-not-found' };
  let res;
  try {
    res = spawnSync('python3', [WRAPUP_BLOCK_PY, '--find', transcriptPath], { encoding: 'utf8', timeout: 10000 });
  } catch (e) {
    return { block: null, reason: `spawn-failed:${e.message}` };
  }
  if (!res || res.error || typeof res.stdout !== 'string') {
    return { block: null, reason: `spawn-failed:${(res && res.error && res.error.message) || 'no-stdout'}` };
  }
  const nl = res.stdout.indexOf('\n');
  const reason = nl >= 0 ? res.stdout.slice(0, nl) : res.stdout.trim();
  if (res.status !== 0) return { block: null, reason };
  const block = nl >= 0 ? res.stdout.slice(nl + 1).replace(/\n$/, '') : '';
  return { block: block || null, reason };
}

// Substring shared by BOTH of headless-result-classifier.js's "the session
// explicitly said don't treat this as finished" reasons (legacy THIS
// SESSION: KEEP OPEN and the new plain-English "Keep this tab open") — NOT
// the generic default reason ('no THIS SESSION: status line...'), which
// fires merely because resultText's phrasing didn't match any known
// template and carries no signal either way. Used below to detect a real
// contradiction, not a resultText that simply doesn't echo the block.
const EXPLICIT_KEEP_OPEN_REASON_RE = /never resumed by a background notification/;

/**
 * Orchestrator bsc-runner.js calls in place of the bare
 * classifyHeadlessResult(res.resultText): prefer the session's own recorded
 * machine block (always canonical `THIS SESSION:` syntax) when a fresh one
 * exists, falling back to classifying `resultText` directly otherwise — so a
 * session with no wrapup-block call at all still gets exactly today's
 * behavior (plain-English-aware, per headless-result-classifier.js).
 *
 * Cross-checked against `resultText` before trusting a 'clean' block
 * (ship-check finding, Codex adversarial review, 2026-09-23): a recorded
 * `CLOSE ME` block followed by a chat message that explicitly says "Keep
 * this tab open" (or legacy `THIS SESSION: ... BLOCKED:`) is exactly the
 * contradiction ~/.claude/hooks/exit-status-gate.sh's Gate X blocks for
 * INTERACTIVE sessions — but Gate X's contradiction check only fires when
 * wrapup_block.py's `merge_stdin` merged a block into the chat text, and
 * that function explicitly skips headless jobs (`.claude/worktrees/job-`
 * cwd), so nothing gates a headless session's own contradictory turn before
 * it ends. Once this module started reading the block's content instead of
 * ignoring it (the whole point of BRO-4064), an unresolved contradiction
 * would have silently graduated a genuinely-unfinished job to 'clean'. Fails
 * toward the LESS finished verdict, same direction as every other guard in
 * this file's ancestry (headless-unlanded-detection.js's detectJobLanding,
 * etc.) — never toward crediting completion on ambiguous evidence.
 *
 * `findBlockFn` is a test seam (same idiom as bsc-runner.js's `isAliveFn`)
 * so callers can inject a canned block without a real transcript/python3.
 * @param {{resultText: string, sessionId: string|null, cwd: string|null, findBlockFn?: Function}} opts
 * @returns {{outcome: 'clean'|'blocked'|'stopped-short', reason?: string, source: 'wrapup-block'|'result-text'|'result-text-contradicts-block'}}
 */
function classifyHeadlessJobResult({ resultText, sessionId, cwd, findBlockFn = findRecordedWrapupBlock } = {}) {
  if (sessionId && cwd) {
    // findRecordedWrapupBlock itself never throws, but findBlockFn is a
    // public test seam (ship-check finding, Claude codebase review,
    // 2026-09-23) — a future caller's injected fn crashing here would lose
    // the classification (and the ledger write) for a job that already ran,
    // strictly worse than the graceful stopped-short fallback below.
    let found = null;
    try { found = findBlockFn({ sessionId, cwd }); } catch { /* fall through to resultText */ }
    if (found && found.block) {
      const fromBlock = classifyHeadlessResult(found.block);
      if (fromBlock.outcome === 'clean') {
        const fromText = classifyHeadlessResult(resultText);
        const contradicts = fromText.outcome === 'blocked'
          || (fromText.outcome === 'stopped-short' && EXPLICIT_KEEP_OPEN_REASON_RE.test(fromText.reason || ''));
        if (contradicts) return { ...fromText, source: 'result-text-contradicts-block' };
      }
      return { ...fromBlock, source: 'wrapup-block' };
    }
  }
  return { ...classifyHeadlessResult(resultText), source: 'result-text' };
}

module.exports = { sessionTranscriptPath, findRecordedWrapupBlock, classifyHeadlessJobResult, WRAPUP_BLOCK_PY };
