/**
 * discover-new-shows.js — category+market are mandatory on every new show.
 *
 * Root cause of Schmigadoon (2026-04-19), Beaches (2026-04-22), Rocky Horror
 * (2026-04-23), Joe Turner (2026-04-25), Lost Boys (2026-04-26):
 * `discover-new-shows.js` only set `category` for the non-Broadway branches
 * (off-broadway / west-end / off-west-end) and left Broadway shows implicit,
 * and `market` was never set at all. The opening-night orchestrator
 * defaulted `cat || 'broadway'` but emitted warnings; per CLAUDE.md §14 step
 * 5, explicit fields are the readiness-check requirement.
 *
 * This test locks the invariant: the creator block at scripts/discover-new-shows.js
 * must set BOTH category AND market on every branch, including the implicit
 * Broadway default (else-clause).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');

// Locate the category-assignment block. The canonical block is near the final
// `data.shows.push(showEntry)` call. We extract the ~25 lines preceding that
// push and assert both category and market are set for every branch.
function extractAssignmentBlock() {
  const pushIdx = SRC.indexOf('data.shows.push(showEntry)');
  assert.ok(pushIdx > 0, 'could not find data.shows.push(showEntry) in discover-new-shows.js');
  // Walk back ~40 lines — enough to capture the full if/else chain.
  const start = SRC.lastIndexOf('\n', pushIdx - 1);
  const lines = SRC.slice(0, start).split('\n');
  return lines.slice(-40).join('\n');
}

test('Broadway branch (else) sets both category and market', () => {
  const block = extractAssignmentBlock();
  // Must contain an explicit Broadway assignment — no implicit default allowed.
  assert.ok(
    /showEntry\.category\s*=\s*['"]broadway['"]/.test(block),
    'scripts/discover-new-shows.js no longer sets showEntry.category = "broadway" on the Broadway branch. ' +
      'The implicit default caused Schmigadoon 2026-04-19 / Beaches 2026-04-22 / Rocky Horror ' +
      '2026-04-23 / Joe Turner 2026-04-25 / Lost Boys 2026-04-26 to ship with null category.'
  );
  assert.ok(
    /showEntry\.market\s*=\s*['"]broadway['"]/.test(block),
    'scripts/discover-new-shows.js no longer sets showEntry.market = "broadway" on the Broadway branch.'
  );
});

test('Off-Broadway branch sets category=off-broadway and market=broadway', () => {
  const block = extractAssignmentBlock();
  assert.ok(
    /off-broadway['"][\s\S]*?showEntry\.category\s*=\s*['"]off-broadway['"][\s\S]*?showEntry\.market\s*=\s*['"]broadway['"]/
      .test(block),
    'off-broadway branch no longer sets category=off-broadway AND market=broadway together'
  );
});

test('West End branch sets category=west-end and market=west-end', () => {
  const block = extractAssignmentBlock();
  assert.ok(
    /['"]west-end['"][\s\S]*?showEntry\.category\s*=\s*['"]west-end['"][\s\S]*?showEntry\.market\s*=\s*['"]west-end['"]/
      .test(block),
    'west-end branch no longer sets category=west-end AND market=west-end together'
  );
});

test('Off-West-End branch sets category=off-west-end and market=west-end', () => {
  const block = extractAssignmentBlock();
  assert.ok(
    /off-west-end['"][\s\S]*?showEntry\.category\s*=\s*['"]off-west-end['"][\s\S]*?showEntry\.market\s*=\s*['"]west-end['"]/
      .test(block),
    'off-west-end branch no longer sets category=off-west-end AND market=west-end together'
  );
});

test('No branch is left without a market assignment', () => {
  const block = extractAssignmentBlock();
  // Count if/else-if branches vs. market assignments. There are exactly 4:
  // off-broadway, west-end, off-west-end, and the else (Broadway default).
  const ifCount = (block.match(/if\s*\(show\.category\s*===|^\s*\}\s*else\s*\{/gm) || []).length;
  const marketAssignments = (block.match(/showEntry\.market\s*=/g) || []).length;
  assert.ok(
    marketAssignments >= 4,
    `Expected ≥4 showEntry.market assignments (one per branch), found ${marketAssignments}. ` +
      `If you added a branch without setting market, a whole cohort of shows will ship with market=null.`
  );
});
