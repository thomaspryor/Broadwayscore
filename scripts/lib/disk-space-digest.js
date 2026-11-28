'use strict';
/**
 * Pure 'Infra: disk space' digest-row logic, moved out of health-check.js
 * (BRO-6430) so send-morning-digest.js can evaluate THIS Mac's disk without
 * requiring health-check.js — that pulls npm packages, and the digest's CI
 * twin (morning-digest-action.yml) runs without npm ci. health-check.js
 * re-exports both functions unchanged.
 */

// Free disk on the machine that runs the local automation (2026-08-09).
//
// WHY THIS EXISTS: disk was NOT a monitored signal anywhere. On 2026-08-09 the
// volume sat at 100% (2.0Gi free of 460Gi) and nothing warned — there was no
// digest row, so it could not warn, escalate or page. The only disk logic in the
// repo was scripts/lib/disk-floor-check.sh, which reacts at MERGE time (too late)
// and only as a WARN line inside merge output nobody reads. Every merge that day
// burned minutes on an emergency GC; one took ~25 minutes.
//
// Thresholds are absolute GB, not percentages: what breaks is an operation
// needing N spare GB (a git merge, a next build, a Playwright install), and that
// need does not scale with volume size. 20GB warn gives days of headroom at the
// observed fill rate; 10GB error is roughly two merges from the 5GB floor that
// merge-worktree-to-main.sh already refuses to run under.
function diskSpaceResults(free, total) {
  const NAME = 'Infra: disk space';
  // UNPARSEABLE and ZERO must not share a branch (code-review finding, 2026-08-09).
  // Folding `free <= 0` in here meant a volume so full that `df -h` rounds Avail
  // to 0 — precisely the incident this row exists for — reported as a parse-failure
  // WARN instead of an ERROR. Only a non-finite reading is a parse failure; 0 is a
  // real, and maximally bad, measurement. Negative is impossible from df, so treat
  // it as unparseable.
  if (!Number.isFinite(free) || free < 0) {
    return [{
      name: NAME,
      status: 'warn',
      message: 'Could not read free disk space',
      hint: 'df parsing failed — check the df output shape on this machine.',
    }];
  }
  const pct = Number.isFinite(total) && total > 0 ? Math.round((1 - free / total) * 100) : null;
  const where = `${free}GB free${pct === null ? '' : ` (${pct}% used)`}`;
  if (free < 10) {
    return [{
      name: NAME,
      status: 'error',
      message: `${where} — below the 10GB floor; merges and builds will start failing`,
      hint: 'Reclaim now: git worktree list, drain finished worktrees (gc-merged-worktrees.sh), clear ~/Library/Developer/Xcode/DerivedData and node_modules/.next in stale worktrees.',
    }];
  }
  if (free < 20) {
    return [{
      name: NAME,
      status: 'warn',
      message: `${where} — under 20GB; merge-worktree-to-main.sh starts paying an emergency GC below 5GB`,
      hint: 'Drain finished worktrees before this reaches the floor — the usual source is abandoned dispatch worktrees holding unfinished work.',
    }];
  }
  return [{ name: NAME, status: 'ok', message: where }];
}

// Read free/total GB for the volume holding the repo. Pure `df` parse so it is
// testable; returns NaN on anything unexpected rather than guessing.
function readDiskSpace(dfOutput) {
  const line = String(dfOutput || '').trim().split('\n').pop() || '';
  const cols = line.split(/\s+/);
  const toGB = (v) => {
    const m = /^([\d.]+)([BKMGTPi]*)$/.exec(v || '');
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    const unit = m[2].replace(/i$/, '');
    // 'B' (bytes) is included because a genuinely full volume prints Avail as
    // "0B" / "0Bi" — dropping it would send the worst possible reading down the
    // unparseable path (code-review finding, 2026-08-09). A bare number stays
    // NaN on purpose: this parser is only ever fed `df -h`, which always emits a
    // suffix, so a unitless value means the output is not what we think it is and
    // guessing the unit would risk reporting a full disk as healthy.
    const mult = { B: 1 / 1024 / 1024 / 1024, K: 1 / 1024 / 1024, M: 1 / 1024, G: 1, T: 1024, P: 1024 * 1024 }[unit];
    return mult === undefined ? NaN : Math.round(n * mult);
  };
  // df -h layout: Filesystem Size Used Avail Capacity ... Mounted
  return { total: toGB(cols[1]), free: toGB(cols[3]) };
}

// BRO-8179: /private/tmp growth on this Mac. Test suites and session clones
// leaked ~200k entries / ~20GB a day there (macOS clears it only at reboot)
// until reap-stale-tmp.js ran hourly; on 2026-11-23 it held 384k entries /
// 40GB. The reaper keeps it to roughly a day of inflow, so these thresholds
// fire when the reaper stops running or inflow jumps, well before the disk
// floor. gb may be NaN (du timed out on a huge tree): judged on count alone.
function tmpSpaceResults(count, gb) {
  const NAME = 'Infra: /private/tmp';
  if (!Number.isFinite(count) || count < 0) {
    return [{ name: NAME, status: 'warn', message: 'Could not read /private/tmp', hint: 'ls /private/tmp failed on this Mac.' }];
  }
  const where = `${count.toLocaleString('en-US')} items${Number.isFinite(gb) ? `, ${gb}GB` : ', size unknown (du timed out)'}`;
  const hint = 'Check the hourly reaper ran: grep STALE-TMP-REAP data/audit/worktree-gc.log | tail -3; run node scripts/lib/reap-stale-tmp.js by hand.';
  if (count > 150000 || gb > 25) return [{ name: NAME, status: 'error', message: `${where}: the temp reaper is not keeping up`, hint }];
  if (count > 50000 || gb > 10) return [{ name: NAME, status: 'warn', message: `${where}: growing`, hint }];
  return [{ name: NAME, status: 'ok', message: where }];
}

// Measure /private/tmp: top-level count (fast) + du GB (bounded).
function readTmpSpace(root = '/private/tmp', { timeoutMs = 120000 } = {}) {
  const fs = require('fs');
  let count = NaN;
  try { count = fs.readdirSync(root).length; } catch { /* NaN */ }
  let gb = NaN;
  try {
    const out = require('child_process').execFileSync('du', ['-sk', root], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    const kb = Number(out.split(/\s/)[0]);
    if (Number.isFinite(kb)) gb = Math.round((kb / 1024 / 1024) * 10) / 10;
  } catch (e) {
    // du exits 1 on unreadable entries (other users' files) but still prints a total.
    const kb = Number(String((e && e.stdout) || '').split(/\s/)[0]);
    if (e && e.status === 1 && !e.signal && kb > 0) gb = Math.round((kb / 1024 / 1024) * 10) / 10;
  }
  return { count, gb };
}

module.exports = { diskSpaceResults, readDiskSpace, tmpSpaceResults, readTmpSpace };
