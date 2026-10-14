/**
 * Silent-stuck-work detection for the daily health digest.
 *
 * Blind spot this closes (2026-07-22, card 3a4637c5): a P1 card sat "Paused"
 * for a day with its build unshipped — Paused cards are invisible to the
 * nightly loop (out-of-tier), the "stalling the loop" email (Auto-tagged
 * cards only), and session-start stale checks (In-progress only). Same for
 * "In progress" cards whose owning session died: nothing re-surfaces them.
 *
 * Two legitimate Paused states are carved out so they don't fire the alarm
 * (2026-08-03, card 3b1637c5):
 *   - RECHECK-AFTER-stamped cards (deferred-effect fixes awaiting the nightly
 *     recheck) → pausedAwaitingRecheck until the stamp is overdue past grace.
 *   - `## Parked <date>`-marked cards (bsc-prune tab-close parking, #776) →
 *     pausedParked until the park is older than PARKED_ESCALATION_DAYS.
 * Unstamped, unmarked Paused P0/P1s get PAUSED_CRITICAL_GRACE_HOURS before
 * counting as stuck — routine wrap-up pauses of live work no longer fire the
 * next morning's digest, while the founding incident (a card Paused ~1 day
 * with its build unshipped) still fires on digest 2-3.
 *
 * classifyStuckCards is pure (rule 15) — health-check.js supplies cards from
 * fetchBrainCards below; tests supply fixtures.
 */

const { BRAIN_DATABASE_ID: DATABASE_ID, NOTION_VERSION } = require('./notion-constants');
const { parseRecheckAfterFromCard } = require('./recheck-stamp');
const { parseParkedDate, parseParkedTaskId } = require('./park-marker');

const ORPHAN_HOURS_DEFAULT = 48;
const PAUSED_LOW_PRIORITY_DAYS = 7;
// How long an unstamped, unmarked Paused P0/P1 may sit before it counts as
// stuck. 48h (not 24h) so a wrap-up pause from the prior afternoon doesn't
// straddle the next 7:30am digest boundary.
const PAUSED_CRITICAL_GRACE_HOURS = 48;
// A tab-close-parked card is deliberately shelved by the owner — quiet for
// this many days (surfaced as an FYI note), then it counts as stuck so parked
// cards can't rot forever. Keyed on the DATE IN THE MARKER, never
// last_edited_time (bots bump that and would reset the clock).
const PARKED_ESCALATION_DAYS = 7;
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
// card touched by automation looks fresh and hides from the orphan bucket,
// and (since 2026-08-03) a bot touching an unstamped Paused P0/P1 more often
// than every PAUSED_CRITICAL_GRACE_HOURS can hold it inside the grace window
// indefinitely. Accepted trade-off — there is no better timestamp on
// unstamped cards; per-actor activity needs the #279 alert-ledger. The
// parked/stamped escalations are immune (keyed on dates in the card text).

/**
 * @param {Array<{name:string,status:string,priority:string|null,lastEditedAt:string,url?:string,notes?:string,outcome?:string}>} cards
 * @param {number} nowMs
 * @returns {{pausedCritical:Array, pausedStale:Array, pausedAwaitingRecheck:Array, pausedParked:Array, orphaned:Array}}
 */
function classifyStuckCards(cards, nowMs, opts = {}) {
  const orphanHours = opts.orphanHours ?? ORPHAN_HOURS_DEFAULT;
  const pausedLowDays = opts.pausedLowDays ?? PAUSED_LOW_PRIORITY_DAYS;
  const graceDays = opts.stampGraceDays ?? STAMP_OVERDUE_GRACE_DAYS;
  const criticalGraceHours = opts.pausedCriticalGraceHours ?? PAUSED_CRITICAL_GRACE_HOURS;
  const parkedEscalationDays = opts.parkedEscalationDays ?? PARKED_ESCALATION_DAYS;
  const pausedCritical = [];
  const pausedStale = [];
  const pausedAwaitingRecheck = [];
  const pausedParked = [];
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
        // Park marker first: head-anchored, so a match means parking is the
        // NEWEST outcome write — the most recent state transition wins over
        // any stamp. Any later outcome write pushes the marker off the head
        // and we fall through to stamp/grace logic (fail-safe).
        const parkedAtMs = parseParkedDate(card.outcome);
        if (parkedAtMs != null) {
          // Escalation keys on the marker's own date, not idleHours —
          // last_edited_time is bot-bumped and would reset the clock.
          const parkedDays = (nowMs - parkedAtMs) / 86400000;
          if (parkedDays <= parkedEscalationDays) {
            pausedParked.push({ ...card, idleHours, parkedAtMs, parkedTaskId: parseParkedTaskId(card.outcome) });
          } else {
            // max(1, …): a card 7.0–8.0 days parked is 1 day past the window,
            // never "overdue 0d" in the digest line.
            pausedCritical.push({ ...card, idleHours, parkedOverdueDays: Math.max(1, Math.floor(parkedDays - parkedEscalationDays)) });
          }
        } else if (stampMs != null && stampOverdueDays <= graceDays) {
          pausedAwaitingRecheck.push({ ...card, idleHours, recheckAfterMs: stampMs });
        } else if (stampMs != null) {
          // Stamp overdue past grace → stuck, with the overdue count attached
          // so the digest line can say why.
          pausedCritical.push({ ...card, idleHours, stampOverdueDays: Math.floor(stampOverdueDays) });
        } else if (idleHours > criticalGraceHours) {
          // No stamp, no marker, past the grace window → the original
          // blind-spot alarm.
          pausedCritical.push({ ...card, idleHours });
        }
        // else: unstamped and paused within the grace window — a routine
        // wrap-up pause of live work, not stuck (yet).
      } else if (idleHours > pausedLowDays * 24) {
        // Stamped-and-waiting P2s are parked by the same process rule as
        // criticals — give them the same grace window past the stamp (the
        // nightly recheck runs once a day; a stamp due today isn't stuck
        // yet, only a stamp overdue past grace is). Without this, a P2 whose
        // stamp lands on today's date fires the FYI warning hours before the
        // recheck has had a chance to run. A future stamp makes
        // stampOverdueDays negative, which already satisfies `<= graceDays` —
        // no separate future-stamp check needed (mirrors the critical branch
        // above).
        const awaitingRecheck = stampMs != null && stampOverdueDays <= graceDays;
        if (!awaitingRecheck) pausedStale.push({ ...card, idleHours });
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
  pausedParked.sort((a, b) => a.parkedAtMs - b.parkedAtMs);
  return { pausedCritical, pausedStale, pausedAwaitingRecheck, pausedParked, orphaned, invalidDates };
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

module.exports = { classifyStuckCards, fetchBrainCards, ORPHAN_HOURS_DEFAULT, PAUSED_LOW_PRIORITY_DAYS, STAMP_OVERDUE_GRACE_DAYS, PAUSED_CRITICAL_GRACE_HOURS, PARKED_ESCALATION_DAYS };
