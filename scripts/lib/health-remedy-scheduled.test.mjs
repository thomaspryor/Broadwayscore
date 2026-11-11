// BRO-7333 class guard: a health-check row whose hint names a remediation command
// (`node scripts/X.js ... --flag`) is only self-healing if that command runs on a
// schedule. "Data: armed-but-vacuous backlog cards" named
// `enrich-card-acceptance.js --source linear --rearm` but no workflow ran it, so the
// row re-fired as a new card daily (BRO-5456, BRO-7007, BRO-7219).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wfDir = path.join(root, '.github/workflows');
const allWorkflows = () => fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml'))
  .map((f) => fs.readFileSync(path.join(wfDir, f), 'utf8')).join('\n');

// Row name -> the remediation flag its hint cites and script that owns it.
const SELF_HEALING_ROWS = [
  { row: 'Data: armed-but-vacuous backlog cards', script: 'enrich-card-acceptance.js', flag: '--rearm' },
];

test('health-check hint for each self-healing row still cites its remedy', () => {
  const hc = fs.readFileSync(path.join(root, 'scripts/health-check.js'), 'utf8');
  for (const { row, script, flag } of SELF_HEALING_ROWS) {
    const i = hc.indexOf(`name: '${row}'`);
    assert.ok(i > 0, `row ${row} missing from health-check.js`);
    const hint = hc.slice(i, i + 900);
    assert.ok(hint.includes(script) && hint.includes(flag), `hint for ${row} no longer cites ${script} ${flag}`);
  }
});

test('every self-healing row remedy is invoked by a scheduled workflow (non dry-run)', () => {
  const wf = allWorkflows();
  for (const { row, script, flag } of SELF_HEALING_ROWS) {
    const lines = wf.split('\n').filter((l) => !l.trim().startsWith('#') && l.includes(`scripts/${script}`) && l.includes(flag));
    assert.ok(lines.length > 0, `${row}: no workflow runs ${script} ${flag}`);
    assert.ok(lines.some((l) => !l.includes('--dry-run')), `${row}: ${script} ${flag} only runs as --dry-run`);
  }
});
