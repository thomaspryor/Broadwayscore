#!/usr/bin/env node
/**
 * Audit (#946, follow-up to #914): find scripts that call fetchPage() but
 * don't guarantee a hang-preventing call (scraper's cleanup() export, or
 * process.exit()) on the SUCCESS path.
 *
 * Bug class (#438, #914): fetchWithPlaywright() in scripts/lib/scraper.js
 * launches a module-level Chromium instance and only closes it in its own
 * catch block. On success the browser process stays open, keeping Node's
 * event loop alive forever — the script's real work finishes in seconds but
 * the process itself hangs until a hard CI timeout SIGKILLs it (#438: 44
 * minutes of dead air). scripts/lib/scraper.js exports `cleanup()` for
 * exactly this: callers must invoke it (or call process.exit(), which
 * forcibly ends the process regardless of open handles) once their real work
 * is done — including on the success path, not just from an error handler.
 *
 * A literal-string grep for "cleanup(" is NOT sufficient (task #914 finding):
 *   - false positive: a script destructures `cleanup: cleanupScraper` and
 *     calls `cleanupScraper()` — the literal "cleanup(" never appears as a
 *     call, but the file is actually safe.
 *   - false negative: a script's only cleanup()/process.exit() call sites are
 *     inside a catch block — grep sees "cleanup(" and looks safe, but the
 *     SUCCESS path (the common case) still hangs.
 *
 * This audit parses each candidate file with acorn to:
 *   1. resolve the actual local name(s) scraper's `cleanup` export is bound
 *      to (destructure alias, or `scraper.cleanup` via a whole-module
 *      require), via the require('./lib/scraper') call site;
 *   2. find every call site of that name, plus every process.exit() call;
 *   3. classify each call site as reachable only from a catch/`.catch()`
 *      handler, always-reachable via a `finally`/`.finally()`, or reachable
 *      on the plain success path.
 *
 * This is a heuristic over syntax structure, not real control-flow/reachability
 * analysis (no CFG, no dead-code elimination, no cross-function call-graph —
 * a cleanup call sitting in an unreachable branch or an uninvoked helper
 * function will still count as "safe"). It is intentionally advisory
 * (exits 0 always) — same posture as audit-run-budget-coverage.js.
 *
 * Usage: node scripts/audit-fetchpage-cleanup.js
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const SCRIPTS_DIR = path.join(__dirname);
const SCRAPER_REQUIRE_RE = /^\.\/lib\/scraper(?:\.js)?$/;

// Highest-frequency cron-critical scripts named in the card — reported first.
const PRIORITY = [
  'gather-reviews.js',
  'opening-night-poller.js',
  'scrape-cast-changes.js',
  'outlet-listing-poller.js',
];

function findCandidates() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => {
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
      return /\bfetchPage\s*\(/.test(src);
    })
    .sort();
}

/**
 * Resolve every local name bound to scraper's `cleanup` export, and every
 * local name bound to the WHOLE scraper module object (so `name.cleanup()`
 * can be recognized too). Covers the four shapes actually used in this repo:
 *   const { cleanup } = require('./lib/scraper')
 *   const { cleanup: alias } = require('./lib/scraper')
 *   const scraper = require('./lib/scraper')          (+ scraper.cleanup())
 *   scraper = require('./lib/scraper')                (bare assignment)
 */
