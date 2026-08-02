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

const { BRAIN_DATABASE_ID: DATABASE_ID, NOTION_VERSION } = require('./notion-constants');
const { parseRecheckAfterFromCard } = require('./recheck-stamp');

const ORPHAN_HOURS_DEFAULT = 48;
const PAUSED_LOW_PRIORITY_DAYS = 7;
// A Paused card whose RECHECK-AFTER stamp is due gets this many days for the
// nightly acceptance recheck to pick it up before it counts as stuck again —
// "due today, recheck runs tonight" must not warn. Past the grace, an overdue
// stamp IS stuck work: the recheck should have had something to say by now.
const STAMP_OVERDUE_GRACE_DAYS = 3;
// Backstop against runaway pagination (100 cards/page). The brain DB is ~1.4k
// cards total, ~120 in the queried states — 20 pages is far beyond plausible.
const MAX_PAGES = 20;

// KNOWN LIMITATION: "activity" here is Notion's last_edited_time, which bots
// (notion-action-poll, auto-fix-friction-card, tags sync) also bump — a dead
// card touched by automation looks fresh and hides from the orphan bucket.
// Good enough as a v1 heuristic (first live run still surfaced 50 orphans);
// per-actor activity needs the #279 alert-ledger.

/**
 * @param {Array<{name:string,status:string,priority:string|null,lastEditedAt:string,url?:string,notes?:string,outcome?:string}>} cards
 * @param {number} nowMs
 * @returns {{pausedCritical:Array, pausedStale:Array, pausedAwaitingRecheck:Array, orphaned:Array}}
 */
function classifyStuckCards(cards, nowMs, opts = {}) {
  const orphanHours = opts.orphanHours ?? ORPHAN_HOURS_DEFAULT;
  const pausedLowDays = opts.pausedLowDays ?? PAUSED_LOW_PRIORITY_DAYS;
  const graceDays = opts.stampGraceDays ?? STAMP_OVERDUE_GRACE_DAYS;
  const pausedCritical = [];
  const pausedStale = [];
  const pausedAwaitingRecheck = [];
  const orphaned = [];
  let invalidDates = 0;

  for (const card of cards) {
    const editedMs = Date.parse(card.lastEditedAt);
    if (Number.isNaN(editedMs)) { invalidDates++; continue; }
    const idleHours = (nowMs - editedMs) / 3600000;
    // Matches the DB's stable select values "P0 Now" / "P1 Next" (and excludes
    // "P2 Later"). A vocabulary rename would silently declassify — if priority
    // names ever change, update this alongside notion-brain.js.
    const critical = /^P[01]\b/.test(card.priority || '');

    if (card.status === 'Paused') {
      // /wrap-up's process rule REQUIRES deferred-effect fixes to sit Paused
      // with a RECHECK-AFTER stamp until their effect is observable — those
      // cards are parked by design, not stuck, so they get their own info
      // bucket instead of the blind-spot alarm. Only while the stamp is in
      // the future or within the recheck's grace window: past that, the
      // recheck should have resolved it and the card is stuck after all.
      const stampMs = parseRecheckAfterFromCard(card);
      const stampOverdueDays = stampMs != null ? (nowMs - stampMs) / 86400000 : null;
      if (critical) {
        if (stampMs != null && stampOverdueDays <= graceDays) {
          pausedAwaitingRecheck.push({ ...card, idleHours, recheckAfterMs: stampMs });
        } else {
          // No stamp → the original blind-spot alarm, regardless of age.
          // Stamp overdue past grace → stuck, with the overdue count attached
          // so the digest line can say why.
          pausedCritical.push({ ...card, idleHours, ...(stampMs != null ? { stampOverdueDays: Math.floor(stampOverdueDays) } : {}) });
        }
      } else if (idleHours > pausedLowDays * 24) {
        // Stamped-and-waiting P2s are parked by the same process rule — keep
        // them out of the FYI line while their stamp is still in the future.
        if (!(stampMs != null && stampMs > nowMs)) pausedStale.push({ ...card, idleHours });
      }
    } else if (card.status === 'In progress' && idleHours > orphanHours) {
      orphaned.push({ ...card, idleHours });
    }
  }

  const byIdle = (a, b) => b.idleHours - a.idleHours;
  pausedCritical.sort(byIdle);
  pausedStale.sort(byIdle);
  orphaned.sort(byIdle);
  pausedAwaitingRecheck.sort((a, b) => a.recheckAfterMs - b.recheckAfterMs);
  return { pausedCritical, pausedStale, pausedAwaitingRecheck, orphaned, invalidDates };
}

/**
 * Fetch Paused + In-progress brain cards via raw Notion REST (no SDK — the
 * data-health-check workflow runs without npm ci). Paginates; throws on
 * HTTP errors so the caller can degrade to a warn.
 */
async function fetchBrainCards(apiKey, fetchImpl = fetch) {
  const cards = [];
  let cursor;
  let pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new Error(`Notion pagination exceeded ${MAX_PAGES} pages — aborting instead of truncating silently`);
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
        // RECHECK-AFTER stamps live in Notes or Outcome. Notion property
        // values are a ~1800-char preview (notion-brain overflows longer
        // content to the page body) — sessions PREPEND to Outcome at wrap-up,
        // so the newest stamp lives in the preview head; a stamp buried past
        // the cap degrades safely to the warn firing (fail-safe, not silent).
        notes: (props.Notes?.rich_text || []).map((t) => t.plain_text).join(''),
        outcome: (props.Outcome?.rich_text || []).map((t) => t.plain_text).join(''),
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return cards;
}

module.exports = { classifyStuckCards, fetchBrainCards, ORPHAN_HOURS_DEFAULT, PAUSED_LOW_PRIORITY_DAYS, STAMP_OVERDUE_GRACE_DAYS };
