// Resolve the repositories of shell push/merge commands without executing them.
// Unknown command contexts stay in scope; exemptions require every target to
// resolve outside the guarded repository family.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitShellCommands, skipWrappers } from './push-command.mjs';
import { isMainModule } from './is-main-module.mjs';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const CONTROL_WORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until', 'do', 'done', 'select']);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// A generated script is understood only when a literal, standalone cat heredoc
// is immediately run by a shell. Other file writes are never assumed executable.
function inlineGeneratedScripts(command) {
  const lines = command.split('\n');
  const out = [];
  for (let n = 0; n < lines.length; n++) {
    const m = lines[n].match(/^\s*cat\s+>\s+(.+?)\s+<<(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*$/);
    const opener = m && splitShellCommands(lines[n]);
    if (!m || opener.length !== 1 || opener[0].words.length !== 4 || opener[0].words[1] !== '>'
        || /[$`*?]/.test(opener[0].words[2])) {
      out.push(lines[n]);
      continue;
    }
    const end = lines.findIndex((line, i) => i > n && line === m[3]);
    const next = end >= 0 ? splitShellCommands(lines[end + 1] || '') : [];
    if (next.length === 1 && next[0].words.length === 2 && SHELLS.has(next[0].words[0])
        && next[0].words[1] === opener[0].words[2]) {
      out.push(`${next[0].words[0]} -c ${quote(lines.slice(n + 1, end).join('\n'))}`);
      n = end + 1;
    } else out.push(lines[n]);
  }
  return out.join('\n');
}

function git(dir, args) {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export function resolveCommandRepo(command, { cwd, canonicalRoot = cwd, operation = 'push', home = os.homedir() }) {
  const targets = [];
  const canonicalCommon = git(canonicalRoot, ['rev-parse', '--git-common-dir']);
  const common = canonicalCommon && path.resolve(canonicalRoot, canonicalCommon);
  function directory(d, state) {
    if (d === '~') d = home;
    else if (d?.startsWith('~/')) d = path.join(home, d.slice(2));
    if (!d || d === '-' || /[$`]/.test(d) || d.startsWith('~')) return null;
    return path.resolve(state.dir, d);
  }
  function record(state) {
    const top = !state.unknown && !state.uncertain && git(state.dir, ['rev-parse', '--show-toplevel']);
    const c = top && git(top, ['rev-parse', '--git-common-dir']);
    targets.push({ top, external: Boolean(common && c && path.resolve(top, c) !== common) });
  }
  function scan(src, state, depth = 0) {
    if (depth > 6) { targets.push({ external: false }); return; }
    const scopes = [];
    const commands = splitShellCommands(inlineGeneratedScripts(src)).map((c) => ({
      ...c, words: c.words.filter((w) => !/^(?:\d+)?[<>]&(?:\d+|-)$/.test(w)),
    }));
    // Pipes, background pushes and retry lists preserve an already known cwd.
    // Only directory changes in those constructs are uncertain. Attach that
    // uncertainty to actual operations rather than inventing an extra target
    // that would send an otherwise external push back to the session root.
    const heads = commands.map(({ words }) => words[skipWrappers(words)]);
    const changes = heads.map((head) => ['cd', 'eval', 'source', '.', 'pushd', 'popd'].includes(head));
    const uncertainAt = new Set();
    let afterOr = false;
    let afterConditional = false;
    let listStart = 0;
    commands.forEach(({ sep }, n) => {
      if (CONTROL_WORDS.has(heads[n])
          || (changes[n] && (sep === '|' || commands[n - 1]?.sep === '|' || afterOr || afterConditional))) {
        uncertainAt.add(n);
      }
      if (sep === '&') {
        for (let i = listStart; i <= n; i++) if (changes[i]) uncertainAt.add(i);
      }
      if (sep === '||') afterOr = true;
      else if (sep === '&&' && heads[n] !== 'cd') afterConditional = true;
      if (!['&&', '||', '|'].includes(sep)) {
        afterOr = false;
        afterConditional = false;
        listStart = n + 1;
      }
    });
    for (const [n, { words: all, sep }] of commands.entries()) {
      // A later ambiguous cd cannot change an operation already recorded.
      if (uncertainAt.has(n)) state.uncertain = true;
      const k = skipWrappers(all);
      const words = all.slice(k);
      const head = path.basename(words[0] || '');
      const wrapped = all.slice(0, k).some((w) => /^(GIT_DIR|GIT_WORK_TREE)=/.test(w) || w === '-C' || /^--chdir(?:=|$)/.test(w));
      if (wrapped) targets.push({ external: false });
      if (head === 'cd') {
        const raw = words[1] === '--' ? words[2] : words[1];
        const d = directory(raw, state);
        if (!d) state.unknown = true;
        else if (fs.existsSync(d)) {
          state.dir = d;
          state.unknown = state.unknown && !(path.isAbsolute(raw) || raw === '~' || raw.startsWith('~/'));
        }
        if (sep === '&&' && (!d || !fs.existsSync(d))) targets.push({ external: false });
      } else if (head === 'pushd' || head === 'popd') state.unknown = true;
      else if (head === '.' || head === 'source') {
        state.unknown = true;
        targets.push({ external: false }); // the sourced file can itself push
      }
      else if (head === 'eval') {
        if (words.slice(1).some((w) => /[$`]/.test(w))) targets.push({ external: false });
        scan(words.slice(1).join(' '), state, depth + 1);
      }
      else if (SHELLS.has(head)) {
        const helper = ['push-with-retry.sh', 'merge-worktree-to-main.sh'].includes(path.basename(words[1] || ''));
        if (helper) {
          record({ ...state, unknown: state.unknown || wrapped });
        }
        let script = null;
        let sawC = false;
        for (let i = 1; i < words.length; i++) {
          const w = words[i];
          if (w === '--') { if (sawC) script = words[i + 1]; break; }
          if (!/^[-+][A-Za-z]+$/.test(w) && !/^--[a-z-]+$/.test(w)) {
            if (sawC) script = w;
            break; // a script-file operand ends option parsing
          }
          if (/^-[A-Za-z]*n/.test(w)) break; // noexec
          if (/^-[A-Za-z]*c/.test(w)) sawC = true;
          if (/^[-+][A-Za-z]*[oO]$/.test(w)) i++; // shell option operand
        }
        if (script) scan(script, { ...state, unknown: state.unknown || wrapped }, depth + 1);
        else if (!helper) targets.push({ external: false });
      } else if (head === 'git') {
        const at = { ...state, unknown: state.unknown || wrapped };
        let i = 1;
        for (; i < words.length && words[i].startsWith('-'); i++) {
          const flag = words[i];
          if (flag === '-C') {
            const d = directory(words[++i], at);
            if (d) at.dir = d; else at.unknown = true;
          } else if (/^--(git-dir|work-tree)(=|$)/.test(flag)) at.unknown = true;
          else if (['-c', '--namespace', '--exec-path', '--config-env'].includes(flag)) i++;
        }
        if (words[i] === operation) record(at);
      } else if (['push-with-retry.sh', 'merge-worktree-to-main.sh'].includes(head)
          || (head === 'gh' && words[1] === 'pr' && words[2] === 'merge')) record({ ...state, unknown: state.unknown || wrapped });
      if (sep === '(') scopes.push({ ...state });
      else if (sep === ')' && scopes.length) Object.assign(state, scopes.pop());
    }
  }
  scan(String(command || ''), { dir: cwd, unknown: false });
  const own = targets.find((t) => t.top && !t.external);
  return { outOfScope: targets.length > 0 && targets.every((t) => t.external), evalRoot: own?.top || cwd };
}

if (isMainModule(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)];
  }));
  process.stdout.write(JSON.stringify(resolveCommandRepo(args.command, {
    cwd: args.cwd || process.cwd(), canonicalRoot: args['canonical-root'], operation: args.operation,
  })) + '\n');
}
