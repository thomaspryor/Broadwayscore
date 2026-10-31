'use strict';

/**
 * Resolve a non-negative integer env override once at startup.
 * Unset or blank values use the caller's default; malformed values stop the
 * run instead of silently disabling a cap or accepting a partial number.
 */
function resolveIntEnv(raw, { fallback, name }) {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') return fallback;

  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
    throw new Error(
      `${name} must be a non-negative integer within the safe integer range, got "${raw}". ` +
        'Refusing to start with an invalid cap.',
    );
  }
  return value;
}

module.exports = { resolveIntEnv };
