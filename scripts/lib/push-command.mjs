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
// never a push. `#` comments are dropped before parsing, and so are heredoc
// bodies, EXCEPT a body fed to a shell (`bash <<EOF`, `cat <<EOF | sh`,
// `eval "$(cat <<EOF`): that is a script the shell will run, so it is parsed
// as one, inside a subshell scope (BRO-5932).

import path from 'node:path';

const HEAD_MOVING = new Set(['commit', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'cherry-pick', 'am', 'pull', 'revert', 'stash']);

// git push options that consume the following word as their value.
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
// git global options (before the subcommand) that consume a value.
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
// Ways to point git at another repo that this parser does not follow: the push dir becomes unknown.
const GIT_REPO_OPTS = /^--(git-dir|work-tree)(=|$)/;
const GIT_REPO_ENV = /^(GIT_DIR|GIT_WORK_TREE)=/;

const SHELL_SINKS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
// Commands that run the next command, and the flags of theirs that take a value.
const WRAPPERS = {
  sudo: /^(-u|--user|-g|--group|-C|-h|--host|-p|--prompt|-r|-t|-U)$/,
  doas: /^(-u|-C)$/,
  env: /^(-u|--unset|-C|--chdir|-S|--split-string)$/,
  timeout: /^(-k|--kill-after|-s|--signal)$/,
  gtimeout: /^(-k|--kill-after|-s|--signal)$/,
  nice: /^(-n|--adjustment)$/,
  exec: /^(-a)$/,
  command: /^$/,
  time: /^$/,
  nohup: /^$/,
};
const DURATION = /^[0-9]+(\.[0-9]+)?[smhd]?$/;
// `<<TAG`, `<<-TAG`, `<<'TAG'`, `<<\TAG`. Not `<<<` (a here-string), whose
// second and third `<` would otherwise read as a heredoc opener.
const HEREDOC_OPEN = /(?<!<)<<(?!<)-?\s*(['"]?)\\?([A-Za-z_][A-Za-z0-9_]*)\1/;

/** Index of the real command in a word list, past VAR=x prefixes and wrappers (sudo -u bob, env -u X, timeout 30, nice -n 5, …). */
export function skipWrappers(words) {
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const w = path.basename(words[i] || '');
    if (!Object.hasOwn(WRAPPERS, w)) return i;
    i++;
    while (i < words.length && words[i].startsWith('-')) i += WRAPPERS[w].test(words[i]) ? 2 : 1;
    if ((w === 'timeout' || w === 'gtimeout') && DURATION.test(words[i] || '')) i++;
  }
}

/**
 * Does this command read its script from stdin? `bash`, `bash -s`, `bash -s -- a b`,
 * `bash -e -o pipefail`, `bash -`: yes. `bash script.sh`, `bash -c '…'`: no.
 */
export function readsScriptFromStdin(words) {
  const i = skipWrappers(words);
  if (!SHELL_SINKS.has(path.basename(words[i] || ''))) return false;
  for (let k = i + 1; k < words.length; k++) {
    const w = words[k];
    if (w === '--') return true; // no script operand came first; the rest are $1..$n
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) return false;
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(w)) return true;
    if (w === '-' || w === '+o' || w === '-o' || w === '+O' || w === '-O') {
      if (/^[-+][oO]$/.test(w)) k++; // takes an option name
      continue;
    }
    if (w === '<<<') { k++; continue; } // here-string: its word is the script, not an operand
    if (/^[0-9]*>>?$/.test(w)) { k++; continue; } // `> file`: the file is not a script operand
    if (/^[0-9]*>/.test(w)) continue; // `>file`, `2>log`
    if (w.startsWith('<')) continue; // redirection word
    if (w.startsWith('-') || w.startsWith('+')) continue;
    return false; // a script-file operand
  }
  return true;
}

/**
 * Does the command that OWNS the heredoc on this opening line run the body as
 * a script? Returns 'shell' (`bash <<EOF`, `sudo -u x bash -s <<EOF`,
 * `cat <<EOF | sh`, `source /dev/stdin <<EOF`), 'eval' (`eval "$(cat <<EOF`)
 * or null (`bash script.sh <<EOF`, `ssh host bash <<EOF`, `cat <<EOF`, and any
 * shell/eval elsewhere on the line that does not receive the heredoc).
 */
