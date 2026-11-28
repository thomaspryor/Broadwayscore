'use strict';
/**
 * Parse a JSON (optionally base64-encoded) credential held in an env var
 * WITHOUT ever echoing its value. Node's own JSON.parse SyntaxError can embed
 * a fragment of the input, which leaked the ga-reader key into a transcript
 * (BRO-7525). On failure we throw an error that names only the variable.
 */
function parseEnvJson(name, { base64 = false, env = process.env } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') throw new Error(`${name} is not set`);
  try {
    const text = base64 ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    return JSON.parse(text);
  } catch (_) {
    // Deliberately discard the original error: its message may contain the value.
    throw new Error(`${name} could not be parsed as ${base64 ? 'base64-encoded ' : ''}JSON (value not shown)`);
  }
}
module.exports = { parseEnvJson };
