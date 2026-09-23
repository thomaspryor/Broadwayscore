import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectAuthStall, lastRealContentLine, lastNonBlankLine } = require('./cmux-auth-stall.js');

// Realistic bottom-of-pane chrome, verified live against a real `cmux
// read-screen` capture (this file's header) — the chrome bar, the spinner,
// and the input-box border all render BELOW the assistant's real last line,
// never above it.
function withChrome(lastLine, { busy = false } = {}) {
  const rows = [lastLine, ''];
  if (busy) rows.push('✻ Waiting for 2 background agents to finish');
  rows.push('──────────────────────────', '❯', '──────────────────────────', '🤖 SONNET │ ctx 41% │ main │ Broadwayscore');
  return rows.join('\n');
}

test('detectAuthStall: catches the CLI\'s literal "Not logged in" screen', () => {
  const screen = '\n\nNot logged in · Please run /login\n\n';
  const hit = detectAuthStall(screen);
  assert.equal(hit.kind, 'logged-out');
});

test('detectAuthStall: catches a raw API auth rejection', () => {
  const screen = 'Error: authentication_error: invalid x-api-key\n';
  assert.equal(detectAuthStall(screen).kind, 'logged-out');
});

test('detectAuthStall: catches a stalled resume — placeholder is the last REAL line, chrome renders below it', () => {
  assert.equal(detectAuthStall(withChrome('No response requested.')).kind, 'stalled-resume');
});

test('detectAuthStall: also fires while the spinner/update-banner chrome is showing (busy mid-turn is not "not stalled")', () => {
  assert.equal(detectAuthStall(withChrome('No response requested.', { busy: true })).kind, 'stalled-resume');
});

test('detectAuthStall: placeholder followed by REAL output is not stalled', () => {
  const screen = withChrome('Actually, here is a real analysis of the bug...').replace(
    'Actually, here is a real analysis of the bug...\n',
    'No response requested.\n\nActually, here is a real analysis of the bug...\n',
  );
  assert.equal(detectAuthStall(screen), null);
});

test('detectAuthStall: a normal healthy session (real output, then chrome) is not flagged', () => {
  assert.equal(detectAuthStall(withChrome('Done: pushed the fix, tests pass.')), null);
});

test('lastRealContentLine: skips the spinner/border/empty-prompt noise between real content and the chrome bar', () => {
  assert.equal(lastRealContentLine(withChrome('Keep this tab open.', { busy: true })), 'Keep this tab open.');
});

test('lastRealContentLine: with no chrome at all (a fresh login-prompt pane), falls back to the true last non-blank line', () => {
  assert.equal(lastRealContentLine('\n\nNot logged in · Please run /login\n\n'), 'Not logged in · Please run /login');
});

test('detectAuthStall: the literal phrase appearing mid-conversation (not as the last real line) does not false-positive', () => {
  // Self-reference guard (second-opinion review finding): a session
  // discussing THIS detector's own placeholder string must not trip it
  // merely for mentioning the phrase, only for it being the actual last
  // thing the session said.
  assert.equal(detectAuthStall(withChrome('The detector matches literal "No response requested." text.')), null);
});

test('detectAuthStall: empty/garbage screen text never throws', () => {
  assert.equal(detectAuthStall(''), null);
  assert.equal(detectAuthStall(null), null);
  assert.equal(detectAuthStall(undefined), null);
});

test('lastNonBlankLine: ignores trailing/leading blank lines and whitespace', () => {
  assert.equal(lastNonBlankLine('a\n\n  b  \n\n\n'), 'b');
  assert.equal(lastNonBlankLine(''), '');
});