function resolveBindings(ast) {
  const cleanupNames = new Set();
  const moduleNames = new Set();
  let requiresScraper = false;

  function isScraperRequireCall(node) {
    return (
      node &&
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0].type === 'Literal' &&
      typeof node.arguments[0].value === 'string' &&
      SCRAPER_REQUIRE_RE.test(node.arguments[0].value)
    );
  }

  function bindFromPattern(idNode, initNode) {
    if (!isScraperRequireCall(initNode)) return;
    if (idNode.type === 'ObjectPattern') {
      for (const prop of idNode.properties) {
        if (prop.type !== 'Property') continue;
        const keyName = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
        if (keyName === 'cleanup' && prop.value.type === 'Identifier') {
          cleanupNames.add(prop.value.name);
        }
      }
    } else if (idNode.type === 'Identifier') {
      moduleNames.add(idNode.name);
    }
  }

  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.init) bindFromPattern(node.id, node.init);
    },
    AssignmentExpression(node) {
      if (node.left.type === 'Identifier') bindFromPattern(node.left, node.right);
      // e.g. `fetchPage = require('./lib/scraper').fetchPage;` — a single
      // property pulled straight off the require call without an
      // intermediate module variable. Covers the cleanup equivalent.
      if (
        node.left.type === 'Identifier' &&
        node.right.type === 'MemberExpression' &&
        !node.right.computed &&
        node.right.property.type === 'Identifier' &&
        node.right.property.name === 'cleanup' &&
        isScraperRequireCall(node.right.object)
      ) {
        cleanupNames.add(node.left.name);
      }
    },
    CallExpression(node) {
      if (isScraperRequireCall(node)) requiresScraper = true;
    },
  });

  return { cleanupNames, moduleNames, requiresScraper };
}

/**
 * Walk the whole program collecting every call to a resolved cleanup name,
 * `<moduleName>.cleanup()`, or `process.exit()`, tagged with whether that
 * call site is only reachable via a catch handler, always reachable via a
 * finally, or on the plain (non-catch) path.
 *
 * try/catch and Promise .catch()/.finally() are both tracked: entering a
 * CatchClause, or the callback argument of a `.catch(`/`.finally(` call,
 * flips inCatch/inFinally for everything visited beneath it.
 */
function findCallSites(ast, { cleanupNames, moduleNames }) {
  const sites = [];

  function isTrackedCall(node) {
    if (node.callee.type === 'Identifier' && cleanupNames.has(node.callee.name)) return 'cleanup()';
    if (
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.object.type === 'Identifier' &&
      moduleNames.has(node.callee.object.name) &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'cleanup'
    ) {
      return `${node.callee.object.name}.cleanup()`;
    }
    if (
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'process' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'exit'
    ) {
      return 'process.exit()';
    }
    return null;
  }

  const visitors = {
    TryStatement(node, st, c) {
      c(node.block, st);
      if (node.handler) c(node.handler, st);
      if (node.finalizer) c(node.finalizer, { ...st, inFinally: true });
    },
    CatchClause(node, st, c) {
      if (node.param) c(node.param, st);
      c(node.body, { ...st, inCatch: true });
    },
    CallExpression(node, st, c) {
      const kind = isTrackedCall(node);
      if (kind) sites.push({ kind, inCatch: st.inCatch, inFinally: st.inFinally, line: node.loc?.start.line });

      const callee = node.callee;
      const isPromiseHandler =
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        (callee.property.name === 'catch' || callee.property.name === 'finally');

      if (isPromiseHandler) {
        c(callee.object, st);
        const flag = callee.property.name === 'catch' ? { inCatch: true } : { inFinally: true };
        for (const arg of node.arguments) c(arg, { ...st, ...flag });
        return;
      }

      c(callee, st);
      for (const arg of node.arguments) c(arg, st);
    },
  };

  walk.recursive(ast, { inCatch: false, inFinally: false }, visitors);
  return sites;
}

function classify(sites) {
  if (sites.length === 0) return 'UNSAFE_NO_CALL';
  if (sites.some((s) => s.inFinally)) return 'SAFE';
  if (sites.some((s) => !s.inCatch)) return 'SAFE';
  return 'UNSAFE_CATCH_ONLY';
}

