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

// Throws when the declaration is missing, so a rename can't silently turn the
// guard off. An empty list is valid: that is what releasing the last held
// feature looks like.
function parseHeldFeatures(src) {
  const m = src.match(/\bPROD_HELD_FEATURES\b(?:\s*:[^=]+)?\s*=\s*new\s+Set(?:<[^>]*>)?\(\s*\[([^\]]*)\]\s*\)/);
  if (!m) throw new Error('PROD_HELD_FEATURES declaration not found in src/config/feature-flags.ts');
  const held = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
  // heldFeaturesEnabled matches identifier tokens only; any other name could never match.
  const bad = held.filter(f => !/^[A-Za-z0-9_]+$/.test(f));
  if (bad.length) throw new Error(`PROD_HELD_FEATURES has names the guard cannot match: ${bad.join(', ')}`);
  return held;
}

// The text Next.js could read as NEXT_PUBLIC_FEATURES: everything after the
// last `NEXT_PUBLIC_FEATURES=` line (dotenv: last wins; `export ` allowed),
// plus any following lines up to the next KEY= line, in case a quoted value
// spans lines. Deliberately loose: heldFeaturesEnabled tokenizes it, so stray
// quotes, escapes or comments can only over-report a held name, never hide one.
function featuresFromEnvFile(envText) {
  const lines = envText.split(/\r?\n/);
  const isKey = l => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l);
  let start = -1;
  lines.forEach((l, i) => { if (/^\s*(?:export\s+)?NEXT_PUBLIC_FEATURES\s*=/.test(l)) start = i; });
  if (start < 0) return '';
  const value = [lines[start].replace(/^[^=]*=/, '')];
  for (let i = start + 1; i < lines.length && !isKey(lines[i]); i++) value.push(lines[i]);
  return value.join('\n').trim();
}

// Held features named in a NEXT_PUBLIC_FEATURES value. Splits on every
// character that can't be part of a feature name (commas, quotes, spaces,
// backslashes, #), so formatting can't hide a held name.
function heldFeaturesEnabled(featuresValue, held) {
  const tokens = new Set(String(featuresValue || '').split(/[^A-Za-z0-9_]+/).filter(Boolean));
  return held.filter(f => tokens.has(f));
}

function main(argv = [], env = process.env) {
  const envPath = path.resolve(argv[0] || DEFAULT_ENV_FILE);
  const held = parseHeldFeatures(fs.readFileSync(FLAGS_FILE, 'utf8'));
  if (!fs.existsSync(envPath)) {
    console.error(`::error::${envPath} not found. Run vercel pull --environment=production first.`);
    return 1;
  }
  // The build sees the pulled file and, for deploy-now.js, the caller's shell env too.
  const values = [featuresFromEnvFile(fs.readFileSync(envPath, 'utf8')), env.NEXT_PUBLIC_FEATURES || ''];
  // dotenv-expand could turn $VAR into a held name this check can't see; refuse instead.
  if (values.some(v => v.includes('$'))) {
    console.error('::error::NEXT_PUBLIC_FEATURES uses $ variable expansion, which this guard cannot check. Set it to a literal comma-separated list.');
    return 1;
  }
  const enabled = new Set(values.flatMap(v => heldFeaturesEnabled(v, held)));
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
