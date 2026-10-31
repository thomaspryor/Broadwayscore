'use strict';

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Owner test addresses are excluded from both counts and the daily list. */
function isOwnerTestEmail(email) {
  const normalized = email.trim().toLowerCase();
  return normalized.startsWith('thomas.pryor') || normalized.startsWith('tom_pryor@');
}

function summarizeMoneySignups(rows, now) {
  const end = new Date(now).getTime();
  const start = end - 7 * DAY_MS;
  const days = new Map();
  let total = 0;
  let last7Days = 0;
  for (const row of rows) {
    const created = Date.parse(row?.created_at);
    if (typeof row?.email !== 'string' || !Number.isFinite(created) || created > end) {
      throw new Error('Invalid signup record');
    }
    if (isOwnerTestEmail(row.email)) continue;
    const date = new Date(created).toISOString().slice(0, 10);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({
      email: row.email, createdAt: new Date(created).toISOString(),
      role: row.role || 'Unspecified', firstPage: row.first_page || 'Unspecified',
    });
    total++;
    if (created >= start) last7Days++;
  }
  return {
    total, last7Days,
    days: [...days.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, signups]) => ({
      date, signups: signups.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.email.localeCompare(b.email)),
    })),
  };
}

/**
 * Called only by the authorized server page. Explicit credentials prevent an
 * accidental browser import from acquiring a service key. No signup fields,
 * response bodies or upstream errors are logged. Incomplete reads fail closed.
 */
async function readAdminMoneySignups({ url, serviceKey, fetchImpl = globalThis.fetch, now = new Date() }) {
  if (!url || !serviceKey) return { unavailable: true };
  const rows = [];
  let expected;
  try {
    const signal = AbortSignal.timeout(15000);
    for (let page = 0; page < MAX_PAGES; page++) {
      const endpoint = new URL('/rest/v1/money_scorecard_signups', url);
      endpoint.search = new URLSearchParams({
        select: 'email,created_at,role,first_page',
        order: 'created_at.desc,email.asc',
        created_at: `lte.${new Date(now).toISOString()}`,
        limit: String(PAGE_SIZE), offset: String(rows.length),
      }).toString();
      const response = await fetchImpl(endpoint, {
        method: 'GET', cache: 'no-store', signal,
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'count=exact' },
      });
      if (!response.ok) return { unavailable: true };
      const range = response.headers.get('content-range')?.match(/^(?:(\d+)-(\d+)|\*)\/(\d+)$/);
      const batch = await response.json();
      if (!range || !Array.isArray(batch)) return { unavailable: true };
      const count = Number(range[3]);
      if (expected !== undefined && expected !== count) return { unavailable: true };
      expected = count;
      if (batch.length && (Number(range[1]) !== rows.length || Number(range[2]) !== rows.length + batch.length - 1)) {
        return { unavailable: true };
      }
      rows.push(...batch);
      if (rows.length === expected) return summarizeMoneySignups(rows, now);
      if (!batch.length || rows.length > expected) return { unavailable: true };
    }
  } catch { /* Do not expose credentials, emails or upstream error text. */ }
  return { unavailable: true };
}

module.exports = { readAdminMoneySignups, summarizeMoneySignups };
