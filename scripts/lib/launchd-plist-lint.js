/**
 * launchd-plist-lint.js — flag a launchd job that runs a bare command (`node`,
 * `npx`, `gh`, ...) with no way to find it.
 *
 * launchd hands a job PATH=/usr/bin:/bin:/usr/sbin:/sbin. On this Mac node, gh
 * and npx live in /opt/homebrew/bin, so `bash -c "... exec node x.js"` dies with
 * exit 127 before the script starts. com.broadwayscore.wsj-cookie-refresh did
 * exactly that: `launchctl print` showed `last exit code = 127`, the monthly
 * WSJ cookie refresh never ran, and nothing alerted (2026-11-08).
 *
 * A plist is fine when ANY of these holds:
 *   - the command is an absolute path (/opt/homebrew/bin/node ...);
 *   - EnvironmentVariables.PATH contains /opt/homebrew/bin;
 *   - the shell is a login shell (`bash -lc`, as com.broadwayscore.cookie-renew
 *     does), which builds PATH from the owner's profile;
 *   - the line carries `plist-path-ok: <reason>`.
 *
 * Pure function, no fs: scripts/audit-launchd-plist-path.js walks the files.
 * XML comments are dropped first so a header that quotes the bad command as
 * documentation (every plist here has one) is not flagged.
 */

'use strict';

// Commands that live outside launchd's default PATH on this machine.
const BARE_COMMANDS = ['node', 'npx', 'npm', 'gh', 'python3', 'python', 'claude', 'tsx', 'bun'];
const REQUIRED_PATH_ENTRY = '/opt/homebrew/bin';
const WAIVER_RE = /plist-path-ok:/;

// `node` as a command word: not part of a path (`/bin/node`, `./node`), a name
// (`check-node-x`, `node_modules`) or a flag.
const BARE_COMMAND_RE = new RegExp(`(?<![\\w./-])(${BARE_COMMANDS.join('|')})(?=['"]?(?:\\s|$))`);

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function stripXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** The <string> values of ProgramArguments, XML-decoded, in order. */
function programArguments(text) {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!m) return [];
  const args = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let s;
  while ((s = re.exec(m[1])) !== null) args.push(decodeXml(s[1]));
  return args;
}

/** EnvironmentVariables.PATH, or null when the plist sets none. */
function environmentPath(text) {
  const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
  if (!env) return null;
  const m = /<key>PATH<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(env[1]);
  return m ? decodeXml(m[1]).trim() : null;
}

/** Index of the shell's command string (the arg after the option cluster that holds `c`), or -1. */
function shellCommandIndex(args) {
  const shellIdx = args.findIndex((a) => /(?:^|\/)(?:ba|z)?sh$/.test(a));
  if (shellIdx < 0) return -1;
  for (let i = shellIdx + 1; i < args.length; i++) {
    if (!/^-[a-zA-Z]+$/.test(args[i])) return -1;
    if (/c/.test(args[i]) && args[i + 1] !== undefined) return i + 1;
  }
  return -1;
}

/** `bash -lc` / `zsh -l -c` / `bash -cl`: the shell reads the login profile. Only options
 *  BEFORE the command string count; later args are $0, $1, ... */
function usesLoginShell(args) {
  const shellIdx = args.findIndex((a) => /(?:^|\/)(?:ba|z)?sh$/.test(a));
  if (shellIdx < 0) return false;
  const cmdIdx = shellCommandIndex(args);
  const opts = args.slice(shellIdx + 1, cmdIdx < 0 ? undefined : cmdIdx);
  return opts.some((a) => /^-[a-zA-Z]*l[a-zA-Z]*$/.test(a));
}

/**
 * @param {string} plistText raw .plist file content
 * @returns {{ command: string, text: string }[]} one entry per ProgramArguments
 *   string that runs a bare command with nothing to resolve it; [] when safe.
 */
function findBareCommandsWithoutPath(plistText) {
  const text = stripXmlComments(plistText);
  const args = programArguments(text);
  if (!args.length) return [];

  const pathValue = environmentPath(text);
  if (pathValue && pathValue.split(':').includes(REQUIRED_PATH_ENTRY)) return [];
  if (usesLoginShell(args)) return [];

  const findings = [];
  const cmdIdx = shellCommandIndex(args);
  // `/usr/bin/env [-flags] [VAR=x] node ...`: the first non-flag, non-assignment word is the command.
  let envCmdIdx = -1;
  if (args[0] === '/usr/bin/env') {
    envCmdIdx = args.findIndex((a, i) => i > 0 && !/^-/.test(a) && !/^\w+=/.test(a));
  }
  args.forEach((arg, i) => {
    if (WAIVER_RE.test(arg)) return;
    // argv[0] itself: `<string>node</string>`
    if (i === 0 && BARE_COMMANDS.includes(arg)) {
      findings.push({ command: arg, text: arg });
      return;
    }
    if (i === envCmdIdx && BARE_COMMANDS.includes(arg)) {
      findings.push({ command: arg, text: `/usr/bin/env ${arg}` });
      return;
    }
    // Shell script strings: the arg after -c, or any other arg with a space.
    if (i !== cmdIdx && !/\s/.test(arg)) return;
    const m = BARE_COMMAND_RE.exec(arg);
    if (m) findings.push({ command: m[1], text: arg.trim() });
  });
  return findings;
}

module.exports = { findBareCommandsWithoutPath, BARE_COMMANDS, REQUIRED_PATH_ENTRY };
