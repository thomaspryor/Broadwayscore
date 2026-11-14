// BRO-7366: replay-pending-bylines.js routes pending-unrecoverable alerts through routeAlert, which files a
// Linear card. The opening-night poller's pre-poll drain step ran it without LINEAR_API_KEY, so on
// 2026-11-12 every alert logged "LINEAR_API_KEY is not set in this workflow ... nothing will be dispatched".
// Every workflow step that runs the script must carry the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('../../.github/workflows/', import.meta.url);

function stepsRunning(text, needle) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^\s*- name:/.test(l)) starts.push(i); });
  const out = [];
  starts.forEach((s, k) => {
    const chunk = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length);
    const runsIt = chunk.some((l) => !/^\s*#/.test(l) && !/echo /.test(l) && l.includes(needle));
    if (runsIt) out.push({ name: chunk[0].trim(), body: chunk.join('\n') });
  });
  return out;
}

test('every workflow step running replay-pending-bylines.js has LINEAR_API_KEY', () => {
  let seen = 0;
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const step of stepsRunning(text, 'scripts/replay-pending-bylines.js')) {
      seen++;
      assert.match(step.body, /LINEAR_API_KEY: \$\{\{ secrets\.LINEAR_API_KEY \}\}/, `${f}: step "${step.name}" runs replay-pending-bylines.js without LINEAR_API_KEY`);
    }
  }
  assert.ok(seen >= 3, `expected the poller drain, the poller loop and enrich-reviews steps, saw ${seen}`);
});
