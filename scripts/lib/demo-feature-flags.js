'use strict';
/**
 * Feature flags the public demo build (vercel-demo.yml) turns on: every
 * `get X()` flag in src/config/feature-flags.ts EXCEPT the prod-held ones,
 * unless DEMO_HELD_ALLOWLIST names them. demo.broadwayscorecard.com is
 * publicly reachable, so a held feature on demo is a public leak (BRO-5007).
 *
 * `commercial` is allowlisted: its demo behavior is pending an owner decision
 * and this change leaves it as it was.
 *
 *   node scripts/lib/demo-feature-flags.js   -> prints the comma-separated list
 */
const fs = require('fs');
const path = require('path');
const { parseHeldFeatures } = require('./prod-held-flags-guard');

/** Prod-held flags the demo build may still enable. */
const DEMO_HELD_ALLOWLIST = new Set(['commercial']);

function computeDemoFlags(flagsSrc, allowlist = DEMO_HELD_ALLOWLIST) {
  const flags = [...flagsSrc.matchAll(/get\s+(\w+)\(\)/g)].map((m) => m[1]);
  const held = new Set(parseHeldFeatures(flagsSrc));
  return flags.filter((f) => !held.has(f) || allowlist.has(f));
}

module.exports = { computeDemoFlags, DEMO_HELD_ALLOWLIST };

if (require.main === module) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'config', 'feature-flags.ts'), 'utf8');
  const flags = computeDemoFlags(src);
  if (flags.length < 5) {
    console.error('Only found', flags.length, 'flags — aborting');
    process.exit(1);
  }
  process.stdout.write(flags.join(','));
}
