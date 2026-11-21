#!/usr/bin/env node
'use strict';
/**
 * broadcast-gate-scope.js (BRO-7607): which part of an opening-night broadcast
 * run a QA gate's breached shows actually block.
 *
 * A run gates two independent sets: new drafts (steps.check pending_shows) and
 * unsent-draft refreshes (steps.refresh refresh_shows, BRO-7386). The gates used
 * to set one run-wide `blocked` flag, so on 2026-11-16 the Cloud 9 refresh's two
 * checklist errors stopped Downstate's new draft in three runs while Downstate
 * itself was ready and past its draft deadline.
 *
 * Now a breach blocks only the set its show belongs to:
 *   blocked=true          a pending show breached (no new draft this run)
 *   refresh_blocked=true  a refresh show breached (no draft refresh this run)
 * Within a set the behaviour is unchanged: one breached pending show still holds
 * the whole pending batch. A show in both lists blocks both.
 *
 * CLI: BREACHED=a,b PENDING=c,d REFRESH=e node scripts/lib/broadcast-gate-scope.js
 * prints the two output lines (the workflow appends them to $GITHUB_OUTPUT).
 */

function toIds(list) {
  if (Array.isArray(list)) return list.filter(Boolean);
  return String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function scopeBreaches({ breached, pending, refresh }) {
  const hit = new Set(toIds(breached));
  const pendingBreached = toIds(pending).filter((id) => hit.has(id));
  const refreshBreached = toIds(refresh).filter((id) => hit.has(id));
  // A breached id in neither list cannot be placed, so it blocks both (fail closed).
  const known = new Set([...toIds(pending), ...toIds(refresh)]);
  const unplaced = [...hit].filter((id) => !known.has(id));
  return {
    blocked: pendingBreached.length > 0 || unplaced.length > 0,
    refreshBlocked: refreshBreached.length > 0 || unplaced.length > 0,
    pendingBreached,
    refreshBreached,
    unplaced,
  };
}

function outputLines(scope) {
  return [`blocked=${scope.blocked}`, `refresh_blocked=${scope.refreshBlocked}`];
}

module.exports = { scopeBreaches, outputLines };

if (require.main === module) {
  const scope = scopeBreaches({
    breached: process.env.BREACHED,
    pending: process.env.PENDING,
    refresh: process.env.REFRESH,
  });
  if (scope.pendingBreached.length) process.stderr.write(`New-draft shows held back: ${scope.pendingBreached.join(',')}\n`);
  if (scope.refreshBreached.length) process.stderr.write(`Draft refreshes held back: ${scope.refreshBreached.join(',')}\n`);
  if (scope.unplaced.length) process.stderr.write(`Breached shows in neither list (blocking both): ${scope.unplaced.join(',')}\n`);
  process.stdout.write(outputLines(scope).join('\n') + '\n');
}
