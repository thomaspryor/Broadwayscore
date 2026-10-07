// cron-health-state.mjs — read/write data/audit/cron-health-state.json, the
// state file check-cron-health.yml persists across daily runs (stale set,
// one-shot redispatch ledger, per-cron streak days).
//
// Extracted from scripts/update-cron-health-state.js (BRO-123, CLAUDE.md rule
// 15) so the state file's read/write shape is a single source of truth
// instead of being re-implemented at each call site — update-cron-health-
// state.js now delegates here instead of touching fs directly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATE_FILE = path.join(__dirname, '..', '..', 'data', 'audit', 'cron-health-state.json');

/** Reads the state file. Returns null on missing/corrupt (treated as a fresh start by callers). */
export function readState(stateFile = DEFAULT_STATE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomically writes the state file (tmp file + rename, so a concurrent reader never sees a partial write). */
export function writeState(next, stateFile = DEFAULT_STATE_FILE) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, stateFile);
}
