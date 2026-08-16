#!/usr/bin/env node
/**
 * title-overlap-check.mjs — CLI wrapper around dispatch-ledger.js's
 * titleMatchesSubject(), for callers that can't require() a CommonJS module
 * directly (task #1691: ~/.claude/hooks/exit-status-gate.sh's Gate P, a
 * Python hook that shells out to `cmux` for the same reason).
 *
 * Reuses the REAL >=20-char overlap heuristic instead of a second inline
 * copy — every other place that needs this match (bsc-next.js,
 * dispatch-guards.js) requires the module directly; this is the one seam
 * for a caller that structurally cannot.
 *
 * Usage: node title-overlap-check.mjs <subject> <workspaceTitle> [<workspaceTitle>...]
 * Exit 0 + prints "MATCH" if ANY workspaceTitle overlaps <subject>.
 * One process for all live titles (not one per title) — a Stop hook already
 * pays one `cmux` subprocess; this keeps the added cost to one more, not N.
 * Exit 1 + prints "NOMATCH" if none overlap.
 * Exit 2 + prints "ERROR: <message>" on a missing argument or a require()
 * failure. Kept DISTINCT from exit 1 on purpose: the caller (Gate P) treats
 * exit 1 as a genuine "not live" signal but must NOT treat "the checker
 * itself couldn't run" the same way — collapsing the two would turn an
 * unrelated environment problem (a moved/missing dependency, node not on
 * PATH inside whatever sandboxed the hook) into a false BLOCK of real,
 * truthful DISPATCHED: claims.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const [, , subject, ...titles] = process.argv;
if (subject === undefined || titles.length === 0) {
  console.log('ERROR: usage: title-overlap-check.mjs <subject> <workspaceTitle> [...]');
  process.exit(2);
}

let titleMatchesSubject;
try {
  ({ titleMatchesSubject } = require('./dispatch-ledger.js'));
} catch (e) {
  console.log(`ERROR: ${e.message}`);
  process.exit(2);
}

if (titles.some(t => titleMatchesSubject(t, subject))) {
  console.log('MATCH');
  process.exit(0);
}
console.log('NOMATCH');
process.exit(1);
