// BRO-6867: a workflow step that runs a script reaching the shared SERP chain
// (serpQuery / serpNewsQuery / discoverOfficialUrl) with the ScrapingBee key but
// without the Scrapingdog key silently sends every search to ScrapingBee
// (25 credits) instead of Scrapingdog first (5 credits). The OB official-site
// step and the WE roundup refresh both did this. This test fails on any such step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const SERP_CALL = /\b(serpQuery|serpNewsQuery|discoverOfficialUrl)\s*\(/;
const cache = new Map();

export function reachesSerp(file) {
  const abs = path.resolve(file);
  if (cache.has(abs)) return cache.get(abs);
  cache.set(abs, false);
  if (!fs.existsSync(abs)) return false;
  const src = fs.readFileSync(abs, 'utf8');
  let hit = SERP_CALL.test(src) && !abs.endsWith(path.join('lib', 'url-discovery.js'));
  for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    let dep = path.resolve(path.dirname(abs), m[1]);
    if (!dep.endsWith('.js')) dep += '.js';
    if (reachesSerp(dep)) { hit = true; break; }
  }
  cache.set(abs, hit);
  return hit;
}

export function offendingSteps(workflowText, wfName) {
  const doc = yaml.load(workflowText) || {};
  const out = [];
  for (const [jobName, job] of Object.entries(doc.jobs || {})) {
    for (const step of job.steps || []) {
      const env = { ...(doc.env || {}), ...(job.env || {}), ...(step.env || {}) };
      if (!('SCRAPINGBEE_API_KEY' in env) || 'SCRAPINGDOG_API_KEY' in env) continue;
      const scripts = [...String(step.run || '').matchAll(/node\s+(scripts\/[\w./-]+\.js)/g)].map((m) => m[1]);
      for (const s of scripts) {
        if (reachesSerp(path.join(ROOT, s))) out.push(`${wfName} > ${jobName} > ${step.name || '?'} (${s})`);
      }
    }
  }
  return out;
}

test('every workflow step that reaches the SERP chain with the ScrapingBee key also has the Scrapingdog key', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    bad.push(...offendingSteps(fs.readFileSync(path.join(dir, f), 'utf8'), f));
  }
  assert.deepEqual(bad, [], `Add SCRAPINGDOG_API_KEY (and SCRAPER_USE_SCRAPINGDOG: '1') to:\n${bad.join('\n')}`);
});

test('detector flags a step with only the ScrapingBee key', () => {
  const wf = `jobs:\n  j:\n    steps:\n      - name: s\n        env:\n          SCRAPINGBEE_API_KEY: x\n        run: node scripts/ob-discovery-ticket-links.js\n`;
  assert.equal(offendingSteps(wf, 't.yml').length, 1);
  const ok = wf.replace('SCRAPINGBEE_API_KEY: x', 'SCRAPINGBEE_API_KEY: x\n          SCRAPINGDOG_API_KEY: y');
  assert.equal(offendingSteps(ok, 't.yml').length, 0);
});