function auditFile(file) {
  const filePath = path.join(SCRIPTS_DIR, file);
  // Strip a leading shebang line — acorn has no allowHashBang option in the
  // version pinned here and treats '#' as a syntax error at 1:1.
  const src = fs.readFileSync(filePath, 'utf8').replace(/^#!.*/, '');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', locations: true, allowReturnOutsideFunction: true });
  } catch (scriptErr) {
    // A handful of scripts use top-level import/export (ESM run via
    // createRequire) rather than plain CommonJS — retry as a module before
    // giving up.
    try {
      ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', locations: true });
    } catch (e) {
      return { file, verdict: 'PARSE_ERROR', detail: e.message, sites: [] };
    }
  }

  const bindings = resolveBindings(ast);
  if (!bindings.requiresScraper) {
    // fetchPage() is called but no require('./lib/scraper') site was found
    // at all in a shape this audit recognizes (e.g. re-exported through a
    // project-local wrapper module, or fetchPage is a passed-in param) —
    // can't resolve cleanup binding, flag for manual review rather than
    // guessing. Note this does NOT skip the process.exit() check below in
    // the normal case — only files that never require scraper at all land
    // here; files that require scraper but never destructure `cleanup`
    // still get scored on process.exit() alone via findCallSites.
    return { file, verdict: 'NO_SCRAPER_REQUIRE_FOUND', detail: null, sites: [] };
  }

  const sites = findCallSites(ast, bindings);
  const verdict = classify(sites);
  return { file, verdict, detail: null, sites };
}

function main() {
  const files = findCandidates();
  const results = files.map(auditFile);

  const byVerdict = { SAFE: [], UNSAFE_CATCH_ONLY: [], UNSAFE_NO_CALL: [], NO_SCRAPER_REQUIRE_FOUND: [], PARSE_ERROR: [] };
  for (const r of results) byVerdict[r.verdict].push(r);

  console.log(`Audited ${results.length} scripts/*.js callers of fetchPage()\n`);

  const priorityResults = results.filter((r) => PRIORITY.includes(r.file));
  if (priorityResults.length > 0) {
    console.log('── Priority cron-critical scripts ──');
    for (const r of priorityResults) console.log(`  ${verdictIcon(r.verdict)} ${r.file}: ${r.verdict}`);
    console.log('');
  }

  console.log(`✅ SAFE (${byVerdict.SAFE.length}) — hang-preventing call reachable outside a catch-only path`);
  console.log(`🔴 UNSAFE_CATCH_ONLY (${byVerdict.UNSAFE_CATCH_ONLY.length}) — cleanup()/process.exit() only fires on error; SUCCESS path hangs`);
  for (const r of byVerdict.UNSAFE_CATCH_ONLY) console.log(`   • ${r.file}`);
  console.log(`🔴 UNSAFE_NO_CALL (${byVerdict.UNSAFE_NO_CALL.length}) — no cleanup()/process.exit() call found anywhere`);
  for (const r of byVerdict.UNSAFE_NO_CALL) console.log(`   • ${r.file}`);
  console.log(`⚠️  NO_SCRAPER_REQUIRE_FOUND (${byVerdict.NO_SCRAPER_REQUIRE_FOUND.length}) — fetchPage() used but require('./lib/scraper') not recognized; needs manual read`);
  for (const r of byVerdict.NO_SCRAPER_REQUIRE_FOUND) console.log(`   • ${r.file}`);
  if (byVerdict.PARSE_ERROR.length > 0) {
    console.log(`⚠️  PARSE_ERROR (${byVerdict.PARSE_ERROR.length}) — could not parse, needs manual read`);
    for (const r of byVerdict.PARSE_ERROR) console.log(`   • ${r.file}: ${r.detail}`);
  }

  const unsafeCount = byVerdict.UNSAFE_CATCH_ONLY.length + byVerdict.UNSAFE_NO_CALL.length;
  console.log(`\n${unsafeCount} of ${results.length} candidates flagged UNSAFE (same bug class as #438/#914).`);
  console.log('Advisory only — always exits 0. Fix pattern: call cleanup() in a .finally() around main(), see recover-serp-text.js (commit 9140d034c37).');
}

function verdictIcon(v) {
  return v === 'SAFE' ? '✅' : v.startsWith('UNSAFE') ? '🔴' : '⚠️';
}

main();