function heredocSink(line) {
  const cmds = splitRaw(line);
  const owner = cmds.findIndex(({ words }) => words.some((w) => w.includes('<<') && !w.includes('<<<')));
  if (owner === -1) return null;
  // The owner, then each command its output is piped into.
  for (let n = owner; n < cmds.length; n++) {
    const { words } = cmds[n];
    const i = skipWrappers(words);
    const w = path.basename(words[i] || '');
    if (SHELL_SINKS.has(w) && readsScriptFromStdin(words)) return 'shell';
    if (w === 'eval' && n === owner) return 'eval';
    if ((w === 'source' || w === '.') && n === owner && words.some((x) => x === '/dev/stdin' || x === '/dev/fd/0')) return 'shell';
    if (cmds[n].sep !== '|') break;
  }
  return null;
}

// Placeholder word standing in for a kept heredoc body in the stripped text.
// Bodies are tokenized on their own (expandBodies), so an unbalanced quote or
// a `)` inside one cannot reach the commands around it.
const BODY_MARK = '\u0001BODY';

/**
 * Drop heredoc bodies: everything from the line after `<<TAG` / `<<-'TAG'` up
 * to the line that is TAG. A body that a shell will execute is kept instead
 * (pushed onto `bodies`, replaced by a placeholder line).
 */
