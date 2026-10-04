// push-command.mjs — parse the `git push` invocations inside a shell command
// string (a Claude Bash tool call) into structured refspecs.
//
// Intended single parser for "what does this command push, and where?"
// (BRO-4593). queryPushIngress (transcript-scan.mjs) stays the cheap boolean
// "is this a push at all" check; the refspec readers that predate this file
// (the awk block in .claude/hooks/pre-push-review-gate.sh and the land regex in
// .claude/hooks/verify-edits.sh) should move onto parsePushCommand rather than
// grow a fourth copy.
//
// Only a `git push` that STARTS a shell command counts: after the start of the
// string, `;`, `&&`, `||`, `|`, `&`, a newline or a paren. Text that merely
// mentions a push (a commit message, echo, grep pattern, heredoc body) is
// never a push. Heredoc bodies and `#` comments are dropped before parsing.

import path from 'node:path';

const HEAD_MOVING = new Set(['commit', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'cherry-pick', 'am', 'pull', 'revert', 'stash']);

// git push options that consume the following word as their value.
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
// git global options (before the subcommand) that consume a value.
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
// Ways to point git at another repo that this parser does not follow: the push dir becomes unknown.
const GIT_REPO_OPTS = /^--(git-dir|work-tree)(=|$)/;
const GIT_REPO_ENV = /^(GIT_DIR|GIT_WORK_TREE)=/;

/** Drop heredoc bodies: everything from the line after `<<TAG` / `<<-'TAG'` up to the line that is TAG. */
function stripHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let tag = null;
  for (const line of lines) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) tag = m[2];
  }
  return out.join('\n');
}

/**
 * Split into shell commands (word arrays), honouring quotes, dropping
 * comments. Each command is { words, sep } where sep is the separator that
 * ENDED it (';', '&&', '||', '|', '&', '\n', '(' or ')' or '' at the end).
 */
export function splitShellCommands(cmd) {
  const src = stripHeredocs(String(cmd || ''));
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (sep) => {
    endWord();
    // Paren boundaries are kept even when empty so callers can scope `cd` to a subshell.
    if (words.length || sep === '(' || sep === ')') commands.push({ words, sep });
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < src.length) word += src[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') word += src[i + 1];
      inWord = inWord || src[i + 1] !== '\n';
      i++;
      continue;
    }
    if (ch === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
      i--;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      endCommand(two);
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '(' || ch === ')') {
      endCommand(ch);
      continue;
    }
    word += ch;
    inWord = true;
  }
  endCommand('');
  return commands;
}

function isGitWord(w) {
  return w === 'git' || /\/git$/.test(w);
}

/** Parse one refspec into { src, dst, force, isDelete }. dst loses any refs/heads/ prefix. */
export function parseRefspec(spec) {
  let s = spec;
  let force = false;
  if (s.startsWith('+')) {
    force = true;
    s = s.slice(1);
  }
  let src;
  let dst;
  const colon = s.indexOf(':');
  if (colon === -1) {
    src = s;
    dst = s;
  } else {
    src = s.slice(0, colon);
    dst = s.slice(colon + 1);
  }
  dst = dst.replace(/^refs\/heads\//, '');
  return { src, dst, force, isDelete: src === '' };
}

/**
 * Every `git push` in the command, in order:
 *   { gitC: [dirs from -C], cdDir: last `cd X` before it (or null), remote,
 *     refspecs: [{src,dst,force,isDelete}], deleteFlag, headMovedBefore,
 *     dirUnknown }
 * dirUnknown: the repo the push runs in cannot be worked out (pushd, a bare or
 * `~`/`-`/`$VAR` cd, --git-dir/--work-tree, GIT_DIR=), so callers must not
 * judge it against the session's own cwd.
 * headMovedBefore: a HEAD-moving git command (commit/merge/reset/…) runs
 * earlier in the same command string, so the repo state the push sees is not
 * the state a PreToolUse hook sees.
 */
export function parsePushCommand(cmd) {
  const pushes = [];
  let cdDir = null;
  let dirUnknown = false;
  let headMoved = false;
  const subshells = [];
  for (const { words, sep } of splitShellCommands(cmd)) {
    parseOne(words);
    if (sep === '(') subshells.push({ cdDir, dirUnknown });
    else if (sep === ')' && subshells.length) ({ cdDir, dirUnknown } = subshells.pop());
  }
  return pushes;

  function parseOne(words) {
    if (!words.length) return;
    let i = 0;
    let envRepo = false;
    for (; i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]); i++) {
      if (GIT_REPO_ENV.test(words[i])) envRepo = true; // FOO=bar prefixes
    }
    const head = words[i];
    if (head === 'cd') {
      const d = words[i + 1];
      if (!d || d === '-' || d.startsWith('~') || d.includes('$')) dirUnknown = true;
      else if (path.isAbsolute(d)) { cdDir = d; dirUnknown = false; }
      else cdDir = cdDir ? path.join(cdDir, d) : d;
      return;
    }
    if (head === 'pushd' || head === 'popd') {
      dirUnknown = true;
      return;
    }
    if (!isGitWord(head || '')) return;
    i++;
    const gitC = [];
    let repoOpt = false;
    while (i < words.length && words[i].startsWith('-')) {
      const opt = words[i];
      if (GIT_REPO_OPTS.test(opt)) repoOpt = true;
      if (opt.includes('=')) {
        i++;
      } else if (GIT_GLOBAL_WITH_VALUE.has(opt)) {
        if (opt === '-C') gitC.push(words[i + 1]);
        i += 2;
      } else {
        i++;
      }
    }
    const sub = words[i];
    if (sub !== 'push') {
      if (HEAD_MOVING.has(sub)) headMoved = true;
      return;
    }
    i++;
    let deleteFlag = false;
    const positional = [];
    for (; i < words.length; i++) {
      const w = words[i];
      if (w === '--') {
        positional.push(...words.slice(i + 1));
        break;
      }
      if (w.startsWith('-')) {
        if (w === '-d' || w === '--delete' || (/^-[A-Za-z]{2,}$/.test(w) && w.includes('d'))) deleteFlag = true; // -d, -df, -fd
        if (PUSH_OPTS_WITH_VALUE.has(w)) i++;
        continue;
      }
      positional.push(w);
    }
    const [remote = null, ...specs] = positional;
    const refspecs = specs.map(parseRefspec).map((r) => (deleteFlag ? { ...r, isDelete: true } : r));
    pushes.push({ gitC, cdDir, remote, refspecs, deleteFlag, headMovedBefore: headMoved, dirUnknown: dirUnknown || envRepo || repoOpt });
  }
}

/** Refspecs in the command whose destination is a land/ branch (deletes excluded), with their push context. */
export function landPushTargets(cmd) {
  const out = [];
  for (const p of parsePushCommand(cmd)) {
    for (const r of p.refspecs) {
      if (r.dst.startsWith('land/') && !r.isDelete) out.push({ ...r, push: p });
    }
  }
  return out;
}
