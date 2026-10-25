// pr-command.mjs — find the GitHub PR writes (open / mark ready / merge) inside
// a shell command string (a Claude Bash tool call), and refuse the ones aimed
// at thomaspryor/Broadwayscore (BRO-5915).
//
// Sessions never open, ready or merge Broadwayscore PRs: the owner never
// reviews or merges them, and work lands via
// `git push origin HEAD:refs/heads/land/<name>`. Cloud sessions twice left
// draft PRs parked on the owner anyway. The MCP route is refused by
// .claude/hooks/github-main-guard.sh; this file covers the Bash routes:
//   gh pr create|ready|merge
//   gh api … repos/O/R/pulls (POST) / …/pulls/N/merge (PUT) / graphql mutations
//   curl … api.github.com/repos/O/R/pulls (POST) / …/merge (PUT)
//   gh api / curl -X PATCH …/pulls/N with draft=false (undrafting = ready)
//   curl … api.github.com/graphql carrying a PR mutation
//   gh api graphql --input FILE / -F query=@FILE (the file is read; a file not
//     there yet, written earlier in the same command, falls back to scanning
//     the whole command for a PR mutation)
//   hub pull-request, hub api (as gh api)
//   `bash <<EOF … EOF`, `bash <<< '…'` and `echo '…' | bash` bodies (BRO-5932,
//     via push-command.mjs's splitter)
//
// NOT covered, on purpose (BRO-5932): a node/python/ruby script that calls the
// GitHub API itself, a script file written and run in separate commands, and
// a GraphQL mutation scoped by repository id rather than by cwd/GH_REPO.
//
// Commands are split with push-command.mjs's splitShellCommands (quotes,
// separators, comments, heredocs), so a mention inside an echo, grep pattern
// or commit message is never a write, and each command is judged on its own
// arguments. `cd` (subshell-scoped) and `bash -c '…'` are followed.
//
// CLI (PreToolUse hook, called from .claude/hooks/pr-write-guard.sh):
//   node scripts/lib/pr-command.mjs --hook   < hook JSON on stdin
// exits 2 with the refusal on stderr, else 0. Fails open on any error.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './is-main-module.mjs';
import { splitShellCommands } from './push-command.mjs';

export const GUARDED_REPO = 'thomaspryor/broadwayscore';

