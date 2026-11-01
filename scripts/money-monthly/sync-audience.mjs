// BRO-6773: sync Profitability Scorecard sign-ups into their OWN Resend audience.
// DRY-RUN BY DEFAULT: reads only, prints counts. --apply adds contacts to the
// money audience (RESEND_MONEY_AUDIENCE_ID, required). Never touches the General
// audience, never creates or sends a broadcast (CLAUDE.md §17). Addresses are
// never printed in full.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planAudienceSync } = require('./audience.js');
const { hasHelpFlag } = require('../lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/money-monthly/sync-audience.mjs [--apply]\nDry-run by default. --apply adds sign-ups not already in General to RESEND_MONEY_AUDIENCE_ID.');
  process.exit(0);
}
const APPLY = process.argv.includes('--apply');
const GENERAL_ID = process.env.RESEND_BROADWAY_AUDIENCE_ID || '472ec5ef-d7cc-4c48-8007-c0a6a302e7a4';
const MONEY_ID = process.env.RESEND_MONEY_AUDIENCE_ID || '';
const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, RESEND_API_KEY: rk } = process.env;
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
if (!rk) throw new Error('RESEND_API_KEY not set');
if (APPLY && !MONEY_ID) throw new Error('--apply needs RESEND_MONEY_AUDIENCE_ID (create the audience in Resend first)');
if (APPLY && MONEY_ID === GENERAL_ID) throw new Error('refusing to write to the General audience');

const mask = (e) => e.replace(/(.{2}).*(@.*)/, '$1***$2');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function readSignups() {
  const rows = [];
  for (let page = 0; page < 100; page++) {
    const u = new URL('/rest/v1/money_scorecard_signups', url);
    u.search = new URLSearchParams({ select: 'email,created_at,unsubscribed_at', order: 'created_at.asc,email.asc', limit: '1000', offset: String(rows.length) }).toString();
    const res = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Supabase read failed: ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error('Supabase read returned a non-array');
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
  throw new Error('Supabase read exceeded page cap');
}
async function readAudience(id) {
  const res = await fetch(`https://api.resend.com/audiences/${id}/contacts`, { signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${rk}` } });
  if (!res.ok) throw new Error(`Resend contacts read failed for ${id.slice(0, 8)}: ${res.status}`);
  const j = await res.json();
  return j.data || [];
}

// BRO-6309: anyone who unsubscribed from the welcome email must not be re-added to the monthly audience.
const signups = (await readSignups()).filter((r) => !r.unsubscribed_at);
const general = await readAudience(GENERAL_ID);
const existing = MONEY_ID ? await readAudience(MONEY_ID) : [];
const plan = planAudienceSync({ signups, general, existing });
console.log(`signups=${signups.length} skipped=${plan.skipped} in_general=${plan.inGeneral.length} already_in_money=${plan.alreadyThere.length} to_add=${plan.toAdd.length}`);
if (!APPLY) {
  console.log(`[dry-run] would add ${plan.toAdd.length} contact(s) to the money audience${MONEY_ID ? '' : ' (RESEND_MONEY_AUDIENCE_ID not set yet)'}. Pass --apply to write.`);
  process.exit(0);
}
let added = 0; let errors = 0;
for (const email of plan.toAdd) {
  const res = await fetch(`https://api.resend.com/audiences/${MONEY_ID}/contacts`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${rk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, unsubscribed: false }),
  });
  if (res.ok) added++; else { errors++; if (errors <= 3) console.error(`add failed for ${mask(email)}: ${res.status}`); }
  await delay(200);
}
console.log(`added=${added} errors=${errors}`);
if (errors) process.exit(1);
