// Tests for scripts/lib/launchd-plist-lint.js. The red fixture is the ACTUAL
// com.broadwayscore.wsj-cookie-refresh.plist ProgramArguments that exited 127
// under launchd (2026-11-08); the sweep test reads every real plist in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findBareCommandsWithoutPath } = require('./launchd-plist-lint.js');

const OLD_WSJ = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <!-- Manual run: exec node scripts/wsj-otp-login.js is documented here and must not flag -->
    <key>Label</key>
    <string>com.broadwayscore.wsj-cookie-refresh</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cd /Users/tompryor/Broadwayscore &amp;&amp; set -a &amp;&amp; source .env &amp;&amp; set +a &amp;&amp; exec node scripts/wsj-otp-login.js --push</string>
    </array>
</dict>
</plist>`;

const withPath = (p) => OLD_WSJ.replace('</dict>', `    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${p}</string>
    </dict>
</dict>`);

test('flags the old WSJ plist: bare node under bash -c with no PATH', () => {
  const f = findBareCommandsWithoutPath(OLD_WSJ);
  assert.equal(f.length, 1);
  assert.equal(f[0].command, 'node');
  assert.match(f[0].text, /exec node scripts\/wsj-otp-login\.js/);
});

test('passes when EnvironmentVariables.PATH has /opt/homebrew/bin', () => {
  assert.deepEqual(findBareCommandsWithoutPath(withPath('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')), []);
});

test('flags a PATH that lacks /opt/homebrew/bin', () => {
  assert.equal(findBareCommandsWithoutPath(withPath('/usr/local/bin:/usr/bin:/bin')).length, 1);
});

test('passes under a login shell (bash -lc, as cookie-renew does)', () => {
  assert.deepEqual(findBareCommandsWithoutPath(OLD_WSJ.replace('<string>-c</string>', '<string>-lc</string>')), []);
});

test('passes an absolute-path node as argv[0] and inside a shell string', () => {
  const argv0 = `<key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>x.js</string></array>`;
  assert.deepEqual(findBareCommandsWithoutPath(argv0), []);
  const inShell = `<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>/opt/homebrew/bin/node /Users/tompryor/Broadwayscore/scripts/x.js</string></array>`;
  assert.deepEqual(findBareCommandsWithoutPath(inShell), []);
});

test('flags a bare node as argv[0] and via /usr/bin/env', () => {
  assert.equal(findBareCommandsWithoutPath('<key>ProgramArguments</key><array><string>node</string><string>x.js</string></array>').length, 1);
  assert.equal(findBareCommandsWithoutPath('<key>ProgramArguments</key><array><string>/usr/bin/env</string><string>node</string><string>x.js</string></array>').length, 1);
});

test('flags the other commands that live outside launchd PATH (gh, npx, python3)', () => {
  for (const cmd of ['gh', 'npx', 'python3']) {
    const p = `<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>cd /x &amp;&amp; ${cmd} run</string></array>`;
    assert.equal(findBareCommandsWithoutPath(p).length, 1, cmd);
  }
});

test('does not flag node inside a path, a name or node_modules', () => {
  const p = `<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>/bin/sh scripts/check-node-version.sh &amp;&amp; ls node_modules</string></array>`;
  assert.deepEqual(findBareCommandsWithoutPath(p), []);
});

test('catches the shapes the first version missed (codex finding)', () => {
  const wrap = (...a) => `<key>ProgramArguments</key><array>${a.map((x) => `<string>${x}</string>`).join('')}</array>`;
  assert.equal(findBareCommandsWithoutPath(wrap('/bin/bash', '-c', 'node')).length, 1, 'lone command string');
  assert.equal(findBareCommandsWithoutPath(wrap('/usr/bin/env', '-i', 'node', 'x.js')).length, 1, 'env flags');
  assert.equal(findBareCommandsWithoutPath(wrap('/bin/bash', '-c', '&quot;node&quot; x.js')).length, 1, 'quoted command');
  assert.equal(findBareCommandsWithoutPath(wrap('/bin/bash', '-c', 'exec node x.js', '-l')).length, 1, '-l after the command string is $0, not a login shell');
  assert.deepEqual(findBareCommandsWithoutPath(wrap('/bin/bash', '-lc', 'exec node x.js')), [], 'a real login shell still passes');
});

test('honours the plist-path-ok waiver', () => {
  const p = `<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>cd /x &amp;&amp; node a.js # plist-path-ok: wrapper sets PATH</string></array>`;
  assert.deepEqual(findBareCommandsWithoutPath(p), []);
});

test('every scripts/launchd/*.plist in the repo passes', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'launchd');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.plist'));
  assert.ok(files.length > 20, 'expected the real plist set');
  const bad = [];
  for (const n of files) {
    const f = findBareCommandsWithoutPath(fs.readFileSync(path.join(dir, n), 'utf8'));
    if (f.length) bad.push(`${n}: ${f[0].text}`);
  }
  assert.deepEqual(bad, []);
});
