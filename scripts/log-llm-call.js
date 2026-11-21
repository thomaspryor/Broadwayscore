#!/usr/bin/env node
/**
 * Log one session-side LLM call to the usage ledger (BRO-7521): curl calls
 * from slash commands and hooks never touch Node fetch, so they were invisible.
 * Pipe the raw JSON response in; one row (kind "session") is appended.
 *   curl -s ... | tee /tmp/r.json; node scripts/log-llm-call.js --provider=openai --caller=ship-check < /tmp/r.json
 * Prints nothing, exits 0 always (record only; never breaks the calling command).
 */
const fs = require('fs');
const { logSessionCall } = require('./lib/gemini-usage-ledger');

const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : undefined; };
try {
  const response = fs.readFileSync(0, 'utf8');
  logSessionCall({ provider: arg('provider'), model: arg('model'), response, caller: arg('caller') });
} catch { /* record only */ }
process.exit(0);
