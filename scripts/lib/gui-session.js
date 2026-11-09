'use strict';
/**
 * gui-session.js — may a headed browser run right now? (BRO-7171 Stage 2,
 * revised plan item 8). A subscriber Chrome needs a logged-in GUI session on
 * the console and an unlocked screen; otherwise the attempt is recorded as
 * browser_unavailable (non-evidence), never as a failed fetch.
 *
 * macOS: `ioreg -n Root -d1` lists IOConsoleUsers with
 * kCGSSessionOnConsoleKey and CGSSessionScreenIsLocked per session.
 */

/**
 * Pure parser of `ioreg -n Root -d1` output.
 * @param {string} text
 * @param {string} user login name that must own the console session
 * @returns {{available: boolean, reason: string}}
 */
function parseIoregConsole(text, user) {
  const m = /"IOConsoleUsers"\s*=\s*\((.*)\)/.exec(String(text || ''));
  if (!m) return { available: false, reason: 'no_console_session' };
  const sessions = m[1].split(/\}\s*,\s*\{/);
  const mine = sessions.find((s) => new RegExp(`"kCGSSessionUserNameKey"\\s*=\\s*"${String(user).replace(/[^\w.-]/g, '')}"`).test(s));
  if (!mine) return { available: false, reason: 'user_not_on_console' };
  if (!/"kCGSSessionOnConsoleKey"\s*=\s*Yes/.test(mine)) return { available: false, reason: 'session_not_on_console' };
  if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(mine)) return { available: false, reason: 'screen_locked' };
  return { available: true, reason: 'gui_ok' };
}

/** IO: is a headed browser usable now on this machine? */
function guiSessionAvailable({ platform = process.platform, run } = {}) {
  if (process.env.GAP_RECOVERY_ASSUME_GUI === '1') return { available: true, reason: 'assumed (GAP_RECOVERY_ASSUME_GUI=1)' };
  if (platform !== 'darwin') return { available: false, reason: `platform_${platform}` };
  const exec = run || (() => require('child_process').execFileSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  let text;
  try { text = exec(); } catch (e) { return { available: false, reason: `ioreg_failed: ${e.message.split('\n')[0]}` }; }
  return parseIoregConsole(text, require('os').userInfo().username);
}

module.exports = { parseIoregConsole, guiSessionAvailable };
