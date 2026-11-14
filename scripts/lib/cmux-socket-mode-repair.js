#!/usr/bin/env node
// scripts/lib/cmux-socket-mode-repair.js — put cmux back in password socket
// mode when ~/.config/cmux/cmux.json drifts away from it (BRO-5567).
//
// Why: on 2026-10-04 the file flipped from "password" to "cmuxOnly" (cmux
// upgrade or a Settings save; cause never pinned down). cmuxOnly admits only
// processes started inside cmux, so every launchd automation was denied for
// 7 days and a cmux restart did not help, because the file still said
// cmuxOnly. Alerts fired the whole time; nobody at the Mac could act on them.
// check-cmux-reachability.js (launchd, every 15 min) now rewrites the file so
// the next cmux restart or `cmux reload-config` brings automation back.
//
// The MODE triggers a rewrite. cmux has run password mode with the password
// stored outside the file (2026-09-21 migration), so a missing socketPassword
// alone is not drift. EXCEPT when the socket itself says "Password mode is
// enabled but no socket password is configured" (BRO-5640: 2026-10-18 cmux
// rewrote the file without the password and every launchd job was locked out
// for 44h+): then the file is the only place to put it back.
//
// Pure decision logic here (CLAUDE.md rule 15); file I/O stays in the caller.

'use strict';

const WANTED_MODE = 'password';
const NO_PASSWORD_RE = /password mode is enabled but no socket password is configured/i;

/** True when a cmux CLI error says password mode has no password configured. */
function isNoPasswordError(text) {
  return NO_PASSWORD_RE.test(String(text || ''));
}

/**
 * @param {object} a
 * @param {string} a.configText  raw cmux.json contents
 * @param {string} [a.password]  the socket password launchd callers use
 * @param {boolean} [a.socketReportsNoPassword]  live socket said no password is configured
 * @returns {{action: 'none'|'rewrite', reason: string, newText?: string, fromMode?: string}}
 */
function planSocketModeRepair({ configText, password, socketReportsNoPassword = false }) {
  if (!password) return { action: 'none', reason: 'no-password' };
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    // cmux has shipped this file as JSONC with a commented template. Never
    // clobber a file we cannot round-trip; the caller reports it instead.
    return { action: 'none', reason: 'unparseable' };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { action: 'none', reason: 'unparseable' };
  }
  const automation = config.automation && typeof config.automation === 'object' ? config.automation : {};
  const fromMode = automation.socketControlMode || '(unset)';
  if (automation.socketControlMode === WANTED_MODE) {
    if (socketReportsNoPassword && !automation.socketPassword) {
      const next = { ...automation, socketPassword: password };
      const newText = JSON.stringify({ ...config, automation: next }, null, 2) + '\n';
      return { action: 'rewrite', reason: 'password-missing', fromMode: WANTED_MODE, newText };
    }
    return { action: 'none', reason: 'already-password' };
  }

  const next = { ...automation, socketControlMode: WANTED_MODE };
  if (!next.socketPassword) next.socketPassword = password;
  const newText = JSON.stringify({ ...config, automation: next }, null, 2) + '\n';
  return { action: 'rewrite', reason: 'mode-drift', fromMode, newText };
}

/**
 * Which backup files to delete so at most `keep` remain (newest kept).
 * Names are cmux.json.bak-repair-<epoch ms>, so a numeric sort is age order.
 * @param {string[]} names  basenames in the cmux config dir
 * @param {number} keep
 * @returns {string[]}
 */
function backupsToPrune(names, keep) {
  const ours = names
    .map((n) => ({ n, m: /^cmux\.json\.bak-repair-(\d+)$/.exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  return ours.slice(keep).map((x) => x.n);
}

module.exports = { WANTED_MODE, isNoPasswordError, planSocketModeRepair, backupsToPrune };
