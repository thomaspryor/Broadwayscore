'use strict';
// BRO-6773: plan the sync of money_scorecard_signups into a NEW Resend audience,
// deduped against the General audience so nobody gets two copies. Pure; the
// CLI (sync-audience.mjs) does the I/O and is dry-run by default.
const { isOwnerTestEmail } = require('../lib/admin-money-signups');

const norm = (e) => String(e || '').trim().toLowerCase();

function planAudienceSync({ signups, general, existing }) {
  const generalSet = new Set((general || []).map((c) => norm(c.email || c)));
  const existingSet = new Set((existing || []).map((c) => norm(c.email || c)));
  const seen = new Set();
  const toAdd = []; const inGeneral = []; const alreadyThere = []; let skipped = 0;
  for (const r of signups || []) {
    const email = norm(r && r.email);
    if (!email || !email.includes('@') || isOwnerTestEmail(email) || seen.has(email)) { skipped++; continue; }
    seen.add(email);
    if (existingSet.has(email)) alreadyThere.push(email);
    else if (generalSet.has(email)) inGeneral.push(email);
    else toAdd.push(email);
  }
  return { toAdd, inGeneral, alreadyThere, skipped };
}

// Reads every page of a Resend contacts list. fetchPage(after) resolves to
// { data, has_more }. Throws rather than return a partial list.
async function readAllContactPages(fetchPage, maxPages = 500) {
  const out = []; let after = null;
  for (let i = 0; i < maxPages; i++) {
    const j = await fetchPage(after);
    const data = (j && j.data) || [];
    out.push(...data);
    if (!j || !j.has_more) return out;
    if (!data.length) throw new Error('contacts page said has_more but was empty');
    after = data[data.length - 1].id;
  }
  throw new Error('contacts read exceeded page cap');
}

module.exports = { planAudienceSync, readAllContactPages, norm };
