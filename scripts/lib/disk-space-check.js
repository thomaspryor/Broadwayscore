/**
 * disk-space-check — root-volume free-space check (BRO-2258).
 *
 * 2026-08-30: the machine silently hit 100% disk (117Mi free out of 460Gi).
 * Nothing warned. At that point cmux could not spawn terminal runtimes
 * (can't write workspace state), and bsc-runner reported "headless job
 * starting" then wrote no log and took no lease (can't create the log file)
 * — a dispatcher trusting that stdout line would have reported a successful
 * dispatch that never ran. A whole shift was spent diagnosing "cmux is
 * broken" / "the launcher is broken" before the real cause — ENOSPC — was
 * found by accident. This check exists so session-start surfaces it BEFORE
 * that diagnosis rabbit hole starts.
 *
 * Relationship to scripts/health-check.js's diskSpaceResults/readDiskSpace
 * (added 2026-08-09, "Infra: disk space" row in the daily digest email):
 * that check exists too, but at 10GB-error/20GB-warn thresholds sized for
 * build/merge headroom, and it only surfaces once a day by email. This check
 * is deliberately separate and tighter (1GB/5GB) because it's interactive —
 * printed at every session start, byte-precision `df -k` rather than
 * rounded `df -h` GB, so the 1GB emergency threshold isn't blurred by
 * rounding right where it matters most (second-opinion review finding,
 * BRO-2258 plan review). Not a duplicate authority: the daily row answers
 * "should we schedule a GC," this one answers "is a write about to fail."
 */

'use strict';

const { execFileSync } = require('child_process');

const DEFAULT_WARN_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const DEFAULT_ERROR_BYTES = 1 * 1024 * 1024 * 1024; // 1GB

/**
 * Parses `df -Pk <path>` output into free bytes.
 * Header: Filesystem  1024-blocks  Used  Available  Capacity  Mounted on
 * `-P` (POSIX format) guarantees exactly one line per filesystem — BSD/macOS
 * `df` without it wraps onto a second physical line for long filesystem
 * names, which `-P` avoids entirely (same flag bsc-runner.js's freeDiskGB
 * already uses, ~line 163). Still joins defensively in case a future `df`
 * variant ignores `-P`; cheap insurance, not load-bearing.
 */
function parseDfKbOutput(output) {
  const lines = String(output).trim().split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error(`unexpected df output: ${output}`);
  const dataLine = lines.slice(1).join(' ').trim();
  const cols = dataLine.split(/\s+/);
  const availableKb = Number(cols[3]);
  if (!Number.isFinite(availableKb)) {
    throw new Error(`could not parse available blocks from df output: ${dataLine}`);
  }
  return availableKb * 1024;
}

// 10s timeout matches bsc-runner.js's freeDiskGB (~line 163) — a stuck
// network mount must not hang `df` forever, which on an ungated call would
// hang every session-start hook fire indefinitely (ship-check finding,
// BRO-2258: the exact "silent failure" this feature exists to prevent
// visibility into becoming a silent HANG instead).
const DF_TIMEOUT_MS = 10000;

function getFreeBytes(volumePath = '/', execFn = execFileSync) {
  const output = execFn('df', ['-Pk', volumePath], { encoding: 'utf8', timeout: DF_TIMEOUT_MS });
  return parseDfKbOutput(output);
}

/**
 * Pure classifier — takes freeBytes directly so it's testable without
 * shelling out. level is 'ok' | 'warn' | 'error'.
 */
function checkDiskSpace({ freeBytes, warnBytes = DEFAULT_WARN_BYTES, errorBytes = DEFAULT_ERROR_BYTES } = {}) {
  if (!Number.isFinite(freeBytes)) throw new Error('freeBytes must be a finite number');
  let level = 'ok';
  if (freeBytes < errorBytes) level = 'error';
  else if (freeBytes < warnBytes) level = 'warn';
  return { level, freeBytes, warnBytes, errorBytes };
}

function formatGb(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function formatDiskSpaceMessage(result, volumePath = '/') {
  const { level, freeBytes, warnBytes, errorBytes } = result;
  const freeGb = formatGb(freeBytes);
  if (level === 'error') {
    return `🚨 DISK CRITICAL: ${volumePath} has only ${freeGb}GB free (danger threshold: ${formatGb(errorBytes)}GB). ` +
      `At this level writes silently fail with ENOSPC — job logs, cmux runtime state, and tool output can all ` +
      `stop being written with no other warning (BRO-2258). Free space now: prune ~/Library/Logs/bsc-jobs and old scratch dirs.`;
  }
  if (level === 'warn') {
    return `🔶 LOW DISK SPACE: ${volumePath} has ${freeGb}GB free (warn threshold: ${formatGb(warnBytes)}GB). ` +
      `A full disk silently breaks cmux runtime spawning and headless job logging (BRO-2258) — nothing else warns. ` +
      `Prune before it bites: find ~/Library/Logs/bsc-jobs -name '*.log' -mtime +14 -delete`;
  }
  return null;
}

/** Convenience wrapper: shells out to df, classifies, formats. */
function runDiskSpaceCheck({ volumePath = '/', execFn = execFileSync, warnBytes = DEFAULT_WARN_BYTES, errorBytes = DEFAULT_ERROR_BYTES } = {}) {
  const freeBytes = getFreeBytes(volumePath, execFn);
  const result = checkDiskSpace({ freeBytes, warnBytes, errorBytes });
  return { ...result, message: formatDiskSpaceMessage(result, volumePath) };
}

module.exports = {
  DEFAULT_WARN_BYTES,
  DEFAULT_ERROR_BYTES,
  parseDfKbOutput,
  getFreeBytes,
  checkDiskSpace,
  formatDiskSpaceMessage,
  runDiskSpaceCheck,
};