// Words that run the next word as the command (shell keywords included, so
// `if x; then gh pr create; fi` and `{ gh pr create; }` are seen).
const PREFIX_WORDS = new Set(['command', 'time', 'exec', 'nohup', 'builtin', 'xargs', 'then', 'do', 'else', 'elif', '{', '!']);
// Prefixes that take a positional or valued argument of their own before the
// real command, so the flags-only skip above would stop on it and miss the
// `gh` behind it (ship-check round 2: `timeout 30 gh pr create` was allowed).
const TIMEOUT_WORDS = new Set(['timeout', 'gtimeout']);
const TIMEOUT_VALUE_FLAG = /^(-k|--kill-after|-s|--signal)$/;
const NICE_VALUE_FLAG = /^(-n|--adjustment)$/;
const DURATION = /^[0-9]+(\.[0-9]+)?[smhd]?$/;
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const OVERRIDE_ASSIGN = /^(LAND_ENFORCE_OFF|PR_GUARD_OFF)=1$/;
const GH_API_WITH_VALUE = new Set(['-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);
const GH_API_FIELD = new Set(['-f', '-F', '--field', '--raw-field', '--input']);
const CURL_DATA = /^(-d|--data(-[a-z]+)?|--json|-F|--form(-string)?|-T|--upload-file)$/;
const PULLS_PATH = /(?:^|\/)repos\/([^/\s?]+)\/([^/\s?]+)\/pulls(\/\d+\/merge|\/\d+)?\/?(?:\?.*)?$/;
// `-f draft=false` (the whole field) or a JSON body's "draft": false; not free text that mentions it.
const UNDRAFT = /^draft=false$|["']draft["']\s*:\s*false/i;
const UNDRAFT_ANYWHERE = /\bdraft["']?\s*[:=]\s*false/i;
const MAX_PAYLOAD_BYTES = 1 << 20;
const PR_URL = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/;
const GRAPHQL_WRITE = /\b(createPullRequest|markPullRequestReadyForReview|mergePullRequest|enablePullRequestAutoMerge)\b/;

const baseName = (w) => path.basename(String(w || ''));

/** "owner/repo" lower-cased from a remote URL, a -R value or an owner/repo pair; null if none. */
export function normalizeRepo(s) {
  if (!s) return null;
  let r = String(s).trim().toLowerCase().replace(/\.git\/?$/, '').replace(/\/$/, '');
  const m = r.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/) || r.match(/^(?:[^/\s:]+\/)?([^/\s:]+)\/([^/\s:]+)$/);
  if (!m) return null;
  r = `${m[1]}/${m[2]}`;
  return r;
}

/**
 * Every PR write in the command, in order:
 *   { verb, repo: explicit "owner/repo" or null, ghRepoEnv, cdDir, dirUnknown, override }
 * repo null means "the repo of the directory the command runs in" (cdDir, or
 * the caller's cwd when cdDir is null), after ghRepoEnv for gh commands.
 */
export function parsePrWrites(cmd, { home = os.homedir(), depth = 0, cwd = process.cwd(), rawText = String(cmd || '') } = {}) {
  const writes = [];
  let cdDir = null;
  let dirUnknown = false;
  const subshells = [];
  for (const { words, sep } of splitShellCommands(cmd)) {
    parseOne(words);
    if (sep === '(') subshells.push({ cdDir, dirUnknown });
    else if (sep === ')' && subshells.length) ({ cdDir, dirUnknown } = subshells.pop());
  }
  return writes;

  function parseOne(all) {
    let i = 0;
    let ghRepoEnv = null;
    let override = false;
    const takeAssigns = () => {
      for (; i < all.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[i]); i++) {
        if (all[i].startsWith('GH_REPO=')) ghRepoEnv = all[i].slice('GH_REPO='.length);
        if (OVERRIDE_ASSIGN.test(all[i])) override = true;
      }
    };
    takeAssigns();
    for (;;) {
      const w = baseName(all[i]);
      if (w === 'env') {
        i++;
        while (i < all.length && all[i].startsWith('-')) i += /^(-u|--unset|-C|--chdir|-S|--split-string)$/.test(all[i]) ? 2 : 1;
        takeAssigns();
      } else if (TIMEOUT_WORDS.has(w)) {
        i++;
        while (i < all.length && all[i].startsWith('-')) i += TIMEOUT_VALUE_FLAG.test(all[i]) ? 2 : 1;
        if (i < all.length && DURATION.test(all[i])) i++;
      } else if (w === 'sudo' || w === 'doas') {
        i++;
        while (i < all.length && all[i].startsWith('-')) i += /^(-u|--user|-g|--group|-C|-h|--host|-p|--prompt|-r|-t|-U)$/.test(all[i]) ? 2 : 1;
      } else if (w === 'nice') {
        i++;
        while (i < all.length && all[i].startsWith('-')) i += NICE_VALUE_FLAG.test(all[i]) ? 2 : 1;
      } else if (PREFIX_WORDS.has(w)) {
        i++;
        while (i < all.length && all[i].startsWith('-')) i++;
      } else break;
    }
    const words = all.slice(i);
    if (!words.length) return;
    const head = baseName(words[0]);
    if (head === 'cd') {
      let d = words[1];
      if (d === '~' || (d && d.startsWith('~/'))) d = path.join(home, d.slice(1));
      if (!d || d === '-' || d.includes('$') || d.startsWith('~')) dirUnknown = true;
      else if (path.isAbsolute(d)) { cdDir = d; dirUnknown = false; }
      else cdDir = cdDir ? path.join(cdDir, d) : d;
      return;
    }
    if (head === 'pushd' || head === 'popd') { dirUnknown = true; return; }
    const at = { ghRepoEnv, cdDir, dirUnknown, override };
    if (head === 'eval' && depth < 3 && words[1]) {
      // `eval "gh pr create"`: the script is the next word, same as bash -c.
      for (const inner of parsePrWrites(words[1], { home, depth: depth + 1, cwd, rawText })) {
        writes.push({
          ...inner,
          ghRepoEnv: inner.ghRepoEnv ?? ghRepoEnv,
          cdDir: inner.cdDir ? (path.isAbsolute(inner.cdDir) || !cdDir ? inner.cdDir : path.join(cdDir, inner.cdDir)) : cdDir,
          dirUnknown: inner.dirUnknown || dirUnknown,
          override: inner.override || override,
        });
      }
      return;
    }
    if (SHELLS.has(head) && depth < 3) {
      // bash -c '…' / bash -lc '…': the script is the word after the c-flag.
      const ci = words.findIndex((x, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(x));
      if (ci > 0 && words[ci + 1]) {
        for (const inner of parsePrWrites(words[ci + 1], { home, depth: depth + 1, cwd, rawText })) {
          writes.push({
            ...inner,
            ghRepoEnv: inner.ghRepoEnv ?? ghRepoEnv,
            cdDir: inner.cdDir ? (path.isAbsolute(inner.cdDir) || !cdDir ? inner.cdDir : path.join(cdDir, inner.cdDir)) : cdDir,
            dirUnknown: inner.dirUnknown || dirUnknown,
            override: inner.override || override,
          });
        }
      }
      return;
    }
    if (head === 'gh') return gh(words.slice(1), at);
    if (head === 'hub') {
      if (words[1] === 'pull-request') { writes.push({ verb: 'hub pull-request', repo: null, ...at }); return; }
      if (words[1] === 'api') return gh(words.slice(1), at);
      return;
    }
    if (head === 'curl') return curl(words.slice(1), at);
  }

  function gh(args, at) {
    let k = 0;
    // `-R`/`--repo` can precede the subcommand, and its VALUE is a bare word:
    // skipping only the flag made `gh -R owner/repo pr create` parse
    // "owner/repo" as the subcommand and sail through (ship-check round 2).
    while (k < args.length && args[k].startsWith('-')) k += (args[k] === '-R' || args[k] === '--repo') ? 2 : 1;
    const sub = args[k];
    const rest = args.slice(k + 1);
    if (sub === 'pr') {
      const verb = rest.find((x) => !x.startsWith('-'));
      if (!['create', 'ready', 'merge'].includes(verb)) return;
      let repo = null;
      for (let j = 0; j < args.length; j++) {
        const a = args[j];
        if (a === '-R' || a === '--repo') repo = args[j + 1];
        else if (/^(-R|--repo)=/.test(a)) repo = a.slice(a.indexOf('=') + 1);
        else if (/^-R./.test(a)) repo = a.slice(2);
        else if (!repo && PR_URL.test(a)) { const m = a.match(PR_URL); repo = `${m[1]}/${m[2]}`; }
      }
      writes.push({ verb: `gh pr ${verb}`, repo: normalizeRepo(repo), ...at });
      return;
    }
    if (sub !== 'api') return;
    let method = null;
    let fields = false;
    let endpoint = null;
    const payload = [];
    let fileInput = false;
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      const eq = a.match(/^(--method|-X)=?(.+)$/);
      if (a === '-X' || a === '--method') { method = String(rest[j + 1] || '').toUpperCase(); j++; continue; }
      if (eq && !a.startsWith('-X-')) { method = eq[2].toUpperCase(); continue; }
      if (GH_API_FIELD.has(a) || /^(--field|--raw-field|--input)=/.test(a)) {
        fields = true;
        const v = String(GH_API_FIELD.has(a) ? rest[++j] : a.slice(a.indexOf('=') + 1));
        if (a === '--input' || a.startsWith('--input=')) { payload.push(fileText(v, at)); fileInput = true; continue; }
        // `-F query=@q.graphql` reads the file; `-f draft=false` is the value itself.
        const at_ = v.match(/^[^=]*=@(.+)$/);
        if (at_) { payload.push(fileText(at_[1], at)); fileInput = true; } else payload.push(v);
        continue;
      }
      if (GH_API_WITH_VALUE.has(a)) { j++; continue; }
      if (!a.startsWith('-') && endpoint === null) endpoint = a;
    }
    if (!endpoint) return;
    method = method || (fields ? 'POST' : 'GET');
    if (endpoint === 'graphql') {
      graphqlWriteIf(payload, fileInput, 'gh api graphql', at);
      return;
    }
    pullsWrite(endpoint, method, 'gh api', at, payload, fileInput);
  }

  function curl(args, at) {
    let method = null;
    let data = false;
    let url = null;
    let graphql = false;
    let fileInput = false;
    const payload = [];
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === '-X' || a === '--request') { method = String(args[j + 1] || '').toUpperCase(); j++; continue; }
      const eq = a.match(/^(?:-X|--request=)(.+)$/);
      if (eq) { method = eq[1].toUpperCase(); continue; }
      if (CURL_DATA.test(a) || /^--(data(-[a-z]+)?|json|form)=/.test(a)) {
        data = true;
        const v = String(/^--[a-z-]+=/.test(a) ? a.slice(a.indexOf('=') + 1) : args[++j] || '');
        if (v.startsWith('@')) { payload.push(fileText(v.slice(1), at)); fileInput = true; } else payload.push(v);
        continue;
      }
      if (/api\.github\.com\/graphql/.test(a)) graphql = true;
      else if (/api\.github\.com\/repos\//.test(a)) url = a.replace(/^https?:\/\/api\.github\.com\//, '');
    }
    if (graphql) { graphqlWriteIf(payload, fileInput, 'curl graphql', at); return; }
    if (!url) return;
    pullsWrite(url, method || (data ? 'POST' : 'GET'), 'curl', at, payload, fileInput);
  }

  /** Contents of a payload file, or null when it cannot be read (not there yet, too big, a directory). */
  function fileText(file, at) {
    try {
      const f = path.resolve(at.cdDir && !at.dirUnknown ? path.resolve(cwd, at.cdDir) : cwd, file);
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > MAX_PAYLOAD_BYTES) return null; // /dev/zero and FIFOs never end
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  }

  // A payload file that could not be read may have been written earlier in the
  // same command (a heredoc `cat > q.json`), so the whole command is the next
  // best evidence.
  function judge(payload, fileInput, re, anywhere = re) {
    if (payload.some((t) => t !== null && re.test(t))) return true;
    return fileInput && payload.some((t) => t === null) && anywhere.test(rawText);
  }

  function graphqlWriteIf(payload, fileInput, via, at) {
    if (judge(payload, fileInput, GRAPHQL_WRITE)) writes.push({ verb: `a PR write through ${via}`, repo: null, ...at });
  }

  function pullsWrite(endpoint, method, via, at, payload = [], fileInput = false) {
    const m = String(endpoint).replace(/^\//, '').match(PULLS_PATH);
    if (!m) return;
    const repo = m[1].includes('{') ? null : normalizeRepo(`${m[1]}/${m[2]}`);
    const isMerge = Boolean(m[3]) && m[3].endsWith('/merge');
    const isOne = Boolean(m[3]) && !isMerge;
    if (isOne) {
      // PATCH /pulls/N with draft=false marks the PR ready for review.
      if (method === 'PATCH' && judge(payload, fileInput, UNDRAFT, UNDRAFT_ANYWHERE)) writes.push({ verb: `a PR ready through ${via}`, repo, ...at });
      return;
    }
    if ((!isMerge && method === 'POST') || (isMerge && method === 'PUT')) {
      writes.push({ verb: `a PR ${isMerge ? 'merge' : 'create'} through ${via}`, repo, ...at });
    }
  }
}

function originRepo(dir) {
  try {
    return normalizeRepo(execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

/**
 * The first refused write, or null. Repo resolution per write: explicit
 * (-R / --repo / PR URL / API path), else GH_REPO (prefix, then env) for gh,
 * else the origin of the directory it runs in (an unknowable cd falls back to
 * the cwd: conservative, since the session's own repo is the likely target).
 */
export function refusedPrWrite(command, { cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  if (env.LAND_ENFORCE_OFF === '1' || env.PR_GUARD_OFF === '1') return null;
  if (fs.existsSync(path.join(home, '.claude', 'LAND_ENFORCE_OFF')) || fs.existsSync(path.join(home, '.claude', 'PR_GUARD_OFF'))) return null;
  for (const w of parsePrWrites(command, { home, cwd })) {
    if (w.override) continue;
    let repo = w.repo;
    if (!repo && !w.verb.startsWith('a PR') && !w.verb.includes('graphql')) repo = normalizeRepo(w.ghRepoEnv);
    if (!repo && w.verb.startsWith('gh')) repo = normalizeRepo(env.GH_REPO);
    if (!repo && w.verb.includes('graphql')) repo = normalizeRepo(w.ghRepoEnv) || normalizeRepo(env.GH_REPO);
    if (!repo) {
      const dir = w.cdDir && !w.dirUnknown ? path.resolve(cwd, w.cdDir) : cwd;
      repo = originRepo(dir);
    }
    if (repo === GUARDED_REPO) return { ...w, repo };
  }
  return null;
}

export function refusalMessage(w) {
  return `🛑 BLOCKED: sessions never open, ready or merge Broadwayscore PRs (BRO-5915, refused: ${w.verb}). The owner never reviews or merges PRs. Land the work yourself: git push origin HEAD:refs/heads/land/<name>, then follow the Land run to green (CLOUD.md § Landing). Emergency override only: PR_GUARD_OFF=1 (this check only) or LAND_ENFORCE_OFF=1 (all land guards).`;
}

if (isMainModule(import.meta.url) && process.argv.includes('--hook')) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const command = input?.tool_input?.command;
    // The hook JSON carries the session's cwd; prefer it over this process's
    // own. They are usually the same, but repo scoping for a command that
    // names no repo reads the cwd's origin remote, so taking the session's
    // answer keeps the decision right wherever the hook happens to be spawned
    // from (BRO-5926).
    const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const hit = command ? refusedPrWrite(command, { cwd }) : null;
    if (hit) {
      process.stderr.write(refusalMessage(hit) + '\n');
      process.exit(2);
    }
  } catch {
    // fail open
  }
  process.exit(0);
}
