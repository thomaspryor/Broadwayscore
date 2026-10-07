/**
 * Guard: the global ~/.claude/settings.json "model" default must never be
 * left set to an expensive/unrecognized tier or a "[1m]"-suffixed
 * context-window opt-in (task #1352, 2026-08-12 incident — the default
 * drifted to "claude-fable-5[1m]" for ~40 minutes with no owner action).
 *
 * Requires the real function per CLAUDE.md rule 15 — no copied logic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDisallowedModelDefault,
  decideModelDriftAction,
  DEFAULT_FALLBACK_MODEL,
} from '../../scripts/lib/model-drift-guard.js';

const GUARD_JS = join(process.cwd(), 'scripts/lib/model-drift-guard.js');

// Fresh <tmp>/.claude/settings.json fixture per call, mirroring the real
// layout — the CLI's canonical-path check (ship-check finding: the CLI must
// not blindly trust an arbitrary --settings path) requires the parent
// directory to be literally named ".claude" under the passed --home.
function makeFixture(model) {
  const home = mkdtempSync(join(tmpdir(), 'model-drift-guard-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ model, otherKey: 'preserved' }, null, 2) + '\n');
  return { home, settingsPath };
}

function runApply(home, settingsPath, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [GUARD_JS, 'apply', `--settings=${settingsPath}`, `--home=${home}`, '--session-id=test', ...extraArgs],
    { encoding: 'utf8' }
  );
}

describe('isDisallowedModelDefault', () => {
  test('refuses a "[1m]"-suffixed value on an otherwise-safe tier', () => {
    assert.strictEqual(isDisallowedModelDefault('claude-sonnet-5[1m]'), true);
    assert.strictEqual(isDisallowedModelDefault('opus[1m]'), true);
  });

  test('refuses the exact incident value', () => {
    assert.strictEqual(isDisallowedModelDefault('claude-fable-5[1m]'), true);
  });

  test('refuses fable/mythos tiers regardless of suffix', () => {
    assert.strictEqual(isDisallowedModelDefault('claude-fable-5'), true);
    assert.strictEqual(isDisallowedModelDefault('fable'), true);
    assert.strictEqual(isDisallowedModelDefault('claude-mythos-1'), true);
    assert.strictEqual(isDisallowedModelDefault('mythos'), true);
  });

  test('allows plain safe-tier aliases', () => {
    assert.strictEqual(isDisallowedModelDefault('sonnet'), false);
    assert.strictEqual(isDisallowedModelDefault('opus'), false);
    assert.strictEqual(isDisallowedModelDefault('haiku'), false);
    assert.strictEqual(isDisallowedModelDefault('opusplan'), false);
  });

  test('allows versioned safe-tier model ids', () => {
    assert.strictEqual(isDisallowedModelDefault('claude-sonnet-5'), false);
    assert.strictEqual(isDisallowedModelDefault('claude-opus-4-8'), false);
    assert.strictEqual(isDisallowedModelDefault('claude-haiku-4-5-20251001'), false);
  });

  test('allowlist fails closed on an unrecognized tier name (not just the known-bad ones)', () => {
    assert.strictEqual(isDisallowedModelDefault('claude-turbo-9'), true);
  });

  test('is case-insensitive and tolerates whitespace', () => {
    assert.strictEqual(isDisallowedModelDefault('  SONNET  '), false);
    assert.strictEqual(isDisallowedModelDefault('Claude-Fable-5'), true);
  });

  test('non-string/empty values are not judged (nothing to flag)', () => {
    assert.strictEqual(isDisallowedModelDefault(undefined), false);
    assert.strictEqual(isDisallowedModelDefault(''), false);
    assert.strictEqual(isDisallowedModelDefault(null), false);
  });
});

describe('decideModelDriftAction', () => {
  test('blocks and restores to the recorded intended default', () => {
    const d = decideModelDriftAction({ currentModel: 'claude-fable-5[1m]', intendedDefault: 'opusplan' });
    assert.strictEqual(d.block, true);
    assert.strictEqual(d.restoreValue, 'opusplan');
    assert.match(d.reason, /disallowed/);
  });

  test('falls back to DEFAULT_FALLBACK_MODEL when no intended default is recorded', () => {
    const d = decideModelDriftAction({ currentModel: 'fable', intendedDefault: null });
    assert.strictEqual(d.restoreValue, DEFAULT_FALLBACK_MODEL);
  });

  test('falls back to DEFAULT_FALLBACK_MODEL when the recorded intended default is itself disallowed', () => {
    const d = decideModelDriftAction({ currentModel: 'mythos', intendedDefault: 'claude-fable-5[1m]' });
    assert.strictEqual(d.restoreValue, DEFAULT_FALLBACK_MODEL);
  });

  test('does not block an allowed value, and no restore is proposed', () => {
    const d = decideModelDriftAction({ currentModel: 'sonnet', intendedDefault: 'opusplan' });
    assert.strictEqual(d.block, false);
    assert.strictEqual(d.restoreValue, null);
  });
});

// CLI-integration coverage (ship-check finding: the first draft's comment
// claimed these existed when they didn't — the file-mutating `apply` path
// is what the real hook invokes, so it's the part that must be tested, not
// just the pure regex/decision functions).
describe('CLI: model-drift-guard.js apply', () => {
  const cleanupDirs = [];
  test.after(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  });

  test('reverts a disallowed value, logs it, and exits 2', () => {
    const { home, settingsPath } = makeFixture('claude-fable-5[1m]');
    cleanupDirs.push(home);
    const r = runApply(home, settingsPath);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /disallowed/);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(after.model, 'opusplan');
    assert.strictEqual(after.otherKey, 'preserved', 'unrelated settings.json keys must survive the revert');
    const audit = readFileSync(join(home, '.claude', 'audit-config-changes.jsonl'), 'utf8');
    assert.match(audit, /"event":"model_drift_revert"/);
    assert.match(audit, /"rejected_value":"claude-fable-5\[1m\]"/);
  });

  test('leaves an allowed value untouched and exits 0 silently', () => {
    const { home, settingsPath } = makeFixture('sonnet');
    cleanupDirs.push(home);
    const before = readFileSync(settingsPath, 'utf8');
    const r = runApply(home, settingsPath);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(readFileSync(settingsPath, 'utf8'), before, 'file must be byte-identical when nothing was wrong');
    assert.strictEqual(
      existsSync(join(home, '.claude', 'audit-config-changes.jsonl')),
      false,
      'an allowed value must not write an audit line'
    );
  });

  test('bootstraps the state file on first run and uses it as the restore target on a later violation', () => {
    const { home, settingsPath } = makeFixture('sonnet');
    cleanupDirs.push(home);
    runApply(home, settingsPath); // allowed value, no state file exists yet -> bootstraps one
    const stateFile = join(home, '.claude', 'model-drift-guard-state.json');
    assert.strictEqual(JSON.parse(readFileSync(stateFile, 'utf8')).intendedDefault, DEFAULT_FALLBACK_MODEL);

    // Owner hand-edits the recorded intended default (documented override path)
    writeFileSync(stateFile, JSON.stringify({ intendedDefault: 'opus' }, null, 2) + '\n');
    writeFileSync(settingsPath, JSON.stringify({ model: 'mythos' }, null, 2) + '\n');
    const r = runApply(home, settingsPath);
    assert.strictEqual(r.status, 2);
    assert.strictEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).model, 'opus');
  });

  test('refuses to touch a settings.json that is not the canonical global one', () => {
    const home = mkdtempSync(join(tmpdir(), 'model-drift-guard-'));
    cleanupDirs.push(home);
    // A file named settings.json but NOT under <home>/.claude/ — e.g. a
    // project-local .claude/settings.json living somewhere else entirely.
    const rogueDir = join(home, 'some-project', '.claude');
    mkdirSync(rogueDir, { recursive: true });
    const roguePath = join(rogueDir, 'settings.json');
    writeFileSync(roguePath, JSON.stringify({ model: 'claude-fable-5[1m]' }, null, 2) + '\n');
    const r = runApply(home, roguePath);
    assert.strictEqual(r.status, 0, 'must fail open, not mutate an unexpected path');
    assert.match(r.stderr, /not the canonical/);
    assert.strictEqual(JSON.parse(readFileSync(roguePath, 'utf8')).model, 'claude-fable-5[1m]', 'rogue file must be untouched');
  });

  test('fails open (exit 0) on malformed JSON, with an error record in the audit log', () => {
    const home = mkdtempSync(join(tmpdir(), 'model-drift-guard-'));
    cleanupDirs.push(home);
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    writeFileSync(settingsPath, '{ not valid json');
    const r = runApply(home, settingsPath);
    assert.strictEqual(r.status, 0);
    const audit = readFileSync(join(home, '.claude', 'audit-config-changes.jsonl'), 'utf8');
    assert.match(audit, /"event":"model_drift_guard_error"/);
  });

  test('does nothing when the settings file does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'model-drift-guard-'));
    cleanupDirs.push(home);
    const r = runApply(home, join(home, '.claude', 'settings.json'));
    assert.strictEqual(r.status, 0);
  });
});
