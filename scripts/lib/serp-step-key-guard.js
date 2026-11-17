'use strict';
/**
 * BRO-6867: find workflow steps that run a script reaching the shared SERP
 * chain (url-discovery.js) with the ScrapingBee key in scope but not the
 * Scrapingdog key. Such a step skips Scrapingdog (5 credits/search) and sends
 * every search to ScrapingBee (25) or Bright Data. The OB official-site step,
 * the WE roundup refresh and the Stagedoor refresh all did this.
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
const URL_DISCOVERY = path.join('lib', 'url-discovery.js');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
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
    if (cur.endsWith(URL_DISCOVERY)) continue;
    if (SERP_ENTRY_RE.test(stripComments(src))) { hit = true; break; }
    for (const dep of extractLocalDeps(src, cur)) if (!visited.has(dep)) queue.push(dep);
  }
  cache.set(entryAbs, hit);
  return hit;
}

/** Offending steps in one workflow file, as "wf > job > step (script)". */
function findSerpKeyGaps(raw, wfName, rootDir, cache = new Map()) {
  const { workflowEnv, jobs } = parseWorkflowFile(raw);
  const out = [];
  for (const job of jobs) {
    for (const step of job.steps) {
      const env = new Set([...workflowEnv, ...job.env, ...step.env]);
      if (!env.has('SCRAPINGBEE_API_KEY') || env.has('SCRAPINGDOG_API_KEY')) continue;
      for (const rel of extractScriptInvocations(step.run || '')) {
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

module.exports = { reachesSerpChain, findSerpKeyGaps, findAllSerpKeyGaps, SERP_ENTRY_RE };
