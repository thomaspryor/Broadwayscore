// Every `gh workflow run <file>.yml -f <key>=` hint printed by scripts/ must
// name a real workflow_dispatch input. A stale hint (`-f show=` vs `show_id`)
// made an opening-night image fetch fail with HTTP 422 (2026-10-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

// Keys directly under `workflow_dispatch: inputs:` (one indent level deeper).
function dispatchInputs(wfFile) {
  const lines = fs.readFileSync(wfFile, 'utf8').split('\n');
  const keys = new Set();
  const wd = lines.findIndex(l => /^\s*workflow_dispatch:\s*$/.test(l));
  if (wd < 0) return keys;
  const inp = lines.findIndex((l, i) => i > wd && /^\s*inputs:\s*$/.test(l));
  if (inp < 0) return keys;
  const inpIndent = lines[inp].match(/^ */)[0].length;
  if (inpIndent <= lines[wd].match(/^ */)[0].length) return keys;
  let keyIndent = null;
  for (let i = inp + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const ind = l.match(/^ */)[0].length;
    if (ind <= inpIndent) break;
    if (keyIndent === null) keyIndent = ind;
    const k = l.match(/^ *['"]?([A-Za-z0-9_-]+)['"]?:/);
    if (k && ind === keyIndent) keys.add(k[1]);
  }
  return keys;
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
