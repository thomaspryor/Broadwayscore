// Every `gh workflow run <file>.yml -f <key>=` hint printed by scripts/ must
// name an existing workflow and a real workflow_dispatch input. A stale hint
// (`-f show=` vs `show_id`) made an opening-night image fetch fail with
// HTTP 422 (2026-10-05). Scope: scripts/ only, filename form only; hints that
// name a workflow by display name ("LLM Ensemble Score Reviews") are not checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c?js|mjs|ts|sh)$/.test(e.name)) out.push(p);
  }
  return out;
}

function dispatchInputs(wfFile) {
  const doc = yaml.load(fs.readFileSync(wfFile, 'utf8')) || {};
  // js-yaml (YAML 1.1) parses a bare `on:` key as boolean true.
  const on = doc.on ?? doc[true];
  const inputs = on && typeof on === 'object' && !Array.isArray(on) ? on.workflow_dispatch?.inputs : null;
  return new Set(Object.keys(inputs || {}));
}

test('gh workflow run -f hints in scripts/ match real workflow inputs', () => {
  const bad = [];
  let checked = 0;
  for (const file of walk(path.join(ROOT, 'scripts'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/gh workflow run ([A-Za-z0-9_.-]+\.ya?ml)((?:\s+-f\s+[A-Za-z0-9_-]+=)+)/g)) {
      const wf = path.join(ROOT, '.github/workflows', m[1]);
      if (!fs.existsSync(wf)) { bad.push(`${path.relative(ROOT, file)}: no workflow file ${m[1]}`); continue; }
      const inputs = dispatchInputs(wf);
      for (const k of m[2].matchAll(/-f\s+([A-Za-z0-9_-]+)=/g)) {
        checked++;
        if (!inputs.has(k[1])) bad.push(`${path.relative(ROOT, file)}: ${m[1]} has no input "${k[1]}" (has: ${[...inputs].join(', ')})`);
      }
    }
  }
  assert.ok(checked > 5, `expected to check several hints, checked ${checked}`);
  assert.deepEqual(bad, []);
});
