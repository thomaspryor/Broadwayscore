/**
 * Side-effect module: turns on the LLM spend meter (gemini-usage-ledger.js
 * install(), BRO-5043) for this process. Import it FIRST in any file that
 * calls Gemini or OpenAI, before any client is constructed: the openai SDK
 * captures globalThis.fetch at `new OpenAI()`, and ESM evaluates imports in
 * order. Record only; never throws, never prints.
 *   CommonJS:   require('./lib/llm-usage-install');
 *   ESM / TS:   import './lib/llm-usage-install.js';
 * Enforced by tests/unit/llm-usage-install-coverage.test.mjs.
 */
'use strict';

try { require('./gemini-usage-ledger').install(); } catch { /* record only */ }
