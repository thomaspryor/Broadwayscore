'use strict';
// BRO-6773: plan the sync of money_scorecard_signups into a NEW Resend audience,
// deduped against the General audience so nobody gets two copies. Pure; the
// CLI (sync-audience.mjs) does the I/O and is dry-run by default.
const { isOwnerTestEmail } = require('../lib/admin-money-signups');

const norm = (e) => String(e || '').trim().toLowerCase();

function planAudienceSync({ signups, general, existing }) {
  // BRO-6309: rows with unsubscribed_at are never added, and are flagged unsubscribed if already in the audience.
  const unsub = new Set((signups || []).filter((r) => r && r.unsubscribed_at).map((r) => norm(r.email)));
  const toUnsubscribe = (existing || []).filter((c) => c && c.id && !c.unsubscribed && unsub.has(norm(c.email || c)));
  const generalSet = new Set((general || []).map((c) => norm(c.email || c)));
  const existingSet = new Set((existing || []).map((c) => norm(c.email || c)));
  const seen = new Set();
  const toAdd = []; const inGeneral = []; const alreadyThere = []; let skipped = 0;
  for (const r of signups || []) {
    const email = norm(r && r.email);
    if (!email || !email.includes('@') || isOwnerTestEmail(email) || seen.has(email) || unsub.has(email)) { skipped++; continue; }
    seen.add(email);
    if (existingSet.has(email)) alreadyThere.push(email);
    else if (generalSet.has(email)) inGeneral.push(email);
    else toAdd.push(email);
  }
  return { toAdd, inGeneral, alreadyThere, skipped, toUnsubscribe };
}

module.exports = { planAudienceSync, norm };
