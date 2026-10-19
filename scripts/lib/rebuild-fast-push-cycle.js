#!/usr/bin/env node
/**
 * BRO-2783: decision logic for rebuild-fast.yml's outer push cycle.
 *
 * push-with-retry.sh can lose every one of its 20 rebase races against a hot
 * main (public/data/shows/*.json, mobile-shows.json, data/audit/*) and exit 1,
 * stranding a fully scored rebuild (opening-night incident 2026-09-04). Its
 * Git Data API fallback is skipped BY DESIGN for union-merge-managed files, so
 * widening API_FALLBACK_SAFE is not the fix. Board decision (option b): after a
 * lost race, reset to fresh origin/main, redo the fast rebuild on top of it and
 * push again — a bounded number of outer cycles, with jitter, so it can never
 * loop forever.
 *
 * The loop itself lives in rebuild-fast-push-cycle.sh; every decision it makes
 * comes from this file (pure functions, exercised by
 * tests/unit/rebuild-fast-push-retry.test.mjs via require()).
 *
 * CLI (used by the .sh loop):
 *   node scripts/lib/rebuild-fast-push-cycle.js decide --exit=N --cycle=C --max=M
 *     -> prints "done" | "redo" | "fail"
 *   node scripts/lib/rebuild-fast-push-cycle.js after-redo --exit=N
 *     -> prints "push" | "done" | "fail"
 *   node scripts/lib/rebuild-fast-push-cycle.js max-cycles [raw]
 *   node scripts/lib/rebuild-fast-push-cycle.js jitter --cycle=C [--max-sec=S]
 */

'use strict';

/** Total push cycles (first push + redos) when the caller does not override. */
const DEFAULT_MAX_CYCLES = 2; // one redo; fits rebuild-fast.yml's 45-min budget
/** Hard ceiling regardless of env, so a typo can never make the loop unbounded. */
const HARD_MAX_CYCLES = 5;
/**
 * push-with-retry.sh exit code for a DETERMINISTIC rejection: a LOCAL pre-push
 * hook (BRO-2879) or a GitHub 403 because the token lacks contents: write
 * (BRO-5306, ledger reason permission-denied). Either way a redo would hit it
 * again, so both fail. The run log / ledger reason says which one.
 */
const EXIT_HOOK_REJECTED = 4;
/** Redo script exit code meaning "fresh main already has everything; nothing to commit". */
const EXIT_REDO_NOTHING_TO_COMMIT = 3;
const DEFAULT_JITTER_MAX_SEC = 20;

function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v !== 'string' || !/^-?\d+$/.test(v.trim())) return NaN;
  return Number.parseInt(v.trim(), 10);
}

/**
 * Normalise the configured cycle budget. Invalid/missing -> default; clamped
 * to [1, HARD_MAX_CYCLES] so the loop is always bounded.
 */
function resolveMaxCycles(raw) {
  const n = toInt(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CYCLES;
  return Math.min(HARD_MAX_CYCLES, Math.max(1, n));
}

/**
 * What to do after a push attempt.
 *   exit 0                 -> done
 *   exit 4 (hook rejected or permission-denied 403) -> fail (deterministic; a redo would hit it again)
 *   any other non-zero     -> redo while cycles remain, else fail
 * Non-integer exit / cycle values fail closed (never an extra cycle).
 */
function decideAfterPush({ pushExit, cycle, maxCycles }) {
  const code = toInt(pushExit);
  const c = toInt(cycle);
  const max = resolveMaxCycles(maxCycles);
  if (code === 0) return { action: 'done', reason: 'pushed' };
  if (!Number.isFinite(code) || !Number.isFinite(c) || c < 1) {
    return { action: 'fail', reason: 'invalid-input' };
  }
  if (code === EXIT_HOOK_REJECTED) return { action: 'fail', reason: 'deterministic-reject(exit 4)' };
  if (c >= max) return { action: 'fail', reason: `cycles-exhausted(${c}/${max})` };
  return { action: 'redo', reason: `lost-race(exit ${code}), cycle ${c}/${max}` };
}

/**
 * What to do after the redo (reset + rebuild + restage + commit) ran.
 *   0 -> push the new commit
 *   3 -> fresh main already carries identical content: success, nothing to push
 *   anything else -> fail (the redo itself broke; do not push a half-built tree)
 */
function decideAfterRedo({ redoExit }) {
  const code = toInt(redoExit);
  if (code === 0) return { action: 'push', reason: 'redo-committed' };
  if (code === EXIT_REDO_NOTHING_TO_COMMIT) return { action: 'done', reason: 'redo-nothing-to-commit' };
  return { action: 'fail', reason: `redo-failed(exit ${pushSafe(redoExit)})` };
}

function pushSafe(v) {
  return String(v).replace(/[^\w.-]/g, '').slice(0, 16) || '?';
}

/**
 * Seconds to wait before a redo. Grows with the cycle and adds random jitter
 * so two runs that lost to each other do not re-collide in lockstep.
 * rand is injectable for tests; must return [0, 1).
 */
function jitterDelaySec({ cycle, maxSec = DEFAULT_JITTER_MAX_SEC, rand = Math.random }) {
  const c = Math.max(1, toInt(cycle) || 1);
  const cap = Math.max(0, toInt(maxSec));
  const capped = Number.isFinite(cap) ? cap : DEFAULT_JITTER_MAX_SEC;
  if (capped === 0) return 0;
  const base = Math.min(capped, 2 * c);
  const r = Math.min(Math.max(Number(rand()) || 0, 0), 0.999999);
  return Math.min(capped, base + Math.floor(r * (capped - base + 1)));
}

function parseFlags(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const f = parseFlags(rest);
  switch (cmd) {
    case 'decide': {
      const d = decideAfterPush({ pushExit: f.exit, cycle: f.cycle, maxCycles: f.max });
      process.stderr.write(`[rebuild-fast-push-cycle] ${d.action}: ${d.reason}\n`);
      process.stdout.write(`${d.action}\n`);
      return 0;
    }
    case 'after-redo': {
      const d = decideAfterRedo({ redoExit: f.exit });
      process.stderr.write(`[rebuild-fast-push-cycle] ${d.action}: ${d.reason}\n`);
      process.stdout.write(`${d.action}\n`);
      return 0;
    }
    case 'max-cycles':
      process.stdout.write(`${resolveMaxCycles(rest[0])}\n`);
      return 0;
    case 'jitter':
      process.stdout.write(`${jitterDelaySec({ cycle: f.cycle, maxSec: f['max-sec'] ?? DEFAULT_JITTER_MAX_SEC })}\n`);
      return 0;
    default:
      process.stderr.write('usage: rebuild-fast-push-cycle.js decide|after-redo|max-cycles|jitter [--flags]\n');
      return 1;
  }
}

module.exports = {
  DEFAULT_MAX_CYCLES,
  HARD_MAX_CYCLES,
  EXIT_HOOK_REJECTED,
  EXIT_REDO_NOTHING_TO_COMMIT,
  resolveMaxCycles,
  decideAfterPush,
  decideAfterRedo,
  jitterDelaySec,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
