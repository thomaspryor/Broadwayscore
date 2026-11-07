/**
 * BRO-6340 (after BRO-5851): a workflow_dispatch whose concurrency group embeds a
 * comma-separated list input fails in ~3s with zero jobs and no alert once the
 * list is long. fetch-guardian-reviews.yml keyed its group on raw `inputs.shows`
 * and lost 30 of 31 opening-night-orchestrator dispatches (15+ shows, ~1600 chars)
 * before anyone noticed. This test evaluates EVERY workflow's concurrency group
 * with each list-valued input (description says "comma") set to a long list and
 * every other input set to a realistic single value, and fails if any group
 * grows past MAX_GROUP_LEN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wfDir = path.join(root, '.github', 'workflows');

// BRO-5851 failed at 642 chars; keep well under it.
const MAX_GROUP_LEN = 300;
const LONG_LIST = Array.from({ length: 40 }, (_, i) => `some-long-west-end-show-title-${i}-west-end-2026`).join(',');
const SINGLE = 'the-curious-case-of-benjamin-button-off-broadway-2026';

function inputDescriptions(yml) {
  const out = {};
  const re = /^\s+([A-Za-z0-9_-]+):\s*\n\s+description:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(yml))) out[m[1]] = m[2];
  return out;
}

function evalGroup(raw, inputs) {
  const format = (f, ...a) => a.reduce((s, v, i) => s.replace(`{${i}}`, v), f);
  // GHA contains() on strings: case-insensitive substring match.
  const contains = (s, sub) => String(s).toLowerCase().includes(String(sub).toLowerCase());
  const github = {
    workflow: 'wf', ref: 'refs/heads/main', ref_name: 'main', sha: 'a'.repeat(40),
    run_id: '40310614635', event_name: 'workflow_dispatch',
    event: { inputs, issue: { number: 123 }, pull_request: { number: 123 } },
  };
  const stub = new Proxy({}, { get: () => 'value' });
  const fns = {
    format, contains,
    startsWith: (s, p) => String(s).toLowerCase().startsWith(String(p).toLowerCase()),
    endsWith: (s, p) => String(s).toLowerCase().endsWith(String(p).toLowerCase()),
    toJSON: (v) => JSON.stringify(v), fromJSON: (v) => JSON.parse(v),
    join: (a, sep = ',') => [].concat(a).join(sep),
  };
  return raw.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
    let v;
    try {
      const fn = new Function('inputs', 'github', 'matrix', 'vars', 'env', 'needs', ...Object.keys(fns), `return (${expr});`);
      v = fn(inputs, github, stub, stub, stub, stub, ...Object.values(fns));
    } catch (err) {
      throw new Error(`could not evaluate "${expr}" (${err.message}); extend evalGroup in this test to cover it`);
    }
    return v === undefined || v === null || v === false ? '' : String(v);
  });
}

const files = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml'));

for (const file of files) {
  const yml = fs.readFileSync(path.join(wfDir, file), 'utf8');
  const groups = [...yml.matchAll(/^\s*group:\s*(.+)$/gm)].map((m) => m[1].trim()).filter((g) => g.includes('${{'));
  if (!groups.length) continue;
  const descs = inputDescriptions(yml);
  const inputs = new Proxy({}, {
    get: (_, name) => (typeof name === 'string' && /comma/i.test(descs[name] || '') ? LONG_LIST : SINGLE),
  });
  test(`${file}: concurrency group stays short when list inputs are long`, () => {
    for (const g of groups) {
      const value = evalGroup(g, inputs);
      assert.ok(value.length <= MAX_GROUP_LEN,
        `${file} group "${g}" evaluates to ${value.length} chars; key list inputs by github.run_id instead (see fetch-guardian-reviews.yml)`);
    }
  });
}

test('the check actually catches a raw list input (fetch-guardian pre-BRO-6340 shape)', () => {
  const descs = { shows: "'Comma-separated show IDs to process (empty = all)'" };
  const inputs = new Proxy({}, { get: (_, n) => (/comma/i.test(descs[n] || '') ? LONG_LIST : SINGLE) });
  assert.ok(evalGroup('fetch-guardian-reviews-${{ inputs.shows || \'scheduled\' }}', inputs).length > MAX_GROUP_LEN);
});
