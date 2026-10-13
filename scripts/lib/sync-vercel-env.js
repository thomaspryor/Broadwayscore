#!/usr/bin/env node
/**
 * Copies env vars from this process (GitHub Actions secrets) into the Vercel
 * project's production env (BRO-5170). Idempotent: an existing entry that
 * already targets production gets its value PATCHed (keeping its other
 * targets); otherwise a new production entry is created. Values are never
 * printed. Env changes only reach NEW deployments, so redeploy after.
 *
 * Usage: VERCEL_TOKEN=... LINEAR_API_KEY=... node scripts/lib/sync-vercel-env.js --names=LINEAR_API_KEY[,OTHER]
 */

'use strict';

require('./cli-help').exitOnHelp(module);

const PROJECT_ID = 'prj_wmBnDUrCQCwabIAYPbnMiIP3wg15'; // same id vercel-deploy.yml uses
const API = 'https://api.vercel.com';
// Names this script may copy into the site's runtime. Hard-coded so a dispatch
// can never ship VERCEL_TOKEN (or PATH) into the production env; add a name
// here and map its secret in sync-vercel-env.yml together.
// GMAIL_CLIENT_ID (BRO-3712) is public by OAuth design; its client secret is
// deliberately NOT here and stays in GitHub Actions only.
const ALLOWED = new Set(['LINEAR_API_KEY', 'GMAIL_CLIENT_ID']);

function parseNames(argv) {
  const arg = argv.find(a => a.startsWith('--names='));
  const names = (arg ? arg.slice(8) : 'LINEAR_API_KEY').split(',').map(s => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!ALLOWED.has(n)) throw new Error(`not in the sync allowlist: ${n} (allowed: ${[...ALLOWED].join(', ')})`);
  }
  return names;
}

/**
 * Decide what to do for one key given the project's existing env entries.
 * @returns {{ action: 'patch', id: string, body: object } | { action: 'create', body: object }}
 */
function planUpsert(existing, key, value) {
  const match = (existing || []).find(e => e.key === key && (e.target || []).includes('production'));
  if (match) return { action: 'patch', id: match.id, body: { value } };
  return { action: 'create', body: { key, value, type: 'encrypted', target: ['production'] } };
}

async function vercel(token, method, url, body) {
  const res = await fetch(`${API}${url}`, {
    signal: AbortSignal.timeout(60000),
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    // error.code/message only; never echo the request body (it holds the value)
    throw new Error(`${method} ${url.split('?')[0]} -> ${res.status} ${json.error?.code || ''} ${json.error?.message || ''}`.trim());
  }
  return json;
}

async function main(argv = process.argv.slice(2)) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) { console.error('VERCEL_TOKEN is not set'); return 1; }
  const names = parseNames(argv);
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) {
    // Never upsert an empty secret over a working one.
    console.error(`not set or empty in this job, refusing to sync: ${missing.join(', ')}`);
    return 1;
  }
  const { envs } = await vercel(token, 'GET', `/v9/projects/${PROJECT_ID}/env`);
  for (const key of names) {
    const plan = planUpsert(envs, key, process.env[key]);
    if (plan.action === 'patch') {
      const out = await vercel(token, 'PATCH', `/v9/projects/${PROJECT_ID}/env/${plan.id}`, plan.body);
      console.log(`${key}: updated existing entry (type=${out.type || '?'}, targets=${(out.target || []).join('+')})`);
    } else {
      const out = await vercel(token, 'POST', `/v10/projects/${PROJECT_ID}/env`, plan.body);
      if (Array.isArray(out.failed) && out.failed.length) {
        throw new Error(`${key}: Vercel reported a failed create (${out.failed.map(f => f.error?.code || '?').join(', ')})`);
      }
      const created = Array.isArray(out.created) ? out.created[0] || {} : out.created || out;
      console.log(`${key}: created production entry (type=${created.type || '?'})`);
    }
  }
  return 0;
}

module.exports = { parseNames, planUpsert, PROJECT_ID, ALLOWED };

if (require.main === module) {
  main().then(code => process.exit(code), err => { console.error(err.message); process.exit(1); });
}
