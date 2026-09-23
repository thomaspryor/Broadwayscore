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


// ---- BRO-4065: real logged-out screens from Claude Code 2.1.28x ----
// Captured verbatim (blank runs compacted) from a scratch cmux tab running
// `env -u CLAUDE_CODE_OAUTH_TOKEN claude`, 2026-09-23. Both DRAW the ctx
// status bar, so the chromeless rule alone missed them.
const REAL_LOGGED_OUT_IDLE = "\n ▐▛███▛█   Claude Code v2.1.280\n▝▜██████▀  Haiku 4.5 · API Usage Billing\n  ▝▝ ▝▝    /private/tmp/bro4065-scratch\n\n  Get to finished work sooner with Opus 5.5. Switch anytime with /model.\n\n                                                                       Not logged in · Run /login\n───────────────────────────────────────────────────────────────────────────────────────────────────\n❯ \n───────────────────────────────────────────────────────────────────────────────────────────────────\n  🪶 HAIKU │ ctx 0% │ bro4065-scratch\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 9 agents\n";
const REAL_LOGGED_OUT_PROMPTED = "\n ▐▛███▛█   Claude Code v2.1.280\n▝▜██████▀  Haiku 4.5 · API Usage Billing\n  ▝▝ ▝▝    /private/tmp/bro4065-scratch\n\n  Get to finished work sooner with Opus 5.5. Switch anytime with /model.\n\n❯ say hi                                                                                           \n  ⎿  Not logged in · Please run /login\n\n✻ Crunched for 0s · done 1:34 AM\n\n                                                                       Not logged in · Run /login\n───────────────────────────────────────────────────────────────────────────────────────────────────\n❯ \n───────────────────────────────────────────────────────────────────────────────────────────────────\n  🪶 HAIKU │ ctx 0% │ bro4065-scratch\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 9 agents\n";

test('BRO-4065: real logged-out screens WITH chrome are detected', () => {
  for (const screen of [REAL_LOGGED_OUT_IDLE, REAL_LOGGED_OUT_PROMPTED]) {
    const hit = detectAuthStall(screen);
    assert.equal(hit && hit.kind, 'logged-out');
  }
});

test('BRO-4065: "✻ Crunched for 0s · done" is a finished turn, not busy', () => {
  assert.equal(isBusy(REAL_LOGGED_OUT_PROMPTED), false);
  assert.equal(isBusy('✻ Worked for 3m 2s'), false);
  assert.equal(isBusy('✻ Waiting for 2 background agents to finish'), true);
  assert.equal(isBusy('✳ Thinking…'), true);
});

test('BRO-4065: a healthy session whose HISTORY quotes the login error is not flagged', () => {
  const screen = '> why did the tab say this?\n  ⎿  Not logged in · Please run /login\n⏺ That was the keychain sentinel; fixed now.\n────────\n❯ \n────────\n  🔮 OPUS │ ctx 12% │ main\n';
  assert.equal(detectAuthStall(screen), null);
});

test('BRO-4065: an API auth rejection as the last line WITH chrome is logged-out', () => {
  const screen = '> hi\n  ⎿  API Error: 401 {"type":"error","error":{"type":"authentication_error"}}\n────────\n❯ \n────────\n  🔮 OPUS │ ctx 3% │ main\n';
  assert.equal(detectAuthStall(screen).kind, 'logged-out');
});
