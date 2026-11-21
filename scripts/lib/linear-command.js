'use strict';

const path = require('node:path');
const { splitShellCommands, skipWrappers } = require('./push-command.mjs');
const { parseArgs } = require('./cli-args.js');

// Shared by the close-out gates: multiline comment/summary values are arguments,
// not commands or flags. Use the shell parser and the Linear CLIs' flag semantics.
function linearCommands(command, depth = 0) {
  const out = [];
  if (!/linear-(?:brain|session)\.js/i.test(String(command || ''))) return out;
  for (const { words } of splitShellCommands(command)) {
    // These shell keywords introduce the next command (as in pr-command.mjs).
    let i = 0;
    while (/^(?:then|do|else|elif|if|while|until|\{|!)$/.test(words[i] || '')) i++;
    i += skipWrappers(words.slice(i));
    const executable = path.basename(words[i] || '');
    if (/^(?:bash|sh|zsh)$/.test(executable) && depth < 3) {
      let hasScript = false;
      for (i++; /^-/.test(words[i] || ''); i++) {
        if (/^-[a-z]*n/.test(words[i])) { hasScript = false; break; }
        if (/^-[a-z]*c/.test(words[i])) hasScript = true;
        if (/^-[a-z]*[oO]$/.test(words[i])) i++;
        if (words[i] === '--') { i++; break; }
      }
      if (hasScript) out.push(...linearCommands(words[i] || '', depth + 1));
      continue;
    }
    if (executable === 'node') {
      for (i++; /^-/.test(words[i] || ''); i++) {
        if (/^(?:-[a-z]*[epc]|--(?:eval|print|check)(?:=|$))/.test(words[i])) break;
        if (words[i] === '--') { i++; break; }
        if (/^(?:-r|--require|--import|--loader|--experimental-loader)$/.test(words[i])) i++;
      }
    }
    const script = path.basename(words[i] || '').toLowerCase();
    if (script !== 'linear-brain.js' && script !== 'linear-session.js') continue;
    out.push({ script, verb: String(words[i + 1] || '').toLowerCase(), args: parseArgs(words.slice(i + 2)) });
  }
  return out;
}

module.exports = { linearCommands };
