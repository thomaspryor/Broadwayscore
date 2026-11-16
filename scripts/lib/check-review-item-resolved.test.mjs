// BRO-5371: the read-only acceptance check that replaced bare "VERIFY: owner-judgment" on review cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkResolved, parse, slugOfKey } = require('../check-review-item-resolved.js');
const { isSafeCheckCommand } = require('./check-paths.js');

const commercial = { shows: { hadestown: { designation: 'Hit' }, tbd: { designation: 'TBD' }, done: { designation: 'TBD', humanReviewedDesignation: true } } };
const pending = { shows: { 'tbd-2026': { recouped: true }, 'held-2026': { _reviewHold: true } } };

test('closure: resolved by a real designation or a human review stamp, open while TBD', () => {
  assert.equal(checkResolved('closure', 'hadestown', { commercial, pending }).resolved, true);
  assert.equal(checkResolved('closure', 'done', { commercial, pending }).resolved, true);
  assert.equal(checkResolved('closure', 'tbd', { commercial, pending }).resolved, false);
  assert.equal(checkResolved('closure', 'missing', { commercial, pending }).resolved, false);
});

test('claim: open while the pending row exists, resolved once it is gone', () => {
  assert.equal(checkResolved('claim', 'tbd-2026', { commercial, pending }).resolved, false);
  assert.equal(checkResolved('claim', 'gone-2026', { commercial, pending }).resolved, true);
});

test('held-empty: open while any row is held for a person', () => {
  assert.equal(checkResolved('held-empty', '', { commercial, pending }).resolved, false);
  assert.equal(checkResolved('held-empty', '', { commercial, pending: { shows: {} } }).resolved, true);
});

test('parse accepts only the four documented forms', () => {
  assert.deepEqual(parse(['n', 's', '--closure=abc']), { mode: 'closure', value: 'abc' });
  assert.deepEqual(parse(['n', 's', '--issue-closed=516']), { mode: 'issue-closed', value: '516' });
  assert.equal(parse(['n', 's', '--closure=../x']), null);
  assert.equal(parse(['n', 's']), null);
  assert.equal(slugOfKey('abc-2026'), 'abc');
});

test('every form the card filers emit is a safe-form check command', () => {
  for (const c of ['--claim=abc-2026', '--closure=hadestown', '--held-empty', '--issue-closed=516']) {
    assert.equal(isSafeCheckCommand(`node scripts/check-review-item-resolved.js ${c}`), true, c);
  }
  for (const c of ['--closure=../x', '--closure=a;rm', '--issue-closed=0', '--closure=a --held-empty']) {
    assert.equal(isSafeCheckCommand(`node scripts/check-review-item-resolved.js ${c}`), false, c);
  }
});

test('the claude-config hook suite runner is a safe form in its bare form only (Mac interactive)', () => {
  assert.equal(isSafeCheckCommand('bash ~/.claude/hooks/tests/run-all.sh'), true);
  assert.equal(isSafeCheckCommand('bash ~/.claude/hooks/tests/run-all.sh; rm x'), false);
  assert.equal(isSafeCheckCommand('bash ~/.claude/hooks/tests/run-all.sh --fix'), false);
});

test('claim: an exact year-suffixed key is judged on its own entry, not the bare slug', () => {
  const comm = { shows: { ragtime: { humanReviewedDesignation: true }, 'ragtime-2009': {} } };
  const pend = { shows: { 'ragtime-2009': { recoupedDate: '2009' } } };
  assert.equal(checkResolved('claim', 'ragtime-2009', { commercial: comm, pending: pend }).resolved, false);
});

test('held-empty: any remaining pending row keeps it open, held flag or not', () => {
  assert.equal(checkResolved('held-empty', '', { commercial: {}, pending: { shows: { x: { recoupedDate: '2024' } } } }).resolved, false);
});

// BRO-7612: the Done gate runs checks with a throwaway HOME, so gh is not logged in.
test('issue-closed: falls back to the public API when gh cannot authenticate', () => {
  const { issueState } = require('../check-review-item-resolved.js');
  const noGh = (cmd, args) => (cmd === 'gh'
    ? { status: 4, stdout: '', stderr: 'gh auth login' }
    : { status: 0, stdout: JSON.stringify({ number: Number(args.at(-1).split('/').pop()), state: 'closed' }) });
  assert.equal(issueState('935', { spawn: noGh }), 'closed');
  const ghOk = cmd => (cmd === 'gh' ? { status: 0, stdout: 'open\n' } : assert.fail('curl not needed'));
  assert.equal(issueState('935', { spawn: ghOk }), 'open');
  const bothFail = () => ({ status: 22, stdout: '' });
  assert.equal(issueState('935', { spawn: bothFail }), null);
  const junk = cmd => (cmd === 'gh' ? { status: 1, stdout: '' } : { status: 0, stdout: '{"message":"Not Found"}' });
  assert.equal(issueState('935', { spawn: junk }), null);
});

test('issue-closed: a pull request number is never read as a closed issue', () => {
  const { issueState } = require('../check-review-item-resolved.js');
  const ghPr = cmd => (cmd === 'gh' ? { status: 0, stdout: 'pr\n' } : assert.fail('curl not needed'));
  assert.equal(issueState('1', { spawn: ghPr }), null);
  const curlPr = cmd => (cmd === 'gh' ? { status: 4, stdout: '' } : { status: 0, stdout: '{"state":"closed","pull_request":{"url":"x"}}' });
  assert.equal(issueState('1', { spawn: curlPr }), null);
});
