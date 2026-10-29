// BRO-3975: two same-day commits each added the same `--alert` step to one job
// (audit-aggregator-gap.yml), doubling routeAlert/Linear-dedupe traffic. Within
// a single job, an `--alert` command must appear in at most one step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WF = path.join(import.meta.dirname, '..', '..', '.github', 'workflows');

/** [{ job, command }] for every single-line `run:` containing --alert. */
export function alertRuns(src) {
  const out = [];
  let job = null;
  let inJobs = false;
  for (const line of src.split('\n')) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (inJobs && /^ {2}[\w-]+:\s*$/.test(line)) { job = line.trim().replace(/:$/, ''); continue; }
    const m = /^\s+(?:- )?run:\s*(.+?)\s*$/.exec(line);
    if (job && m && /--alert\b/.test(m[1]) && !/^[|>]/.test(m[1])) out.push({ job, command: m[1] });
  }
  return out;
}

export function duplicates(runs) {
  const seen = new Map();
  const dup = [];
  for (const r of runs) {
    const k = `${r.job}\u0000${r.command}`;
    if (seen.has(k)) dup.push(`${r.job}: ${r.command}`);
    seen.set(k, true);
  }
  return dup;
}

test('detector finds a duplicated --alert step in one job, not across jobs', () => {
  const wf = [
    'jobs:', '  a:', '    steps:', '      - name: one', '        run: node x.js --scoreboard --alert',
    '      - name: two', '        run: node x.js --scoreboard --alert', '  b:', '    steps:',
    '      - name: three', '        run: node x.js --scoreboard --alert',
  ].join('\n');
  assert.deepEqual(duplicates(alertRuns(wf)), ['a: node x.js --scoreboard --alert']);
});

test('no workflow job runs the same --alert command in two steps', () => {
  const bad = [];
  for (const f of fs.readdirSync(WF).filter(n => /\.ya?ml$/.test(n))) {
    for (const d of duplicates(alertRuns(fs.readFileSync(path.join(WF, f), 'utf8')))) bad.push(`${f} ${d}`);
  }
  assert.deepEqual(bad, []);
});
