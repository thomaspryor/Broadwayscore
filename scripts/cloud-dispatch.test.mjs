// BRO-5892: cloud-dispatch.js CLI. require()s the real parseArgs()/main() (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs, main } = require('./cloud-dispatch.js');

const run = (id, title, created, extra = {}) => ({ id, display_title: title, created_at: created, event: 'workflow_dispatch', html_url: `u/${id}`, ...extra });

test('cloud-dispatch: -f inputs, known run-name match, exit codes', () => {
  const o = parseArgs(['execute-approved-fix', '-f', 'issue_number=bro-3-b', '-f', 'mode=apply', '--wait']);
  assert.equal(o.workflow, 'execute-approved-fix.yml');
  assert.equal(o.match, 'execute-approved-fix bro-3-b [apply]');
  assert.equal(parseArgs(['execute-approved-fix.yml', '-f', 'issue_number=bro-3']).match, 'execute-approved-fix bro-3 [');
  assert.deepEqual(o.inputs, { issue_number: 'bro-3-b', mode: 'apply' });
  assert.throws(() => parseArgs(['w.yml', '-f', 'novalue']));
  assert.equal(parseArgs(['w.yml']).match, null);
  // BRO-6368: a brief run is found by its run-name; the plain hourly run has no match.
  assert.equal(parseArgs(['social-autopost.yml', '-f', 'brief=0123456789ab', '--wait']).match, 'Social Autopost brief 0123456789ab');
  assert.equal(parseArgs(['social-autopost.yml']).match, null);

  const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {};
  try {
    // Run 8 already existed before the dispatch (another session's, seconds earlier); run 9 is ours.
    const mk = (conclusion) => {
      let dispatched = false;
      return (args) => {
        if (args[0] === '-X') { dispatched = true; return null; }
        const now = new Date().toISOString();
        if (args[0].includes('/runs?')) return { workflow_runs: [run(8, 'execute-approved-fix bro-3 [apply]', now), ...(dispatched ? [run(9, 'execute-approved-fix bro-3 [apply]', now)] : [])] };
        if (conclusion === 'api-down') throw new Error('HTTP 502');
        return { status: 'completed', conclusion, html_url: `u/${args[0].split('/').pop()}` };
      };
    };
    const argv = ['execute-approved-fix.yml', '-f', 'issue_number=bro-3', '--wait'];
    const out = [];
    console.log = (m) => out.push(m);
    assert.equal(main(argv, { api: mk('success'), wait: () => {} }), 0);
    assert.ok(out.includes('Run: u/9'), out.join('\n'));
    assert.equal(main(argv, { api: mk('failure'), wait: () => {} }), 1);
    // A GitHub API that keeps failing while we wait is "unknown" (2), never "the run failed" (1).
    assert.equal(main(argv, { api: mk('api-down'), wait: () => {} }), 2);
    assert.equal(main(['nope.yml', '-f', 'x'], {}), 2);
  } finally { console.log = log; console.error = err; }
});
