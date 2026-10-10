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
 * Exit 0 = nothing held is enabled; 1 = held feature enabled, env file missing,
 * or an env file this guard can't read with certainty.
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

// `KEY=value`, `export KEY=value` or `KEY: value`: every form either env loader
// accepts (see featuresFromEnvFile).
const KEY_LINE = /^\s*(?:export\s+)?([\w.-]+)\s*(?:=|:\s)(.*)$/;
// The Vercel CLI's loader (dotenv 4) splits on \n only and skips any line this
// doesn't match whole, so this is exactly when it sets NEXT_PUBLIC_FEATURES.
const VERCEL_LOADER_SETS = /^\s*NEXT_PUBLIC_FEATURES\s*=\s*(.*)?\s*$/;
const setByVercelLoader = text => text.split('\n').some(line => VERCEL_LOADER_SETS.test(line));
// Line breaks to Next's dotenv that `vercel pull` leaves raw inside a value (it
// escapes only \n and \r), so a secret can hold one.
const UNESCAPED_BREAKS = /[\u2028\u2029]/;
// The repo's own env files `next build` reads for a production build.
const NEXT_ENV_FILES = ['.env.production.local', '.env.local', '.env.production', '.env'];

// True when a quoted value has no closing quote on its own line (a backslash
// escapes the quote, as in Next's dotenv), so the value could run onto later lines.
function opensQuote(value) {
  const q = value[0];
  if (!['"', "'", '`'].includes(q)) return false;
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '\\' && value[i + 1] === q) i++;
    else if (value[i] === q) return false;
  }
  return true;
}

// Every NEXT_PUBLIC_FEATURES value in an env file, joined. `vercel build` loads
// the pulled file with the Vercel CLI's own dotenv 4 (one KEY=value per line, last
// wins); Next's dotenv 16 also takes `export`, `KEY: value` and multi-line quotes.
// Reading every matching line under either grammar can only over-report. Throws
// on anything else: `vercel pull` writes one KEY="value" per line (newlines
// escaped), so a line that isn't one, or a NEXT_PUBLIC_FEATURES quote left open,
// means a value this guard can't see. Messages name line numbers only, never
// values, since other keys hold secrets.
function featuresFromEnvFile(envText) {
  const values = [];
  envText.split(/\r?\n/).forEach((line, i) => {
    // Next's dotenv reads a lone \r as a line break; vercel pull escapes them.
    if (line.includes('\r')) throw new Error(`line ${i + 1} has a bare carriage return, so a value may span lines this guard can't check`);
    // It also starts a new line after U+2028/U+2029 and reads them as spaces, so
    // the key named after one could be set in forms this guard doesn't parse.
    const [head, ...rest] = line.split(UNESCAPED_BREAKS);
    if (rest.some(part => part.includes('NEXT_PUBLIC_FEATURES'))) throw new Error(`line ${i + 1} names NEXT_PUBLIC_FEATURES after a U+2028/U+2029 line separator`);
    if (!head.trim() || /^\s*#/.test(head)) return;
    const m = head.match(KEY_LINE);
    if (!m) throw new Error(`line ${i + 1} is not a KEY=value line, so a value may span lines this guard can't check`);
    if (m[1] !== 'NEXT_PUBLIC_FEATURES') return;
    // The value runs on past any U+2028/U+2029 to the end of the line.
    const value = [m[2], ...rest].join(' ').trim();
    // Next's dotenv lets whitespace (\n and U+2028 included) run from = to a quoted
    // value on a later line. vercel pull writes an empty value as "".
    if (!value) throw new Error(`line ${i + 1}: NEXT_PUBLIC_FEATURES has no value, so Next's dotenv may take one from a later line`);
    if (opensQuote(value)) throw new Error(`line ${i + 1}: NEXT_PUBLIC_FEATURES opens a quote it doesn't close, so its value may continue on later lines`);
    values.push(value);
  });
  return values.join('\n');
}

// Held features named in a NEXT_PUBLIC_FEATURES value. Escaped line breaks (\n,
// \r) become separators, as both loaders turn them into real ones; then it splits
// on every character that can't be part of a feature name (commas, quotes,
// spaces, backslashes, #), so formatting can't hide a held name.
function heldFeaturesEnabled(featuresValue, held) {
  const text = String(featuresValue || '').replace(/\\[nr]/g, ' ');
  const tokens = new Set(text.split(/[^A-Za-z0-9_]+/).filter(Boolean));
  return held.filter(f => tokens.has(f));
}

function main(argv = [], env = process.env, rootDir = REPO_ROOT) {
  const envPath = path.resolve(argv[0] || DEFAULT_ENV_FILE);
  const held = parseHeldFeatures(fs.readFileSync(FLAGS_FILE, 'utf8'));
  if (!fs.existsSync(envPath)) {
    console.error(`::error::${envPath} not found. Run vercel pull --environment=production first.`);
    return 1;
  }
  const pulled = fs.readFileSync(envPath, 'utf8');
  let fileValue;
  try {
    fileValue = featuresFromEnvFile(pulled);
  } catch (e) {
    console.error(`::error::${path.basename(envPath)} ${e.message}. Not deploying.`);
    return 1;
  }
  // `vercel build` loads the pulled file without overriding the shell; `next
  // build` falls back to the repo's own env files only when neither sets the key.
  if (env.NEXT_PUBLIC_FEATURES === undefined && !setByVercelLoader(pulled)) {
    const local = NEXT_ENV_FILES.filter(f => {
      const p = path.join(rootDir, f);
      return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('NEXT_PUBLIC_FEATURES');
    });
    if (local.length) {
      console.error(`::error::Production doesn't set NEXT_PUBLIC_FEATURES, so the build would take it from ${local.join(', ')}. Set it in the Vercel production env instead.`);
      return 1;
    }
  }
  // The build sees the pulled file and, for deploy-now.js, the caller's shell env too.
  const values = [fileValue, env.NEXT_PUBLIC_FEATURES || ''];
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
