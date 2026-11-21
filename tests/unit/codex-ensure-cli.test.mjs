// BRO-7927: the review skills checked only `command -v codex`, a fresh cloud
// container has no Codex, and the skills called that "expected in cloud", so
// every cloud /plan-review and /ship-check quietly ran gpt-5.4-mini instead of
// Codex for weeks without anyone telling the owner. Codex does run in cloud
// (scripts/codex/ensure-cli.sh installs it and restores the stored login).
//
// Class guard: every Claude command or skill that runs `codex exec` must get
// Codex through ensure-cli.sh, must save the rotated login after the exec,
// must read Codex's final answer with -o (not the awk filter over its log),
// and must never describe a missing Codex as normal in cloud. Plus behaviour
// tests of ensure-cli.sh against a fake codex/npm/node on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'codex', 'ensure-cli.sh');

function skillFiles() {
  const out = [];
  const cmdDir = path.join(ROOT, '.claude', 'commands');
  for (const f of fs.readdirSync(cmdDir)) if (f.endsWith('.md')) out.push(path.join(cmdDir, f));
  const skillDir = path.join(ROOT, '.claude', 'skills');
  if (fs.existsSync(skillDir)) {
    for (const d of fs.readdirSync(skillDir)) {
      const p = path.join(skillDir, d, 'SKILL.md');
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

const runsCodex = (text) => /\bcodex exec\b/.test(text);

test('every skill that runs codex exec sets Codex up through ensure-cli.sh', () => {
  const offenders = [];
  for (const f of skillFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    if (!runsCodex(text)) continue;
    const rel = path.relative(ROOT, f);
    if (!text.includes('bash scripts/codex/ensure-cli.sh')) offenders.push(`${rel}: no ensure-cli.sh call`);
    if (/command -v codex\s*>\/dev\/null\s*&&/.test(text)) offenders.push(`${rel}: still gates Codex on a bare command -v codex`);
    if (!text.includes('ensure-cli.sh --save')) offenders.push(`${rel}: never saves the rotated Codex login after exec`);
    if (/awk '\/\^codex\$\//.test(text)) offenders.push(`${rel}: reads Codex's log with the awk filter instead of -o`);
    if (/expected in cloud|normal path in cloud|there is no Codex CLI/i.test(text)) offenders.push(`${rel}: describes a missing Codex as normal in cloud`);
  }
  assert.deepEqual(offenders, []);
});

test('the two review skills are in scope (guard is not vacuous)', () => {
  const names = skillFiles().filter((f) => runsCodex(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
  assert.ok(names.includes('plan-review.md'), names.join(','));
  assert.ok(names.includes('ship-check.md'), names.join(','));
});

// ---- behaviour of ensure-cli.sh with fakes on PATH ----
// codex and npm are fakes. node is a wrapper: auth-store.js and install.js are
// faked (they talk to Linear / write ~/.codex), every other call, including the
// login-expiry check against the real scripts/lib/codex-runner.js, runs the real node.
const REAL_NODE = process.execPath;
const jwt = (expSec) => `x.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.y`;
const authFixture = (minutesLeft) => JSON.stringify({ tokens: { access_token: jwt(Math.floor(Date.now() / 1000) + minutesLeft * 60) } });

function sandbox({ codexVersion, npmOk = true, restore = 'ok', storedMinutesLeft = 600 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-cli-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'codex'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'codex', 'ensure-cli.sh'));
  fs.symlinkSync(path.join(ROOT, 'scripts', 'lib'), path.join(repo, 'scripts', 'lib'));
  const calls = path.join(dir, 'calls.log');
  const stored = path.join(dir, 'stored-auth.json');
  fs.writeFileSync(stored, authFixture(storedMinutesLeft));
  const w = (name, body) => { const p = path.join(bin, name); fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(p, 0o755); };
  const verFile = path.join(dir, 'codex.version');
  if (codexVersion) {
    fs.writeFileSync(verFile, codexVersion);
    w('codex', `echo "codex-cli $(cat "${verFile}")"`);
  }
  // fake npm "installs" codex at the version it was asked for
  w('npm', `echo "npm $*" >> "${calls}"; ${npmOk ? '' : 'exit 1;'} v="\${@: -1}"; v="\${v##*@}"; echo "$v" > "${verFile}"; printf '#!/usr/bin/env bash\\necho "codex-cli $(cat "${verFile}")"\\n' > "${bin}/codex"; chmod +x "${bin}/codex"`);
  const restoreBody = restore === 'ok' ? `cp "${stored}" "${home}/.codex/auth.json"` : restore === 'fail' ? 'exit 2' : 'true';
  w('node', `case "$*" in
  *auth-store.js*restore*) echo "node $*" >> "${calls}"; ${restoreBody};;
  *auth-store.js*) echo "node $*" >> "${calls}";;
  *install.js*) echo "node $*" >> "${calls}";;
  *) exec "${REAL_NODE}" "$@";;
esac`);
  const run = (args = [], env = {}) => spawnSync('bash', [path.join(repo, 'scripts', 'codex', 'ensure-cli.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: dir, OPENAI_API_KEY: 'x', ...env },
  });
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  const leftLogs = () => fs.readdirSync(dir).filter((f) => f.startsWith('codex-ensure.'));
  return { run, log, home, dir, leftLogs };
}
const CLOUD = { CLAUDE_CODE_REMOTE: 'true' };
const MAC = { CLAUDE_CODE_REMOTE: '' };

test('fresh cloud container: installs the pinned CLI, restores the login, READY, no log left', () => {
  const s = sandbox({ codexVersion: null });
  const r = s.run([], CLOUD);
  assert.equal(r.stdout.trim(), 'READY', r.stdout + r.stderr);
  assert.equal(r.status, 0);
  assert.match(s.log(), /npm i -g .*@openai\/codex@0\.160\.0/);
  assert.match(s.log(), /auth-store\.js restore/);
  assert.match(s.log(), /install\.js/);
  assert.deepEqual(s.leftLogs(), []);
});

test('cloud with the wrong version: reinstalls the pin', () => {
  const s = sandbox({ codexVersion: '0.150.0' });
  const r = s.run([], CLOUD);
  assert.equal(r.stdout.trim(), 'READY', r.stdout + r.stderr);
  assert.match(s.log(), /npm i -g/);
});

test('cloud npm install fails: MISSING with the reason, log kept', () => {
  const s = sandbox({ codexVersion: null, npmOk: false });
  const r = s.run([], CLOUD);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING: npm install of @openai\/codex@0\.160\.0 failed/);
  assert.equal(s.leftLogs().length, 1);
});

test('cloud restore fails: MISSING, even when an older local login exists', () => {
  const s = sandbox({ codexVersion: '0.160.0', restore: 'fail' });
  fs.writeFileSync(path.join(s.home, '.codex', 'auth.json'), authFixture(600));
  const r = s.run([], CLOUD);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING: restoring the stored Codex login failed/);
});

test('cloud restore leaves no login: MISSING names the login', () => {
  const s = sandbox({ codexVersion: '0.160.0', restore: 'noop' });
  const r = s.run([], CLOUD);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING: no Codex login/);
});

test('cloud login near expiry (real loginExpiryWhy): MISSING, refresh left to the runner', () => {
  const s = sandbox({ codexVersion: '0.160.0', storedMinutesLeft: 20 });
  const r = s.run([], CLOUD);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^MISSING: the Codex login expires .*refreshing it is left to the Codex daily runner/);
  assert.doesNotMatch(s.log(), /install\.js/);
});

test('cloud malformed login: MISSING (expiry unreadable)', () => {
  const s = sandbox({ codexVersion: '0.160.0' });
  fs.writeFileSync(path.join(s.dir, 'stored-auth.json'), '{bad');
  const r = s.run([], CLOUD);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING: the Codex login expiry is unreadable/);
});

test('cloud --save runs auth-store save and prints SAVED', () => {
  const s = sandbox({ codexVersion: '0.160.0' });
  const r = s.run(['--save'], CLOUD);
  assert.equal(r.stdout.trim(), 'SAVED');
  assert.match(s.log(), /auth-store\.js save/);
});

test('Mac with its own Codex and no auth.json: READY, nothing installed or restored', () => {
  const s = sandbox({ codexVersion: '0.170.0' });
  const r = s.run([], MAC);
  assert.equal(r.stdout.trim(), 'READY', r.stdout + r.stderr);
  assert.doesNotMatch(s.log(), /npm i -g|auth-store/);
  assert.equal(fs.existsSync(path.join(s.home, '.codex', 'auth.json')), false);
});

test('Mac with no Codex: MISSING, no global install', () => {
  const s = sandbox({ codexVersion: null });
  const r = s.run([], MAC);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING: no codex CLI on this machine/);
  assert.doesNotMatch(s.log(), /npm/);
});

test('Mac --save never pushes the Mac login to the store', () => {
  const s = sandbox({ codexVersion: '0.170.0' });
  const r = s.run(['--save'], MAC);
  assert.equal(r.status, 0);
  assert.doesNotMatch(s.log(), /auth-store/);
});

test('the Codex version pin matches the daily runner and the codex-runner workflow', () => {
  const pin = (file, re) => { const m = fs.readFileSync(path.join(ROOT, file), 'utf8').match(re); assert.ok(m, `${file}: no pin found`); return m[1]; };
  const ensure = pin('scripts/codex/ensure-cli.sh', /CODEX_CLI_VERSION:-([\d.]+)/);
  assert.equal(pin('scripts/codex/daily-runner.js', /const CODEX_VERSION = '([\d.]+)'/), ensure);
  assert.equal(pin('.github/workflows/codex-runner.yml', /@openai\/codex@([\d.]+)/), ensure);
});
