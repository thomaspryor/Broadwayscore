#!/usr/bin/env node
/**
 * prod-held-flags-guard.js
 *
 * Refuses a production deploy while NEXT_PUBLIC_FEATURES enables a feature the
 * owner has held back (PROD_HELD_FEATURES in src/config/feature-flags.ts).
 * BRO-4525: the commercial scorecard is not to be released.
 *
 * Run after `vercel pull --environment=production` and before
 * `vercel build --prod`, by both prod deploy paths: vercel-deploy.yml and
 * scripts/deploy-now.js. The demo deploy (vercel-demo.yml) turns every flag on
 * and does not run this.
 *
 * Usage: node scripts/lib/prod-held-flags-guard.js [path/to/.env.production.local]
 * Exit 0 = nothing held is enabled, 1 = held feature enabled or env file missing.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FLAGS_FILE = path.join(REPO_ROOT, 'src', 'config', 'feature-flags.ts');
const DEFAULT_ENV_FILE = path.join(REPO_ROOT, '.vercel', '.env.production.local');

const unquote = s => s.trim().replace(/^['"]|['"]$/g, '').trim();

// Throws when the declaration is missing, so a rename can't silently turn the
// guard off. An empty list is valid: that is what releasing the last held
// feature looks like.
function parseHeldFeatures(src) {
  const m = src.match(/\bPROD_HELD_FEATURES\b(?:\s*:[^=]+)?\s*=\s*new\s+Set(?:<[^>]*>)?\(\s*\[([^\]]*)\]\s*\)/);
  if (!m) throw new Error('PROD_HELD_FEATURES declaration not found in src/config/feature-flags.ts');
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
}

// The NEXT_PUBLIC_FEATURES value from a dotenv file's text ('' when absent).
function featuresFromEnvFile(envText) {
  const line = envText.split(/\r?\n/).find(l => /^\s*NEXT_PUBLIC_FEATURES\s*=/.test(l));
  return line ? unquote(line.slice(line.indexOf('=') + 1)) : '';
}

// Held features named in a comma-separated NEXT_PUBLIC_FEATURES value.
function heldFeaturesEnabled(featuresValue, held) {
  const on = new Set(String(featuresValue || '').split(',').map(unquote).filter(Boolean));
  return held.filter(f => on.has(f));
}

function main(argv = [], env = process.env) {
  const envPath = path.resolve(argv[0] || DEFAULT_ENV_FILE);
  const held = parseHeldFeatures(fs.readFileSync(FLAGS_FILE, 'utf8'));
  if (!fs.existsSync(envPath)) {
    console.error(`::error::${envPath} not found. Run vercel pull --environment=production first.`);
    return 1;
  }
  // The build sees the pulled file and, for deploy-now.js, the caller's shell env too.
  const enabled = new Set([
    ...heldFeaturesEnabled(featuresFromEnvFile(fs.readFileSync(envPath, 'utf8')), held),
    ...heldFeaturesEnabled(env.NEXT_PUBLIC_FEATURES, held),
  ]);
  if (enabled.size) {
    for (const f of enabled) {
      console.error(`::error::Production NEXT_PUBLIC_FEATURES enables '${f}', which the owner has held back (PROD_HELD_FEATURES in src/config/feature-flags.ts).`);
    }
    console.error('::error::Remove it from the Vercel production env, or take it out of PROD_HELD_FEATURES once the owner approves the release.');
    return 1;
  }
  console.log(`✓ No owner-held features enabled in production (held: ${held.join(', ') || 'none'})`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { parseHeldFeatures, featuresFromEnvFile, heldFeaturesEnabled, main };
