'use strict';
/**
 * BRO-6867: find workflow steps that run a script reaching the shared SERP
 * chain (url-discovery.js) with the ScrapingBee key in scope but not the
 * Scrapingdog key. Such a step skips Scrapingdog (5 credits/search) and sends
 * every search to ScrapingBee (25) or Bright Data. The OB official-site step,
 * the WE roundup refresh and the Stagedoor refresh all did this.
 *
 * Page fetches count too: fetchPage() (scraper.js) puts Scrapingdog first, so
 * a fetchPage step without its key pays Bright Data or ScrapingBee for every
 * page (author-page discovery, tour-entry creation, verify-reviews did this).
 * `npm run <name>` steps are expanded through package.json first.
 *
 * Reuses workflow-secret-scan.js (workflow parser, script invocations, module
 * resolution) so the same node/tsx/ts-node and .mjs/.ts/index.js rules apply.
 */
const fs = require('fs');
const path = require('path');
const {
  parseWorkflowFile, extractScriptInvocations, resolveModulePath, extractLocalDeps,
} = require('./workflow-secret-scan');

const SERP_ENTRY_RE = /\b(serpQuery|serpNewsQuery|serpImagesQuery|discoverCorrectUrl|discoverOfficialUrl)\s*\(/;
// Shared-scraper page fetches: a file that requires scraper.js and names
// fetchPage/fetchJSON (a call, or passing it on as a callback). Several scripts
// define their own plain-https fetchPage and never require scraper.js.
const FETCH_ENTRY_RE = /\b(fetchPage|fetchJSON)\b/;
const REQUIRES_SCRAPER_RE = /require\(\s*['"][./]*(?:(?:scripts\/)?lib\/)?scraper(?:\.js)?['"]\s*\)|from\s+['"][./]*(?:(?:scripts\/)?lib\/)?scraper(?:\.js)?['"]|require\(\s*path\.(?:join|resolve)\(\s*__dirname\s*,[^)]*['"][^'"]*scraper(?:\.js)?['"]\s*\)\s*\)/;
// require(path.join(__dirname, '<rel>')) is invisible to extractLocalDeps
// (it needs a literal), so the guard follows it itself (author-pages/*.js).
const PATH_JOIN_REQUIRE_RE = /require\(\s*path\.(?:join|resolve)\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)\s*\)/g;
const SCRAPER = path.join('lib', 'scraper.js');
const URL_DISCOVERY = path.join('lib', 'url-discovery.js');

/** Drop line and block comments, leaving string and template literals intact
 * (a naive regex treated an Accept header of star-slash-star as a comment opener). */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; else if (c !== '`' && src[j] === '\n') break; j++; }
      out += src.slice(i, j + 1); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    out += c;
  }
  return out;
}

function stripCommentsNaive(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function pathJoinDeps(src, fromAbs) {
  const deps = [];
  for (const m of src.matchAll(PATH_JOIN_REQUIRE_RE)) {
    const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    const base = path.resolve(path.dirname(fromAbs), ...parts);
    for (const cand of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
      try { if (fs.statSync(cand).isFile()) { deps.push(cand); break; } } catch { /* next */ }
    }
  }
  return deps;
}

/** True when the script, or anything it requires, calls a SERP entry point
 * (url-discovery.js itself is excluded: it defines them). */
function reachesSerpChain(entryAbs, cache = new Map()) {
  if (!entryAbs) return false;
  if (cache.has(entryAbs)) return cache.get(entryAbs);
  const visited = new Set();
  const queue = [entryAbs];
  let hit = false;
  while (queue.length && !hit) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    let src;
    try { src = fs.readFileSync(cur, 'utf8'); } catch { continue; }
    // url-discovery.js defines the entry points; loading it is not searching,
    // so neither it nor its own helpers count. Comments do not count either.
    if (cur.endsWith(URL_DISCOVERY) || cur.endsWith(SCRAPER)) continue;
    // Two strippers: the tokenizer can be thrown by a regex literal holding a
    // quote, the naive regex by a '*/*' string. A hit in either counts.
    const reaches = (code) => SERP_ENTRY_RE.test(code) || (FETCH_ENTRY_RE.test(code) && REQUIRES_SCRAPER_RE.test(code));
    if (reaches(stripComments(src)) || reaches(stripCommentsNaive(src))) { hit = true; break; }
    for (const dep of [...extractLocalDeps(src, cur), ...pathJoinDeps(src, cur)]) if (!visited.has(dep)) queue.push(dep);
  }
  cache.set(entryAbs, hit);
  return hit;
}

/** Replace `npm run <name>` / `npm test` / `npm start` with that package.json
 * script's command, recursively (a script that runs another npm script). */
function expandNpmRun(run, rootDir, depth = 0) {
  const re = /\bnpm (?:run(?:-script)?(?:\s+--?[\w-]+)*\s+([\w:.-]+)|(test|start))\b/g;
  if (depth > 4 || !re.test(run)) return run;
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).scripts || {}; } catch { /* no package.json */ }
  const next = run.replace(re, (m, name, short) => scripts[name || short] || m);
  return next === run ? run : expandNpmRun(next, rootDir, depth + 1);
}

/** Offending steps in one workflow file, as "wf > job > step (script)". */
function findSerpKeyGaps(raw, wfName, rootDir, cache = new Map()) {
  const { workflowEnv, jobs } = parseWorkflowFile(raw);
  const out = [];
  for (const job of jobs) {
    for (const step of job.steps) {
      const env = new Set([...workflowEnv, ...job.env, ...step.env]);
      if (!env.has('SCRAPINGBEE_API_KEY') || env.has('SCRAPINGDOG_API_KEY')) continue;
      for (const rel of extractScriptInvocations(expandNpmRun(step.run || '', rootDir))) {
        if (reachesSerpChain(resolveModulePath(rootDir, rel), cache)) {
          out.push(`${wfName} > ${job.name} > ${step.name} (${rel})`);
        }
      }
    }
  }
  return out;
}

function findAllSerpKeyGaps(rootDir) {
  const dir = path.join(rootDir, '.github', 'workflows');
  const cache = new Map();
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
    .flatMap((f) => findSerpKeyGaps(fs.readFileSync(path.join(dir, f), 'utf8'), f, rootDir, cache));
}

module.exports = { reachesSerpChain, findSerpKeyGaps, findAllSerpKeyGaps, expandNpmRun, stripComments, SERP_ENTRY_RE };
