import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getStaleEnvWarning, MAX_CHARS } = require('../../scripts/lib/compact-state.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const hook = path.join(root, '.claude/hooks/compact-state.sh');
const settingsEnv = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).env;
const windowKey = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const disableKey = 'CLAUDE_CODE_DISABLE_1M_CONTEXT';

test('comparison warns for the original stale environment against real project settings', () => {
  const warning = getStaleEnvWarning(settingsEnv, { [windowKey]: '200000', [disableKey]: '1' });
  assert.match(warning, /^Stale env:/);
  assert.match(warning, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  assert.match(warning, /CLAUDE_CODE_DISABLE_1M_CONTEXT/);
  assert.match(warning, /fresh session \(create_session\)/);
  assert.match(warning, /close-out here/);
  assert.equal(warning.split('\n').length, 1);
});

test('matching, absent and empty values are silent; unrelated environment keys are ignored', () => {
  assert.equal(getStaleEnvWarning(settingsEnv, { ...settingsEnv, UNRELATED_KEY: 'anything' }), '');
  assert.equal(getStaleEnvWarning({}, {}), '');
  assert.equal(getStaleEnvWarning({}, { [windowKey]: '', [disableKey]: '' }), '');
  assert.match(getStaleEnvWarning(undefined, { [disableKey]: '1' }), /Stale env:/);
});

test('each compaction key is checked independently, including keys removed from settings', () => {
  for (const key of [windowKey, disableKey]) {
    assert.match(getStaleEnvWarning({ [key]: 'new' }, { [key]: 'old' }), new RegExp(key));
    assert.match(getStaleEnvWarning({ [key]: 'new' }, {}), new RegExp(key));
    assert.match(getStaleEnvWarning({}, { [key]: 'old' }), new RegExp(key));
    assert.equal(getStaleEnvWarning({ [key]: 'same' }, { [key]: 'same' }), '');
  }
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, '.claude/compact-state-stale-env-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.symlinkSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), 'dir');
  const settingsPath = path.join(dir, '.claude/settings.json');
  const configure = (env) => fs.writeFileSync(settingsPath, JSON.stringify({ env }));
  configure(settingsEnv);
  const liveEnv = { ...process.env, HOME: path.join(dir, 'home'), TMPDIR: dir, CLAUDE_PROJECT_DIR: dir };
  delete liveEnv[windowKey];
  delete liveEnv[disableKey];
  Object.assign(liveEnv, settingsEnv);
  const run = (event, overrides = {}) => {
    const env = { ...liveEnv, ...overrides };
    for (const key of [windowKey, disableKey]) if (env[key] === undefined) delete env[key];
    return execFileSyncStdinFile('bash', [hook], {
      cwd: dir, env, encoding: 'utf8',
      input: JSON.stringify({ session_id: 'stale-env-test', ...event }),
    });
  };
  const write = (overrides) => assert.equal(run({ hook_event_name: 'PreCompact' }, overrides), '');
  const restore = (overrides) => run({ hook_event_name: 'SessionStart', source: 'compact' }, overrides);
  return { dir, settingsPath, configure, run, write, restore };
}

for (const [name, overrides, warns] of [
  ['old window and disabled 1M', { [windowKey]: '200000', [disableKey]: '1' }, true],
  ['old window only', { [windowKey]: '200000' }, true],
  ['removed disable key only', { [disableKey]: '1' }, true],
  ['matching environment', {}, false],
]) {
  test(`shell hook restores checkpoint with ${name}`, (t) => {
    const f = fixture(t);
    f.write(overrides);
    const out = JSON.parse(f.restore(overrides));
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    const text = out.hookSpecificOutput.additionalContext;
    assert.match(text, /^# Compaction checkpoint/);
    assert.equal(text.includes('Stale env:'), warns);
    assert.ok(text.length <= MAX_CHARS);
    assert.equal(f.restore(overrides), '', 'checkpoint remains single-use');
  });
}

test('restore compares current settings, including a change since PreCompact', (t) => {
  const f = fixture(t);
  const stale = { [windowKey]: '200000', [disableKey]: '1' };
  f.configure(stale);
  f.write(stale);
  f.configure(settingsEnv);
  assert.match(JSON.parse(f.restore(stale)).hookSpecificOutput.additionalContext, /Stale env:/);
});

for (const [name, content] of [
  ['missing settings', null],
  ['invalid JSON', '{'],
  ['null settings', 'null'],
  ['invalid env object', '{"env":null}'],
]) {
  test(`${name} preserves the restored checkpoint without a warning`, (t) => {
    const f = fixture(t);
    f.write();
    if (content === null) fs.unlinkSync(f.settingsPath);
    else fs.writeFileSync(f.settingsPath, content);
    const text = JSON.parse(f.restore()).hookSpecificOutput.additionalContext;
    assert.match(text, /^# Compaction checkpoint/);
    assert.doesNotMatch(text, /Stale env:/);
  });
}

test('removing the entire env object still detects retained compaction overrides', (t) => {
  const f = fixture(t);
  f.write();
  fs.writeFileSync(f.settingsPath, '{}');
  assert.match(JSON.parse(f.restore()).hookSpecificOutput.additionalContext, /Stale env:/);
});

test('stale warning survives a full checkpoint without exceeding its context budget', (t) => {
  const f = fixture(t);
  f.write();
  const checkpoint = path.join(f.dir, 'bsc-compact-state/stale-env-test.md');
  fs.writeFileSync(checkpoint, 'x'.repeat(MAX_CHARS));
  const text = JSON.parse(f.restore({ [windowKey]: '200000' })).hookSpecificOutput.additionalContext;
  assert.ok(text.length <= MAX_CHARS);
  assert.match(text, /Stale env:/);
  assert.match(text, /close-out here\.$/);
});

test('startup and restores without a checkpoint remain silent even with stale env', (t) => {
  const f = fixture(t);
  const stale = { [windowKey]: '200000', [disableKey]: '1' };
  f.write(stale);
  assert.equal(f.run({ hook_event_name: 'SessionStart', source: 'startup' }, stale), '');
  assert.match(f.restore(stale), /Stale env:/);
  assert.equal(f.restore(stale), '');
});
