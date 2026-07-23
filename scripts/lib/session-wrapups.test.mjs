import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonLines, messageText, firstUserMessage, sessionLabel,
  finalAssistantText, statusLine, workspaceVerdict,
} from './session-wrapups.js';

const line = obj => JSON.stringify(obj);

test('parseJsonLines skips torn/blank lines', () => {
  const text = [line({ a: 1 }), '{"torn":', '', line({ b: 2 })].join('\n');
  assert.deepEqual(parseJsonLines(text), [{ a: 1 }, { b: 2 }]);
});

test('messageText handles string and content-array forms', () => {
  assert.equal(messageText({ message: { content: 'hi' } }), 'hi');
  assert.equal(messageText({
    message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] },
  }), 'a b');
  assert.equal(messageText({}), '');
});

test('firstUserMessage skips hook/system noise starting with <', () => {
  const entries = [
    { type: 'user', message: { content: '<system-reminder>noise</system-reminder>' } },
    { type: 'assistant', message: { content: 'ack' } },
    { type: 'user', message: { content: '[#328] Weekly Grosses — Work on this card' } },
  ];
  assert.equal(firstUserMessage(entries), '[#328] Weekly Grosses — Work on this card');
});

test('sessionLabel keeps the [#N] title, drops dispatch boilerplate, truncates', () => {
  assert.equal(
    sessionLabel('[#279] Email noise: alert router — Work on this card as this session\'s focus.'),
    '[#279] Email noise: alert router',
  );
  const long = 'x'.repeat(200);
  assert.equal(sessionLabel(long).length, 90);
  assert.ok(sessionLabel(long).endsWith('…'));
});

test('finalAssistantText scans backwards past relocated/snapshot entries', () => {
  const entries = [
    { type: 'assistant', message: { content: 'early' } },
    { type: 'assistant', message: { content: 'the wrap-up' } },
    { type: 'relocated' },
    { type: 'file-history-snapshot' },
  ];
  assert.equal(finalAssistantText(entries), 'the wrap-up');
});

test('statusLine grabs the LAST SAFE/NOT-SAFE line, prefers NOT SAFE when final', () => {
  assert.equal(
    statusLine('blah\nSAFE TO EXIT — quoted earlier\nmore\nNOT SAFE TO EXIT — CI still running'),
    'NOT SAFE TO EXIT — CI still running',
  );
  assert.equal(statusLine('no verdict here'), '');
});

test('workspaceVerdict decision table matches bsc-prune closability', () => {
  assert.equal(workspaceVerdict({ done: true, alive: false }), 'SAFE TO CLOSE');
  assert.match(workspaceVerdict({ done: true, alive: true }), /^DONE /);
  assert.match(workspaceVerdict({ done: false, alive: true }), /^WORKING/);
  assert.match(workspaceVerdict({ done: false, alive: false }), /^IDLE un-marked/);
});
