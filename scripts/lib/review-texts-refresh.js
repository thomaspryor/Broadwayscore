#!/usr/bin/env node
// BRO-5400: should cloud-bootstrap-data.sh (re)copy data/review-texts from the
// session-attached broadway-review-texts clone?
//
// The bootstrap used to copy only when data/review-texts was empty, so a copy baked
// into an earlier session or container snapshot was never replaced: audits read
// reviews days old while the attached clone was current (BRO-5386 refused 8 of 17
// plan actions as "Source not found"). setup-local-data.sh already stamps the copy
// with the commit it came from (.review-texts-sha, BRO-5892); compare that stamp
// with the commit a fresh copy would take and re-copy when they differ, the same
// way cloud_core_copies() compares data/.core-data-sha for core data.
//
// CLI (used by cloud-bootstrap-data.sh):
//   node scripts/lib/review-texts-refresh.js decide <data/review-texts> <clone> [event]
//     prints "copy <reason>" or "keep <reason>"; always exits 0.
//   node scripts/lib/review-texts-refresh.js check <data/review-texts> <clone>
//     prints a STALE warning line when the copy is behind the clone; exits 0.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SHA_FILE = '.review-texts-sha';

/**
 * The commit setup-local-data.sh copies from REVIEW_TEXTS_SOURCE: its origin/main,
 * else HEAD. Must match that script exactly, or every session start re-copies.
 */
function sourceSha(cloneDir) {
  for (const args of [['rev-parse', '-q', '--verify', 'refs/remotes/origin/main'], ['rev-parse', 'HEAD']]) {
    try {
      const out = execFileSync('git', ['-C', cloneDir, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) return out;
    } catch { /* try the next ref */ }
  }
  return '';
}

/** Facts about data/review-texts the decision needs. Never throws. */
function copyFacts(rtDir) {
  const facts = { present: false, isLink: false, isCheckout: false, copySha: '' };
  try { facts.isLink = fs.lstatSync(rtDir).isSymbolicLink(); } catch { return facts; }
  try { facts.present = fs.readdirSync(rtDir).some((e) => !e.startsWith('.')); } catch { /* dangling link */ }
  facts.isCheckout = fs.existsSync(path.join(rtDir, '.git'));
  try { facts.copySha = fs.readFileSync(path.join(rtDir, SHA_FILE), 'utf8').trim(); } catch { /* unstamped */ }
  return facts;
}

/**
 * Pure decision. Returns { action: 'copy'|'keep', reason }.
 * - empty/missing            -> copy (the original behaviour)
 * - a link or a git checkout -> keep (worktree link, or a real clone: never copy over it)
 * - compact/clear            -> keep (do not swap the tree under a running session)
 * - no source sha            -> keep (cannot tell; never re-copy blind)
 * - unstamped or other sha   -> copy
 */
function decideRefresh({ present, isLink, isCheckout, copySha, wantSha, event = 'startup' }) {
  if (!present) return { action: 'copy', reason: 'data/review-texts is missing or empty' };
  if (isLink) return { action: 'keep', reason: 'data/review-texts is a link' };
  if (isCheckout) return { action: 'keep', reason: 'data/review-texts is a git checkout' };
  if (event === 'compact' || event === 'clear') return { action: 'keep', reason: `session ${event} keeps the session copy` };
  if (!wantSha) return { action: 'keep', reason: 'cannot read the clone commit' };
  if (!copySha || copySha === 'unknown') return { action: 'copy', reason: 'data/review-texts is unstamped (no .review-texts-sha)' };
  if (copySha !== wantSha) return { action: 'copy', reason: `data/review-texts at ${copySha.slice(0, 9)}, clone at ${wantSha.slice(0, 9)}` };
  return { action: 'keep', reason: `data/review-texts current at ${copySha.slice(0, 9)}` };
}

/** One warning line when a plain copy is behind the clone, else ''. */
function staleWarning(facts, wantSha) {
  if (!facts.present || facts.isLink || facts.isCheckout || !wantSha) return '';
  if (facts.copySha === wantSha) return '';
  const at = facts.copySha && facts.copySha !== 'unknown' ? facts.copySha.slice(0, 9) : 'an unstamped commit';
  return `WARN: STALE review texts: data/review-texts is at ${at}, the attached clone at ${wantSha.slice(0, 9)}. `
    + 'Scripts reading data/review-texts see old reviews; re-run REVIEW_TEXTS_SOURCE=<clone> scripts/setup-local-data.sh --all (BRO-5400).';
}

module.exports = { decideRefresh, copyFacts, sourceSha, staleWarning, SHA_FILE };

if (require.main === module) {
  const [cmd, rtDir, cloneDir, event] = process.argv.slice(2);
  try {
    const facts = copyFacts(rtDir);
    const wantSha = sourceSha(cloneDir);
    if (cmd === 'decide') {
      const d = decideRefresh({ ...facts, wantSha, event: event || 'startup' });
      console.log(`${d.action} ${d.reason}`);
    } else if (cmd === 'check') {
      const w = staleWarning(facts, wantSha);
      if (w) console.log(w);
    } else {
      console.error('usage: review-texts-refresh.js decide|check <data/review-texts> <clone> [event]');
    }
  } catch (e) {
    // Session start must never block. The shell handles the empty case itself,
    // so "keep" here falls back to the old empty-only rule.
    if (cmd === 'decide') console.log(`keep decision failed: ${e.message}`);
  }
  process.exit(0);
}
