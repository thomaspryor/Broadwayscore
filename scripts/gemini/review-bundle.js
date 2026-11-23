/**
 * scripts/gemini/review-bundle.js: build the repository context that scripts/gemini/review.js
 * sends with each review in ONE request (BRO-8160).
 *
 * The old reviewer let the Gemini CLI browse the repo with file tools. Every tool turn re-sent the
 * whole conversation, so one review cost 0.6M to 6M input tokens (about $190 a day on Carbon). A
 * hand-built bundle of the same material is 5K to 45K tokens, and on planted bugs (an inverted
 * condition, minutes passed as seconds, a caller left on an old signature) one request caught all
 * three in 8 of 8 runs.
 *
 * What goes in, in order, until the character budget runs out:
 *   1. each changed file's current text, line-numbered, with the changed line ranges named
 *      (biggest change first). A file over FULL_FILE_CHARS gets windows around its changes instead.
 *   2. lines elsewhere in the repo that use names the change defines (git grep, tracked files).
 * Anything that does not fit is listed as OMITTED, and the prompt tells the model to name it under
 * NOT CHECKED: the review narrows visibly instead of stopping.
 *
 * Only tracked files are read, never one matching SECRET_RE, over MAX_FILE_BYTES, or binary: the
 * untracked tree can hold credential backups (.gitignore history), and everything here is sent to
 * Google. Git runs through spawnSync argument arrays, never a shell.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Key, certificate and env files by name, and a data/config file whose name mentions a secret.
// Source files (token-budget.js) are code and are sent; they are tracked, so already on GitHub.
const SECRET_RE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks))$|(^|\/)[^/]*(secret|credential|token|password)[^/]*?(\.(json|txt|ya?ml|ini|conf|cfg|bak|backup|old|csv|toml))?$/i;
const CODE_EXT_RE = /\.(c?js|mjs|tsx?|jsx|sh|py|md)$/i;
const isSecretPath = (p) => SECRET_RE.test(p) && !(CODE_EXT_RE.test(p) && !/(^|\/)(\.env|id_)/.test(p) && !/\.(pem|key|p12|pfx|keystore|jks)$/i.test(p));
const MAX_FILE_BYTES = 200 * 1024;
const FULL_FILE_CHARS = 60_000;
const WINDOW_PAD = 60;
const DEFAULT_BUDGET_CHARS = 480_000; // about 120K tokens, about $0.18 of input on gemini-3.8-flash
const CALLER_HITS_PER_NAME = 8;
const CALLER_LINES_MAX = 80;
const CALLER_HITS_SKIP = 200; // a name used this often is too generic to be a caller list
const MAX_PROMPT_PATHS = 40;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'async', 'await', 'constructor', 'require', 'module', 'exports', 'default', 'this', 'true', 'false', 'null', 'undefined', 'const', 'main']);

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || '', status: r.status, err: String(r.stderr || r.error || '').trim() };
}

/** `git diff --name-status -z` output -> [{ status, path, from }]. R/C entries carry the old path first. */
function parseNameStatus(z) {
  const tok = String(z || '').split('\0');
  const out = [];
  for (let i = 0; i < tok.length; i++) {
    const s = tok[i];
    if (!s) continue;
    const code = s[0];
    if (code === 'R' || code === 'C') { out.push({ status: code, from: tok[i + 1], path: tok[i + 2] }); i += 2; }
    else { out.push({ status: code, path: tok[i + 1] }); i += 1; }
  }
  return out.filter((e) => e.path);
}

/** `git diff -U0` text -> Map path -> [[start, end]] of changed lines in the NEW file. */
function parseHunks(diff) {
  const m = new Map();
  let cur = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++ ')) { cur = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, ''); if (cur && !m.has(cur)) m.set(cur, []); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      m.get(cur).push(n === 0 ? [start, start] : [start, start + n - 1]); // n=0: pure deletion after line `start`
    }
  }
  return m;
}

/** Names the change defines (from added lines of a unified diff), for the caller search. */
function definedNames(diff) {
  const names = new Set();
  const res = [
    /function\s*\*?\s*([A-Za-z_$][\w$]{3,})/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]{3,})\s*=/g,
    /exports\.([A-Za-z_$][\w$]{3,})/g,
    /export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z_$][\w$]{3,})/g,
    /class\s+([A-Za-z_$][\w$]{3,})/g,
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]{3,})\s*\([^)]*\)\s*\{\s*$/g, // object/class method
    /^\s*([A-Za-z_][\w]{3,})\s*\(\)\s*\{/g, // shell function
  ];
  for (const l of String(diff || '').split('\n')) {
    if (!l.startsWith('+') || l.startsWith('+++')) continue;
    const body = l.slice(1);
    for (const re of res) for (const m of body.matchAll(re)) if (!KEYWORDS.has(m[1])) names.add(m[1]);
  }
  return [...names];
}