function stripHeredocs(cmd, bodies, depth = 0) {
  const lines = cmd.split('\n');
  const out = [];
  let tag = null;
  let keep = false;
  let evalOpen = false;
  let body = [];
  const emitBody = () => {
    bodies.push(body.join('\n'));
    out.push(`${BODY_MARK}${bodies.length - 1}`);
  };
  for (const raw of lines) {
    let line = raw;
    if (tag === null && evalOpen) {
      // The `)"` that closes `eval "$(cat <<EOF` follows the terminator.
      line = line.replace(/^\s*\)["']?/, '');
      evalOpen = false;
    }
    if (tag !== null) {
      if (line.trim() === tag) {
        if (keep) emitBody();
        tag = null;
        keep = false;
        body = [];
      } else if (keep) body.push(line);
      continue;
    }
    const m = line.match(HEREDOC_OPEN);
    const sink = m && depth < 3 ? heredocSink(line) : null;
    if (sink === 'eval') {
      // `eval "$(cat <<EOF`: its unclosed quote would swallow the body, so the
      // line is cut where `eval` starts; anything before it is kept.
      const e = line.search(/(^|[\s;&|(])eval(\s|$)/);
      out.push(e > 0 ? line.slice(0, e).replace(/[\s;&|]*$/, '') : '');
    } else out.push(line);
    if (m) {
      tag = m[2];
      keep = sink !== null;
      evalOpen = sink === 'eval';
    }
  }
  // Unterminated heredoc: the shell still runs what it read.
  if (keep && tag !== null) emitBody();
  return out.join('\n');
}

/**
 * Split into shell commands (word arrays), honouring quotes, dropping
 * comments. Each command is { words, sep } where sep is the separator that
 * ENDED it (';', '&&', '||', '|', '&', '\n', '(' or ')' or '' at the end).
 */
export function splitShellCommands(cmd, depth = 0) {
  const bodies = [];
  const stripped = stripHeredocs(String(cmd || ''), bodies, depth);
  const commands = [];
  for (const c of splitRaw(stripped)) {
    const m = c.words.length === 1 && c.words[0].startsWith(BODY_MARK) ? Number(c.words[0].slice(BODY_MARK.length)) : -1;
    if (m === -1) commands.push(c);
    else commands.push({ words: [], sep: '(' }, ...balanced(splitShellCommands(bodies[m], depth + 1)), { words: [], sep: ')' });
  }
  return expandStdinScripts(commands, depth);
}

/** Drop parens in a command list that have no partner in it (`case a)` in a script body). */
function balanced(commands) {
  const open = [];
  const keep = commands.map(() => true);
  commands.forEach((c, n) => {
    if (c.sep === '(') open.push(n);
    else if (c.sep === ')') {
      if (open.length) open.pop();
      else keep[n] = false;
    }
  });
  open.forEach((n) => { keep[n] = false; });
  return commands.filter((_, n) => keep[n]);
}

/**
 * Scripts handed to a shell on stdin without a heredoc: `bash <<< 'gh pr
 * create'` and `echo 'gh pr create' | bash`. Each is parsed as a nested script
 * inside its own `(` `)` scope, right after the shell command.
 */
function expandStdinScripts(commands, depth = 0) {
  if (depth >= 3) return commands;
  const out = [];
  commands.forEach((c, n) => {
    out.push(c);
    if (!readsScriptFromStdin(c.words)) return;
    let script = null;
    const hs = c.words.findIndex((w) => w.startsWith('<<<'));
    if (hs !== -1 && c.words[hs].length > 3) script = c.words[hs].slice(3);
    else if (hs !== -1 && c.words[hs + 1] !== undefined) script = c.words[hs + 1];
    else if (n > 0 && commands[n - 1].sep === '|') {
      const prev = commands[n - 1].words;
      const pi = skipWrappers(prev);
      const ph = path.basename(prev[pi] || '');
      if (ph === 'echo' || ph === 'printf') {
        const args = prev.slice(pi + 1).filter((w) => !/^-[neE]+$/.test(w));
        // printf FORMAT ARG…: the format is not the script once there are args.
        script = (ph === 'printf' && args.length > 1 ? args.slice(1) : args).join(' ');
      }
    }
    if (script) out.push({ words: [], sep: '(' }, ...balanced(splitShellCommands(script, depth + 1)), { words: [], sep: ')' });
  });
  return out;
}

/** The tokenizer under splitShellCommands, without the heredoc pass. */
function splitRaw(src) {
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
    // Descriptor duplication (2>&1, <&0) and Bash's &> are redirections,
    // not background separators. Consume the operator before splitting '&'.
    if (two === '>&' || two === '<&' || two === '&>') {
      word += two;
      inWord = true;
      i++;
      continue;
    }
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
  run(cmd, 0);
  return pushes;

  function run(src, depth) {
    const subshells = [];
    for (const { words, sep } of splitShellCommands(src)) {
      parseOne(words, depth);
      if (sep === '(') subshells.push({ cdDir, dirUnknown });
      else if (sep === ')' && subshells.length) ({ cdDir, dirUnknown } = subshells.pop());
    }
  }

  // `bash -c '…'`, `sh -lc '…'`, `eval '…'` (BRO-6017): the script word is parsed
  // as its own command string. Returns { script, subshell, repoCtx } or null.
  // bash: flags are scanned up to the first operand (a script file ends the scan,
  // so `bash x.sh -c '…'` is not a -c script); `-o`/`-O` clusters take a value.
  function nestedScript(words) {
    const k = skipWrappers(words);
    const h = path.basename(words[k] || '');
    // Wrapper/env context that moves or redirects the inner repo (GIT_DIR=…, env -C dir).
    const repoCtx = words.slice(0, k).some((w) => GIT_REPO_ENV.test(w) || w === '-C' || w === '--chdir' || w.startsWith('--chdir='));
    if (h === 'eval') {
      let j = k + 1;
      if (words[j] === '--') j++;
      return j < words.length ? { script: words.slice(j).join(' '), subshell: false, repoCtx } : null;
    }
    if (!SHELL_SINKS.has(h)) return null;
    let sawC = false;
    for (let n = k + 1; n < words.length; n++) {
      const w = words[n];
      if (w === '--') { n++; if (sawC && n < words.length) return { script: words[n], subshell: true, repoCtx }; break; }
      if (!/^[-+][A-Za-z]+$/.test(w) && !/^--[a-z-]+$/.test(w)) {
        if (sawC) return { script: w, subshell: true, repoCtx };
        break; // script-file operand
      }
      if (/^-[A-Za-z]*n/.test(w)) return null; // noexec
      if (/^-[A-Za-z]*c/.test(w)) sawC = true;
      if (/^[-+][A-Za-z]*[oO]$/.test(w)) n++; // option operand (`-o pipefail`)
    }
    return null;
  }

  function parseOne(words, depth = 0) {
    if (!words.length) return;
    const nested = depth < 6 ? nestedScript(words) : null;
    if (nested) {
      const saved = { cdDir, dirUnknown };
      if (nested.repoCtx) dirUnknown = true;
      run(nested.script, depth + 1);
      // eval runs in the current shell, so its cd carries out; bash -c does not.
      if (nested.subshell) ({ cdDir, dirUnknown } = saved);
      return;
    }
    let i = 0;
    let envRepo = false;
    for (; i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]); i++) {
      if (GIT_REPO_ENV.test(words[i])) envRepo = true; // FOO=bar prefixes
    }
    // `env git push`, `timeout 30 git push`, `command git push`: look past wrappers.
    const wk = skipWrappers(words.slice(i));
    if (wk > 0) {
      if (words.slice(i, i + wk).some((w) => GIT_REPO_ENV.test(w) || w === '-C' || w === '--chdir' || w.startsWith('--chdir='))) envRepo = true;
      i += wk;
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
