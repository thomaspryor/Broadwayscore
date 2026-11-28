'use strict';

/**
 * cli-args.js — the one `--flag` parser for the Linear CLIs (BRO-2628,
 * BRO-2630). linear-next.js, linear-session.js and linear-drain-parked.js
 * each carried their own copy; one had no `--k=v` support at all, so
 * `linear-drain-parked.js --cap=5` silently ran with the default cap.
 *
 *   --k=v       value v (split on the FIRST '=')
 *   --k v       value v, when the next token is not itself a flag
 *   --k         true
 *   other       pushed to args[positionalKey]
 *
 * coerceBooleans: a `--k=v` whose v is '', '0' or 'false' (any case) becomes
 * boolean false, because every switch is read with a truthiness check and
 * `--force=0` must not mean force (BRO-2543/BRO-2576). It applies to every
 * flag EXCEPT the declared free-text `textFlags`, on purpose: a new flag
 * nobody declared is treated as a switch, the safe direction for a guard
 * bypass. A declared free-text flag keeps '0'/'false' as typed.
 *
 * @param {string[]} argv
 * @param {{coerceBooleans?: boolean, textFlags?: string[], positionalKey?: string}} [opts]
 * @returns {Record<string, any>}
 */
function parseArgs(argv, { coerceBooleans = false, textFlags = [], positionalKey = '_' } = {}) {
  const text = new Set(textFlags);
  const args = { [positionalKey]: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) { args[positionalKey].push(tok); continue; }
    const raw = tok.slice(2);
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      const key = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      args[key] = coerceBooleans && !text.has(key) ? coerceFlagValue(value) : value;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[raw] = true;
    else { args[raw] = next; i++; }
  }
  return args;
}

/** '', '0', 'false' (case-insensitive) mean off; anything else passes through. */
function coerceFlagValue(v) {
  if (v === '' || v.toLowerCase() === '0' || v.toLowerCase() === 'false') return false;
  return v;
}

module.exports = { parseArgs, coerceFlagValue };
