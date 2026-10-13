#!/usr/bin/env node
/**
 * Checks that the env NAMES our serverless routes read at runtime exist in the
 * pulled Vercel production env (BRO-5170). LINEAR_API_KEY was never added to
 * Vercel, so every digest "Fix this" tap failed with "Could Not Start the Fix"
 * and nothing caught it until the owner tapped one.
 *
 * Usage: node scripts/lib/check-vercel-required-env.js [envFile] [--strict]
 *   envFile defaults to .vercel/.env.production.local (written by `vercel pull`).
 *   Without --strict a missing name prints a ::warning:: and exits 0 (advisory,
 *   CLAUDE.md rule 19); with --strict it exits 1.
 *
 * Names only, never values: a Vercel "sensitive" var comes back from
 * `vercel pull` with an empty value, so a present-but-empty name counts as
 * present and is only noted. Values are never printed.
 *
 * Keep RUNTIME_ENV in step with the routes: tests/unit/check-vercel-required-env.test.mjs
 * greps each route listed here for process.env.X and fails on a name not covered.
 */

'use strict';

require('./cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { parseEnvFile } = require('./load-env.js');

// route file -> { required: names the route cannot work without,
//                 optional: names it reads but is fine without (kill switches) }
const RUNTIME_ENV = {
  'src/app/api/autonomous-action/route.ts': {
    required: ['APPROVAL_HMAC_SECRET', 'LINEAR_API_KEY'],
    optional: ['DISPATCH_LINKS_DISABLED'],
  },
  // BRO-3712 one-tap Gmail renewal: the owner taps these from an email.
  'src/app/api/admin/gmail-reauth/route.ts': {
    required: ['APPROVAL_HMAC_SECRET', 'GMAIL_CLIENT_ID'],
    optional: ['GMAIL_REAUTH_DISABLED'],
  },
  'src/app/api/admin/gmail-reauth/callback/route.ts': {
    required: ['APPROVAL_HMAC_SECRET', 'GH_DISPATCH_TOKEN'],
    optional: ['GMAIL_REAUTH_DISABLED'],
  },
  // BRO-5235 Mezzanine token renewal: the owner pastes the token here.
  'src/app/api/admin/mezzanine-token/route.ts': {
    required: ['APPROVAL_HMAC_SECRET', 'GH_DISPATCH_TOKEN'],
    optional: ['MEZZANINE_TOKEN_FORM_DISABLED'],
  },
};

function requiredNames(runtimeEnv = RUNTIME_ENV) {
  return [...new Set(Object.values(runtimeEnv).flatMap(r => r.required))].sort();
}

// Every process.env name any API route reads, for an informational note (not a
// failure): the other routes' needs were never written down, so listing what is
// absent shows the next BRO-5170 before someone taps into it.
function scanApiRouteEnv(rootDir) {
  const out = {};
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^route\.(ts|js)$/.test(e.name)) {
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
          (out[m[1]] = out[m[1]] || new Set()).add(path.relative(rootDir, full));
        }
      }
    }
  };
  walk(path.join(rootDir, 'src', 'app', 'api'));
  return out;
}

/** @returns {{ missing: string[], empty: string[] }} */
function checkEnv(env, names) {
  const missing = [];
  const empty = [];
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) missing.push(name);
    else if (env[name] === '') empty.push(name);
  }
  return { missing, empty };
}

function main(argv = process.argv.slice(2)) {
  const strict = argv.includes('--strict');
  const file = argv.find(a => !a.startsWith('--')) || '.vercel/.env.production.local';
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    console.log(`::warning::check-vercel-required-env: cannot read ${file} (${err.code || err.message}); did vercel pull run?`);
    return strict ? 1 : 0;
  }
  const names = requiredNames();
  const { missing, empty } = checkEnv(parseEnvFile(raw), names);
  for (const name of empty) {
    console.log(`note: ${name} is present with an empty value (normal for a Vercel "sensitive" var)`);
  }
  const env = parseEnvFile(raw);
  const others = scanApiRouteEnv(path.join(__dirname, '..', '..'));
  const optional = Object.values(RUNTIME_ENV).flatMap(r => r.optional);
  const absent = Object.keys(others)
    .filter(n => !names.includes(n) && !optional.includes(n) && !(n in env)).sort();
  if (absent.length) {
    console.log(`note: other API routes read names absent from Vercel production (informational): ${absent.join(', ')}`);
  }
  if (missing.length) {
    const level = strict ? 'error' : 'warning';
    console.log(`::${level}::Vercel production env is missing runtime names: ${missing.join(', ')}. ` +
      'Add them with the "Sync env to Vercel" workflow (sync-vercel-env.yml), then redeploy.');
    return strict ? 1 : 0;
  }
  console.log(`✓ Vercel production env has all runtime names: ${names.join(', ')}`);
  return 0;
}

module.exports = { RUNTIME_ENV, requiredNames, checkEnv, scanApiRouteEnv, main };

if (require.main === module) process.exit(main());
