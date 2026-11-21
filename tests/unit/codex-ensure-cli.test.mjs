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
    if (/expected in cloud/i.test(text)) offenders.push(`${rel}: calls a missing Codex "expected in cloud"`);
  }
  assert.deepEqual(offenders, []);
});

test('the two review skills are in scope (guard is not vacuous)', () => {
  const names = skillFiles().filter((f) => runsCodex(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
  assert.ok(names.includes('plan-review.md'), names.join(','));
  assert.ok(names.includes('ship-check.md'), names.join(','));
});

// ---- behaviour of ensure-cli.sh with fakes on PATH ----
function sandbox({ codexVersion, npmOk = true, auth = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-cli-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'codex'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'codex', 'ensure-cli.sh'));
  const calls = path.join(dir, 'calls.log');
  const w = (name, body) => { const p = path.join(bin, name); fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(p, 0o755); };
  const verFile = path.join(dir, 'codex.version');
  if (codexVersion) fs.writeFileSync(verFile, codexVersion);
  w('codex', `[ -f "${verFile}" ] || exit 127; echo "codex-cli $(cat "${verFile}")"`);
  if (!codexVersion) fs.rmSync(path.join(bin, 'codex'));
  // fake npm "installs" codex by writing the version it was asked for
  w('npm', `echo "npm $*" >> "${calls}"; ${npmOk ? '' : 'exit 1;'} v="\${@: -1}"; v="\${v##*@}"; echo "$v" > "${verFile}"; cat > "${bin}/codex" <<'X'\n#!/usr/bin/env bash\necho "codex-cli $(cat "${verFile}")"\nX\nchmod +x "${bin}/codex"`);
  w('node', `echo "node $*" >> "${calls}"; case "$*" in *auth-store.js*restore*) ${auth ? `echo '{}' > "${home}/.codex/auth.json"` : 'true'};; esac; exit 0`);
  const run = (args = [], env = {}) => spawnSync('bash', [path.join(repo, 'scripts', 'codex', 'ensure-cli.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: dir, OPENAI_API_KEY: 'x', ...env },
  });
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  return { run, log, home, dir };
}

test('fresh cloud container: installs the pinned CLI, restores the login, READY', () => {
  const s = sandbox({ codexVersion: null });
  const r = s.run([], { CLAUDE_CODE_REMOTE: 'true' });
  assert.equal(r.stdout.trim(), 'READY', r.stdout + r.stderr);
  assert.equal(r.status, 0);
  assert.match(s.log(), /npm i -g .*@openai\/codex@0\.160\.0/);
  assert.match(s.log(), /auth-store\.js restore/);
  assert.match(s.log(), /install\.js/);
});

test('cloud with the wrong version: reinstalls the pin', () => {
  const s = sandbox({ codexVersion: '0.150.0' });
  const r = s.run([], { CLAUDE_CODE_REMOTE: 'true' });
  assert.equal(r.stdout.trim(), 'READY');
  assert.match(s.log(), /npm i -g/);
});

test('Mac with its own Codex and login: no reinstall, no login overwrite', () => {
  const s = sandbox({ codexVersion: '0.170.0' });
  fs.writeFileSync(path.join(s.home, '.codex', 'auth.json'), '{"mine":1}');
  const r = s.run([], { CLAUDE_CODE_REMOTE: '' });
  assert.equal(r.stdout.trim(), 'READY');
  assert.doesNotMatch(s.log(), /npm i -g/);
  assert.doesNotMatch(s.log(), /auth-store\.js restore/);
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'auth.json'), 'utf8'), '{"mine":1}');
});

test('npm install fails: MISSING with the reason, exit 1', () => {
  const s = sandbox({ codexVersion: null, npmOk: false });
  const r = s.run([], { CLAUDE_CODE_REMOTE: 'true' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING: npm install of @openai\/codex@0\.160\.0 failed/);
});

test('no login can be restored: MISSING names the login, exit 1', () => {
  const s = sandbox({ codexVersion: '0.160.0', auth: false });
  const r = s.run([], { CLAUDE_CODE_REMOTE: 'true' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING: no Codex login/);
});

test('--save runs auth-store save and prints SAVED', () => {
  const s = sandbox({ codexVersion: '0.160.0' });
  const r = s.run(['--save']);
  assert.equal(r.stdout.trim(), 'SAVED');
  assert.match(s.log(), /auth-store\.js save/);
});
