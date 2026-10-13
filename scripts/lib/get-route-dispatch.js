/**
 * BRO-5262: flag Next.js API routes whose GET handler dispatches a GitHub
 * workflow. Mail-security link scanners and preview fetchers open every URL
 * in an email, so a state-changing GET lets a robot approve or start work
 * with nobody tapping. The safe shape (src/app/api/autonomous-action,
 * approve-fix, dispatch-alert-fix): GET renders a confirm form, only POST acts.
 *
 * Static, regex-level analysis: find the exported GET handler, follow calls
 * into same-file top-level functions transitively, and look for a workflow
 * dispatch (`/dispatches` or `workflow_dispatch`) anywhere on that path.
 * Covers GET and HEAD, wrapped exports and function expressions.
 * Limit: calls are followed within the route file only. A shared src/lib
 * dispatch helper imported by a GET would not be seen (none exists today).
 * CLI: scripts/audit-get-route-dispatch.js. Test: get-route-dispatch.test.mjs.
 */
'use strict';

const DISPATCH_RE = /\/dispatches\b|workflow_dispatch/;

// Routes allowed to dispatch from GET, each with the reason it is safe (or
// the card that retires it). Keyed by repo-relative path.
const ALLOWLIST = {
  'src/app/api/admin/gmail-reauth/callback/route.ts':
    'OAuth redirect target: Google can only return the user by GET. Never emailed, and gated on the state cookie the start step set in the owner\'s own browser, so a scanner fetching it is refused before any dispatch.',
};

// Return the text of the balanced {...} block starting at the first '{' at or
// after `from`, or null. Skips string, template and comment contents well
// enough for route files (CSS braces inside HTML strings are skipped too).
function blockFrom(src, from) {
  const open = src.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i === -1) break; i += 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '`') {
      // Template literal: skip text, but count ${ ... } expressions as code.
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          const inner = blockFrom(src, i + 1);
          if (inner == null) return null;
          i = i + 1 + inner.length;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
    i++;
  }
  return null;
}

// Top-level named functions: `function x(`, `async function x(`, `const x = (...) =>`.
function topLevelFunctions(src) {
  const fns = new Map();
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b[^(]*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1] || m[2] || m[3];
    // Skip the parameter list (may contain `{` in destructuring/types) by
    // starting the body search after the closing paren of the signature.
    const sigEnd = findSignatureEnd(src, m.index + m[0].length - 1);
    const body = blockFrom(src, sigEnd);
    if (body) fns.set(name, body);
  }
  return fns;
}

function findSignatureEnd(src, from) {
  // Walk to the matching ')' of the parameter list if we are on '(' .
  let i = src.indexOf('(', from);
  if (i === -1 || i > from + 2) return from;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return from;
}

const SAFE_VERBS = ['GET', 'HEAD'];

/**
 * Names of the functions exported as GET or HEAD (scanners send both). A
 * wrapped export (`export const GET = withAuth(handler)`) is recorded as a
 * pseudo-function whose body is the wrapper expression, so the walk follows
 * into `handler`.
 */
function safeVerbHandlers(src, fns, wrappers) {
  const names = [];
  for (const verb of SAFE_VERBS) {
    if (fns.has(verb)) { names.push(verb); continue; }
    const wrapped = src.match(new RegExp(`^export\\s+const\\s+${verb}\\s*=\\s*([^;]+);?`, 'm'));
    if (wrapped) { fns.set(verb, `{ ${wrapped[1]} }`); wrappers.add(verb); names.push(verb); continue; }
    const alias = src.match(new RegExp(`export\\s*\\{[^}]*\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${verb}\\b[^}]*\\}`));
    if (alias) names.push(alias[1]);
  }
  return names;
}

/**
 * @returns {{ hasGet: boolean, dispatches: boolean, path: string[] }}
 * path = the chain of function names from GET to the one that dispatches.
 */
function analyzeRoute(src) {
  const fns = topLevelFunctions(src);
  const wrappers = new Set();
  const handlers = safeVerbHandlers(src, fns, wrappers);
  if (!handlers.length) return { hasGet: false, dispatches: false, path: [] };
  const seen = new Set();
  const visit = (fn, chain) => {
    if (seen.has(fn)) return null;
    seen.add(fn);
    const body = fns.get(fn);
    if (!body) return null;
    if (DISPATCH_RE.test(body)) return [...chain, fn];
    for (const callee of fns.keys()) {
      if (callee === fn) continue;
      // A wrapper export passes its handler by reference, so any mention counts.
      const ref = callee.replace(/\$/g, '\\$');
      const re = wrappers.has(fn) ? new RegExp(`(?<![\\w$.])${ref}(?![\\w$])`) : new RegExp(`(?<![\\w$.])${ref}\\s*\\(`);
      if (re.test(body)) {
        const hit = visit(callee, [...chain, fn]);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const name of handlers) {
    const hit = visit(name, []);
    if (hit) return { hasGet: true, dispatches: true, path: hit };
  }
  return { hasGet: true, dispatches: false, path: [] };
}

/**
 * @param {Array<{path: string, src: string}>} files
 * @param {Record<string,string>} allowlist
 */
function auditRoutes(files, allowlist = ALLOWLIST) {
  const violations = [];
  const allowed = [];
  const flagged = new Set();
  for (const { path, src } of files) {
    const r = analyzeRoute(src);
    if (!r.dispatches) continue;
    flagged.add(path);
    if (allowlist[path]) allowed.push({ path, reason: allowlist[path], chain: r.path });
    else violations.push({ path, chain: r.path });
  }
  // An allowlist entry for a route that no longer dispatches from GET (or no
  // longer exists) is stale and must be removed, so the list stays honest.
  const stale = Object.keys(allowlist).filter((p) => !flagged.has(p));
  return { violations, allowed, stale };
}

module.exports = { ALLOWLIST, analyzeRoute, auditRoutes, blockFrom };