/** Repo-relative paths a prompt names that are tracked files (plan-review has no base ref). */
function pathsFromPrompt(prompt, tracked) {
  const out = [];
  const seen = new Set();
  for (const m of String(prompt || '').matchAll(/(?:^|[\s`'"(\[])((?:\.\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z0-9]+)/g)) {
    const p = m[1].replace(/^\.\//, '').replace(/[.,;:]+$/, '');
    if (seen.has(p) || !tracked.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_PROMPT_PATHS) break;
  }
  return out;
}

const number = (lines, from, to) => {
  const w = String(to).length;
  const out = [];
  for (let i = from; i <= to; i++) out.push(`${String(i).padStart(w)}: ${lines[i - 1]}`);
  return out.join('\n');
};

/** Line-numbered windows around ranges (1-based, inclusive), merged when they overlap. */
function windows(text, ranges, pad = WINDOW_PAD) {
  const lines = String(text).split('\n');
  const spans = ranges.map(([a, b]) => [Math.max(1, a - pad), Math.min(lines.length, b + pad)]).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged.map(([a, b]) => number(lines, a, b)).join('\n...\n');
}

const fmtRanges = (r) => r.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');

/** Read a file for the bundle, or say why not. */
function readAllowed(root, p, tracked) {
  if (!tracked.has(p)) return { why: 'not a tracked file' };
  if (isSecretPath(p)) return { why: 'name looks like a secret, never sent' };
  let st;
  try { st = fs.statSync(path.join(root, p)); } catch { return { why: 'missing from the working tree' }; }
  if (!st.isFile()) return { why: 'not a regular file' };
  if (st.size > MAX_FILE_BYTES) return { why: `over ${MAX_FILE_BYTES / 1024}KB` };
  const buf = fs.readFileSync(path.join(root, p));
  if (buf.subarray(0, 8000).includes(0)) return { why: 'binary' };
  return { text: buf.toString('utf8') };
}

/**
 * Build the context block.
 * @param {object} o
 * @param {string} o.cwd       a directory inside the repository
 * @param {string} [o.base]    a ref: review the change BASE...HEAD plus uncommitted tracked edits
 * @param {string} [o.prompt]  without base, the files the prompt names are bundled (plan-review)
 * @param {number} [o.budgetChars]
 * @returns {{ text, given: string[], partial: string[], omitted: {path, why}[], deleted: string[], callerLines: number } | { error }}
 */
function buildBundle({ cwd, base, prompt = '', budgetChars = DEFAULT_BUDGET_CHARS }) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) return { error: 'not inside a git repository' };
  const root = top.out.trim();
  const ls = git(['ls-files', '-z'], root);
  if (!ls.ok) return { error: `git ls-files failed: ${ls.err.slice(0, 200)}` };
  const tracked = new Set(ls.out.split('\0').filter(Boolean));

  let files = []; // [{ path, weight, ranges }]
  const deleted = [];
  let diffText = '';
  if (base) {
    if (!git(['rev-parse', '--verify', '-q', `${base}^{commit}`], root).ok) return { error: `base ref '${base}' does not resolve to a commit` };
    const mb = git(['merge-base', base, 'HEAD'], root);
    if (!mb.ok) return { error: `no merge base between '${base}' and HEAD (shallow clone? fetch more history)` };
    const fork = mb.out.trim();
    // fork..working tree covers committed and uncommitted edits to tracked files in one pass.
    const ns = git(['diff', '--name-status', '-z', '-M', fork, '--'], root);
    if (!ns.ok) return { error: `git diff --name-status failed: ${ns.err.slice(0, 200)}` };
    const num = git(['diff', '--numstat', '-z', '-M', fork, '--'], root);
    const weight = new Map();
    // numstat -z: "add\tdel\tpath\0" or, for a rename, "add\tdel\t\0old\0new\0"
    const nt = num.out.split('\0');
    for (let i = 0; i < nt.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(nt[i]);
      if (!m) continue;
      let p = m[3];
      if (!p) { p = nt[i + 2]; i += 2; }
      weight.set(p, (Number(m[1]) || 0) + (Number(m[2]) || 0));
    }
    diffText = git(['diff', '-U0', '-M', fork, '--'], root).out;
    const hunks = parseHunks(diffText);
    for (const e of parseNameStatus(ns.out)) {
      if (e.status === 'D') { deleted.push(e.path); continue; }
      files.push({ path: e.path, weight: weight.get(e.path) || 0, ranges: hunks.get(e.path) || [] });
    }
    files.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  } else {
    files = pathsFromPrompt(prompt, tracked).map((p) => ({ path: p, weight: 0, ranges: [] }));
  }

  const parts = [];
  const given = [];
  const partial = [];
  const omitted = [];
  let left = budgetChars;
  for (const f of files) {
    const r = readAllowed(root, f.path, tracked);
    if (!r.text) { omitted.push({ path: f.path, why: r.why }); continue; }
    const lines = r.text.split('\n');
    const head = `=== FILE ${f.path} (${lines.length} lines${f.ranges.length ? `; changed lines ${fmtRanges(f.ranges)}` : ''}) ===\n`;
    if (r.text.length <= FULL_FILE_CHARS) {
      const block = head + number(lines, 1, lines.length) + '\n';
      if (block.length <= left) { parts.push(block); given.push(f.path); left -= block.length; continue; }
    }
    if (f.ranges.length) {
      const block = head.replace(') ===', '; only the changed parts are shown) ===') + windows(r.text, f.ranges) + '\n';
      if (block.length <= left) { parts.push(block); partial.push(f.path); left -= block.length; continue; }
    }
    omitted.push({ path: f.path, why: r.text.length > FULL_FILE_CHARS && !f.ranges.length ? 'too big to send whole' : 'did not fit the review budget' });
  }

  let callerLines = 0;
  if (base && diffText) {
    const inBundle = new Set(files.map((f) => f.path));
    const blocks = [];
    for (const name of definedNames(diffText)) {
      if (callerLines >= CALLER_LINES_MAX) break;
      // -e keeps a name that starts with '-' from being read as an option; names come from regexes that never allow one anyway.
      const g = git(['grep', '-n', '-w', '-I', '-e', name, '--'], root);
      if (!g.ok) continue; // exit 1 = no hits
      const hits = g.out.split('\n').filter(Boolean)
        .filter((h) => { const p = h.slice(0, h.indexOf(':')); return !inBundle.has(p) && !isSecretPath(p); });
      if (!hits.length || hits.length > CALLER_HITS_SKIP) continue;
      const take = hits.slice(0, Math.min(CALLER_HITS_PER_NAME, CALLER_LINES_MAX - callerLines)).map((h) => (h.length > 240 ? h.slice(0, 240) + ' ...' : h));
      blocks.push(`-- uses of ${name}${hits.length > take.length ? ` (${take.length} of ${hits.length})` : ''} --\n${take.join('\n')}`);
      callerLines += take.length;
    }
    if (blocks.length) {
      const block = `=== USES ELSEWHERE (path:line: text, files this change does not touch) ===\n${blocks.join('\n')}\n`;
      if (block.length <= left) { parts.push(block); left -= block.length; }
      else { omitted.push({ path: '(uses of the changed names elsewhere in the repo)', why: 'did not fit the review budget' }); callerLines = 0; }
    }
  }

  const intro = [
    '=== REPOSITORY CONTEXT (added by the review tool) ===',
    'You have no tools. Below is the current text of the files this review is about, line-numbered (cite these numbers),'
      + (base ? ' with the changed line ranges named, then lines elsewhere in the repository that use names the change defines.' : '.'),
    'Check each claim against this text before you make it. If something you need is not here, do not guess: name it under NOT CHECKED.',
  ];
  if (deleted.length) intro.push(`DELETED by this change (see the diff): ${deleted.join(', ')}`);
  if (omitted.length) intro.push(`OMITTED (not given to you; list each under NOT CHECKED): ${omitted.map((o) => `${o.path} (${o.why})`).join('; ')}`);
  if (!given.length && !partial.length) intro.push('No repository files were attached.');
  const text = `${intro.join('\n')}\n\n${parts.join('\n')}=== END OF REPOSITORY CONTEXT ===\nEnd your answer with "NOT CHECKED:" listing what you could not verify from the material given (or "nothing").\n`;
  return { text, given, partial, omitted, deleted, callerLines };
}

module.exports = {
  buildBundle, parseNameStatus, parseHunks, definedNames, pathsFromPrompt, windows, readAllowed,
  SECRET_RE, isSecretPath, MAX_FILE_BYTES, FULL_FILE_CHARS, DEFAULT_BUDGET_CHARS,
};
