'use strict';

// Values emitted by MoneyGate. Never render arbitrary role or first_page text:
// the public signup RPC accepts first_page strings that could contain PII.
const ROLES = ['producer', 'investor', 'industry', 'press', 'fan', 'unspecified'];
const PAGES = ['biz-dashboard', 'biz-biggest-flops', 'biz-fastest-recoups',
  'biz-reviews-and-money', 'biz-musicals-since-reopening', 'biz-season',
  'biz-developments', 'biz-tony-winners', 'show-page'];
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

/** Read-only, bounded PostgREST scan. Missing credentials mean no section;
 * failed/incomplete reads mean unavailable, never a partial or zero total.
 * No email column, response body or exception text is logged or returned.
 */
async function collectMoneySignups({ env = process.env, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!env.NEXT_PUBLIC_SUPABASE_URL) return { unavailable: true };
  const end = new Date(now).getTime();
  const start = end - 24 * 60 * 60 * 1000;
  const roles = Object.fromEntries(ROLES.map(role => [role, 0]));
  const pages = Object.fromEntries([...PAGES, 'other'].map(page => [page, 0]));
  let total = 0;
  let last24h = 0;
  try {
    const signal = AbortSignal.timeout(15000);
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('/rest/v1/money_scorecard_signups', env.NEXT_PUBLIC_SUPABASE_URL);
      url.search = new URLSearchParams({
        select: 'created_at,role,first_page',
        // Stable order even when timestamps tie; email is never selected.
        order: 'created_at.asc,email.asc',
        created_at: `lte.${new Date(end).toISOString()}`,
        limit: String(PAGE_SIZE), offset: String(total),
      }).toString();
      const response = await fetchImpl(url, {
        method: 'GET', signal,
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'count=exact',
        },
      });
      if (!response.ok) return { unavailable: true };
      const range = response.headers.get('content-range');
      const match = range && range.match(/^(?:(\d+)-(\d+)|\*)\/(\d+)$/);
      const rows = await response.json();
      if (!match || !Array.isArray(rows)) return { unavailable: true };
      const expected = Number(match[3]);
      if (rows.length && (Number(match[1]) !== total || Number(match[2]) !== total + rows.length - 1)) return { unavailable: true };
      for (const row of rows) {
        const created = Date.parse(row?.created_at);
        if (!Number.isFinite(created) || created > end) return { unavailable: true };
        total++;
        if (created >= start) last24h++;
        roles[ROLES.includes(row.role) ? row.role : 'unspecified']++;
        // MoneyGate writes `${page}:${pathname}`. Aggregate by the fixed page
        // identifier, discarding paths (including show slugs) entirely.
        const pageName = typeof row.first_page === 'string' ? row.first_page.split(':')[0] : null;
        pages[PAGES.includes(pageName) ? pageName : 'other']++;
      }
      if (total === expected) {
        return { total, last24h, roles, topPages: Object.entries(pages)
          .filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5) };
      }
      if (!rows.length || total > expected) return { unavailable: true };
    }
  } catch { /* Never expose upstream errors, keys or signup fields. */ }
  return { unavailable: true };
}

function renderMoneySignups(summary) {
  if (!summary) return '';
  if (summary.unavailable) return '<p><strong>Money Scorecard sign-ups</strong>: temporarily unavailable.</p>';
  const roles = ROLES.map(role => `${role[0].toUpperCase()}${role.slice(1)}: ${summary.roles[role]}`).join(' · ');
  const pages = summary.topPages.map(([page, count]) => `${page}: ${count}`).join(' · ');
  return `<p><strong>Money Scorecard sign-ups</strong><br>Total sign-ups: ${summary.total} · Last 24h: ${summary.last24h}<br>${roles}${pages ? `<br>Top first pages (grouped): ${pages}` : ''}</p>`;
}

module.exports = { collectMoneySignups, renderMoneySignups };
