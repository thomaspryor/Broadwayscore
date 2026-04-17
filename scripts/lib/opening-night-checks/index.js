'use strict';

const fs = require('fs');
const path = require('path');

const CHECKS_DIR = __dirname;
const SKIP = new Set(['index.js', 'types.js']);

function loadChecks() {
  return fs.readdirSync(CHECKS_DIR)
    .filter(f => f.endsWith('.check.js') && !SKIP.has(f))
    .sort()
    .map(f => {
      const mod = require(path.join(CHECKS_DIR, f));
      if (!mod.name || !mod.description || typeof mod.run !== 'function') {
        throw new Error(`Check file ${f} must export { name, description, run }`);
      }
      return mod;
    });
}

/**
 * Run all registered checks for a show. Supports both sync and async check functions.
 *
 * @param {Object} show        - Entry from shows.json
 * @param {import('./types').CheckContext} context
 * @returns {Promise<{ show: Object, results: import('./types').CheckResult[], summary: { ok: number, warnings: number, errors: number } }>}
 */
async function runChecks(show, context) {
  const checks = loadChecks();
  const results = await Promise.all(checks.map(async check => {
    try {
      const result = await check.run(show, context);
      return { name: check.name, description: check.description, ...result };
    } catch (err) {
      return {
        name: check.name,
        description: check.description,
        ok: false,
        severity: 'error',
        message: `check threw: ${err.message}`,
        details: { stack: err.stack },
      };
    }
  }));

  const summary = results.reduce(
    (acc, r) => {
      if (r.severity === 'error') acc.errors++;
      else if (r.severity === 'warning') acc.warnings++;
      else acc.ok++;
      return acc;
    },
    { ok: 0, warnings: 0, errors: 0 }
  );

  return { show, results, summary };
}

module.exports = { runChecks, loadChecks };
