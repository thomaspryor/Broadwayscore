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
import {
  isDisallowedModelDefault,
  decideModelDriftAction,
  DEFAULT_FALLBACK_MODEL,
} from '../../scripts/lib/model-drift-guard.js';

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
