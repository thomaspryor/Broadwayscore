/**
 * Silent-stuck-work detection for the daily health digest.
 *
 * Blind spot this closes (2026-07-22, card 3a4637c5): a P1 card sat "Paused"
 * for a day with its build unshipped — Paused cards are invisible to the
 * nightly loop (out-of-tier), the "stalling the loop" email (Auto-tagged
 * cards only), and session-start stale checks (In-progress only). Same for
 * "In progress" cards whose owning session died: nothing re-surfaces them.
 *
 * classifyStuckCards is pure (rule 15) — health-check.js supplies cards from
 * fetchBrainCards below; tests supply fixtures.
 */

const DATABASE_ID = 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6'; // same brain DB as notion-brain.js
const NOTION_VERSION = '2025-09-03';

const ORPHAN_HOURS_DEFAULT = 48;
const PAUSED_LOW_PRIORITY_DAYS = 7;

/**
 * @param {Array<{name:string,status:string,priority:string|null,lastEditedAt:string,url?:string}>} cards
 * @param {number} nowMs
 * @returns {{pausedCritical:Array, pausedStale:Array, orphaned:Array}}
 */
function classifyStuckCards(cards, nowMs, opts = {}) {
  const orphanHours = opts.orphanHours ?? ORPHAN_HOURS_DEFAULT;
  const pausedLowDays = opts.pausedLowDays ?? PAUSED_LOW_PRIORITY_DAYS;
  const pausedCritical = [];
  const pausedStale = [];
  const orphaned = [];

  for (const card of cards) {
    const editedMs = Date.parse(card.lastEditedAt);
    if (Number.isNaN(editedMs)) continue;
    const idleHours = (nowMs - editedMs) / 3600000;
    const critical = /^P[01]\b/.test(card.priority || '');

    if (card.status === 'Paused') {
      // Any paused P0/P1 is a blind-spot alarm regardless of age — high
      // priority means someone decided it matters, then it went invisible.
      if (critical) pausedCritical.push({ ...card, idleHours });
      else if (idleHours > pausedLowDays * 24) pausedStale.push({ ...card, idleHours });
    } else if (card.status === 'In progress' && idleHours > orphanHours) {
      orphaned.push({ ...card, idleHours });
    }
  }

  const byIdle = (a, b) => b.idleHours - a.idleHours;
  pausedCritical.sort(byIdle);
  pausedStale.sort(byIdle);
  orphaned.sort(byIdle);
  return { pausedCritical, pausedStale, orphaned };
}

/**
 * Fetch Paused + In-progress brain cards via raw Notion REST (no SDK — the
 * data-health-check workflow runs without npm ci). Paginates; throws on
 * HTTP errors so the caller can degrade to a warn.
 */
async function fetchBrainCards(apiKey, fetchImpl = fetch) {
  const cards = [];
  let cursor;
  do {
    const res = await fetchImpl(`https://api.notion.com/v1/data_sources/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          or: [
            { property: 'Status', status: { equals: 'Paused' } },
            { property: 'Status', status: { equals: 'In progress' } },
          ],
        },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Notion query failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    for (const page of data.results || []) {
      const props = page.properties || {};
      cards.push({
        name: (props.Name?.title || []).map((t) => t.plain_text).join('') || '(untitled)',
        status: props.Status?.status?.name || '',
        priority: props.Priority?.select?.name || null,
        lastEditedAt: page.last_edited_time,
        url: page.url,
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return cards;
}

module.exports = { classifyStuckCards, fetchBrainCards, ORPHAN_HOURS_DEFAULT, PAUSED_LOW_PRIORITY_DAYS };
