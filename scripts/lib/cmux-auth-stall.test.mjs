import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectAuthStall, lastRealContentLine, isBusy } = require('./cmux-auth-stall.js');

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

test('detectAuthStall: a session actively busy right after the placeholder is working, not stalled (adversarial review finding)', () => {
  assert.equal(detectAuthStall(withChrome('No response requested.', { busy: true })), null);
});

test('isBusy: true while the ✻ in-flight spinner is on screen', () => {
  assert.equal(isBusy(withChrome('anything', { busy: true })), true);
  assert.equal(isBusy(withChrome('anything', { busy: false })), false);
});

test('isBusy: also true for the ✳ spinner glyph (code-review finding — two sibling files name ✳, not ✻, as cmux\'s general activity glyph)', () => {
  assert.equal(isBusy('✳ Thinking...\n\n🤖 SONNET │ ctx 10% │ main │ Broadwayscore'), true);
});

test('lastRealContentLine: only treats "Update installed" as the banner, not any ✔-led real content (code-review finding)', () => {
  const screen = [
    '✔ All 27 tests passed before this commit.',
    '',
    '──────────────────────────',
    '❯',
    '──────────────────────────',
    '🤖 SONNET │ ctx 41% │ main │ Broadwayscore',
  ].join('\n');
  assert.equal(lastRealContentLine(screen), '✔ All 27 tests passed before this commit.');
});

test('lastRealContentLine: only treats a boxed "❯"-led line (bordered) as the prompt, not real content that quotes a shell prompt (code-review finding)', () => {
  const screen = [
    'Run it with ❯ npm run build to reproduce.',
    '',
    '──────────────────────────',
    '❯',
    '──────────────────────────',
    '🤖 SONNET │ ctx 41% │ main │ Broadwayscore',
  ].join('\n');
  assert.equal(lastRealContentLine(screen), 'Run it with ❯ npm run build to reproduce.');
});

test('detectAuthStall: chrome-gate — a HEALTHY session merely quoting the auth-error phrase is not flagged (adversarial review finding)', () => {
  // The exact self-reference risk: a tab discussing/reviewing THIS bug could
  // display the literal phrase, but it's a live authenticated session (has
  // the ctx chrome bar) — chrome presence alone rules out logged-out.
  assert.equal(detectAuthStall(withChrome('The detector matches "Not logged in · Please run /login" text.')), null);
  assert.equal(detectAuthStall(withChrome('Old scrollback once showed: authentication_error, but it recovered.')), null);
});

test('detectAuthStall: an unsubmitted draft in the prompt box does not hide a real stalled placeholder above it (adversarial review finding)', () => {
  const screen = [
    'No response requested.',
    '',
    '──────────────────────────',
    '❯ half-typed draft the owner never sent',
    '──────────────────────────',
    '🤖 SONNET │ ctx 41% │ main │ Broadwayscore',
  ].join('\n');
  assert.equal(detectAuthStall(screen).kind, 'stalled-resume');
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

