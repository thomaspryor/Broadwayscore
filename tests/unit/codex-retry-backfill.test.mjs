import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('../../scripts/codex-retry-backfill.js');
const R = require('../../scripts/lib/codex-runner.js');

const note = (heading, cls, rest = '') => [R.BOUNCED_MARKER, heading, ...(cls ? [`<!-- codex-bounce-class: ${cls} -->`] : []), '', rest].join('\n');
const NOT_LANDED = '## Codex runner: not landed, left for the Claude worker';
const PARTIAL = R.PARTIAL_HEADING;
const REJECT_NOTE = note(NOT_LANDED, 'genuine-failure', '1 Codex attempt(s) did not pass.\n\n### Codex report\n```\nlong report\n```\n\n### Independent check (REJECT)\n```\nMissing test for the empty case.\n```');

test('retryKind: plain and partial bounces only; structural classes and crash notes stay out', () => {
  assert.equal(B.retryKind(REJECT_NOTE), 'not-landed');
  assert.equal(B.retryKind(note(NOT_LANDED, null)), 'not-landed', 'notes from before the class line');
  assert.equal(B.retryKind(note(PARTIAL, null)), 'partial');
  for (const cls of ['already-fixed', 'owner-decision', 'mac-or-private', 'missing-credential', 'forbidden-files']) assert.equal(B.retryKind(note(NOT_LANDED, cls)), null, cls);
  assert.equal(B.retryKind(`${R.BOUNCED_MARKER}\n## Codex runner: stopped mid-card\n`), null);
  assert.equal(B.retryKind('a person quoting codex-runner-bounced'), null);
});

test('bounceFindings keeps the reviewer findings and drops the marker lines and Codex report', () => {
  const f = B.bounceFindings(REJECT_NOTE);
  assert.match(f, /Missing test for the empty case/);
  assert.doesNotMatch(f, /long report|<!--|## Codex runner/);
});

test('planRetry: open cards only, once, newest bounce decides, leave-alone list honoured', () => {
  const c = (body, at) => ({ body, createdAt: at });
  const base = { identifier: 'BRO-1', stateType: 'unstarted', comments: [c(REJECT_NOTE, '2026-10-20T00:00:00Z')] };
  assert.equal(B.planRetry(base).kind, 'not-landed');
  assert.equal(B.planRetry({ ...base, stateType: 'started' }).skip, 'state started');
  assert.equal(B.planRetry({ ...base, identifier: 'BRO-4672' }).skip, 'leave-alone');
  assert.equal(B.planRetry({ ...base, comments: [...base.comments, c(R.retryBody({ findings: 'x' }), '2026-10-21T00:00:00Z')] }).skip, 'already retried');
  assert.match(B.planRetry({ ...base, comments: [...base.comments, c(note(NOT_LANDED, 'owner-decision'), '2026-10-22T00:00:00Z')] }).skip, /owner-decision/);
  // The posted note lifts the bounce for the runner.
  const posted = [...base.comments, c(R.retryBody({ findings: B.planRetry(base).findings }), '2026-10-23T00:00:00Z')];
  assert.equal(R.codexBouncedRecently(posted, Date.parse('2026-10-24T00:00:00Z')), false);
  assert.ok(R.parseCodexRetry(posted).findings.includes('Missing test for the empty case'));
});
