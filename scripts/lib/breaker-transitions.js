'use strict';
/**
 * BRO-3022: the per-day trip-transition ledger for the provider spend breakers.
 *
 * WHY THIS EXISTS. Sprint 3 (BRO-3011) audits the spend guards against the rule
 * "a guard tripping >2 days/week is a defect unless owner-accepted", and names
 * data/audit/alert-ledger.json as its source. That file cannot answer it:
 * owner-alert-router.js keeps exactly ONE object per conditionKey, whose whole
 * key set is {cardId, disposition, firstSeen, lastNotifiedAt, lastSeen,
 * linearIdentifier, notifyCount, requestedDisposition, status, title}. There is
 * no per-occurrence array and no day list, and `notifyCount` is a NOTIFY count
 * gated by the router's own 6h cooldown, not a trip count — sd-circuit-breaker
 * read notifyCount 18 across a 25-day firstSeen..lastSeen span on 2026-09-08.
 * data/audit/alert-router-attempts.jsonl holds zero rows for any breaker key,
 * and that is by design rather than a bug: owner-alert-router.js only logs real
 * SEND attempts there, and both breakers route disposition:'digest'.
 * So "which days did this guard trip" was recorded nowhere, and this file is
 * the recorder. Emission only — Sprint 3's guard-audit-core.js stays a pure
 * reader over these rows.
 *
 * WHY UNION-MERGE-SAFETY IS THE WHOLE DESIGN. Every tracked data/audit/*.jsonl
 * must be declared `merge=union` in .gitattributes or carry a reasoned
 * exemption — scripts/lib/audit-ledger-merge-attrs.js is the lint gate, and
 * taking the exemption instead would reopen the sync-audit-checkout.sh ff-only
 * outage BRO-2314 closed. Union merge keeps BOTH sides' lines but UNORDERED,
 * and can resurrect a line. That imposes the two rules that lib names verbatim:
 *   (a) no reader may aggregate duplicate keys — so daysTripped() counts
 *       DISTINCT days, and a duplicated row changes its answer by nothing;
 *   (b) no reader may treat file order as chronological — so every reader here
 *       sorts by the explicit `ts` field before doing anything else.
 * It is also why there is deliberately NO sequence counter. A per-key counter
 * would have to be derived by reading the file first (the read-modify-write
 * race that already burned data/audit/scraper-spend-ledger.jsonl, task #788),
 * two hourly runners would mint the same number, and union's reordering would
 * make a "gap" in it unreadable anyway — a consecutive-streak count over file
 * order is disqualifier (b) exactly.
 *
 * HOW A LOST DAY IS TOLD FROM A QUIET DAY (the BRO-2951 caveat, and the reason
 * this card was filed ahead of Sprint 3 rather than inside it). Rows are written
 * only on a state CHANGE, so a week with no trips writes nothing — which on its
 * own is indistinguishable from a week whose rows were written and then lost.
 * And these rows really are at risk, in two independent ways: they are committed
 * from a CI job (BRO-2951 loses those commits most hours), and push-with-retry.sh
 * resolves a conflicted push with a strategy option that keeps the other side,
 * which silently drops locally-appended lines — a loss already accepted at a
 * coarser grain for the sibling ledgers (push-content-survival.js's
 * CONTENT_SURVIVAL_EXEMPT_LEDGERS).
 *
 * Each row therefore carries `prevTs`: the `ts` of the previous row THIS writer
 * saw for the same conditionKey (null for the first row ever). That makes the
 * history a chain. If a row's prevTs names a timestamp not present in the file,
 * rows between them were lost — findChainBreaks() reports exactly that, and
 * daysTripped() returns `lowerBound: true`, so Sprint 3 says "at least N days"
 * instead of silently under-counting and clearing a guard that is really a
 * defect. Unlike a counter, prevTs is race-TOLERANT rather than race-broken:
 * two writers racing both record the same prevTs, which is a FORK, not a gap —
 * both rows survive union merge and both are visible, so forks are reported
 * separately and are never mistaken for loss. And unlike a counter, reading it
 * needs no ordering assumption: it is a set-membership test after sorting by ts.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = process.env.BREAKER_TRANSITIONS_PATH
  || path.join(__dirname, '..', '..', 'data', 'audit', 'breaker-transitions.jsonl');

/**
 * The only two states a spend breaker has. Strings rather than booleans so a
 * row reads as `"from":"ok","to":"tripped"` in the raw JSONL a human greps at
 * 3am. NOTE this does NOT extend to data/audit/t1-outlet-breaker.json, which is
 * a THREE-state outlet-availability breaker (closed/open/half-open,
 * scripts/lib/outlet-circuit-breaker.js) and a different concern from spend.
 */
const OK = 'ok';
const TRIPPED = 'tripped';

/** Map the breakers' own boolean verdict onto a row state. */
function stateOf(tripped) {
  return tripped ? TRIPPED : OK;
}

function parseTransitions(text) {
  if (typeof text !== 'string' || !text) return [];
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && typeof row.conditionKey === 'string' && typeof row.ts === 'string') {
        rows.push(row);
      }
    } catch { /* a torn line from an interrupted append — skip it, never throw */ }
  }
  return rows;
}

function loadTransitions(ledgerPath = DEFAULT_PATH) {
  try {
    return parseTransitions(fs.readFileSync(ledgerPath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Rows for one conditionKey in TRUE chronological order. Rule (b) above: never
 * trust file order, because union merge appends the other side's lines wherever
 * it likes. Every reader in this module goes through here.
 */
function rowsForKey(rows, conditionKey) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.conditionKey === conditionKey)
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * Append one row iff the state actually CHANGED; return the row written, or
 * null when `from === to`.
 *
 * The unchanged-status check lives HERE rather than at each call site so a
 * third breaker added later cannot get it wrong — "appended on trip and on
 * recovery, never on an unchanged status" is this card's acceptance criterion
 * and it is enforced in one place.
 */
function appendTransition({
  conditionKey,
  from,
  to,
  day = null,
  units = null,
  ceiling = null,
  ceilingSource = null,
  ts = null,
  source = null,
  // undefined = derive the chain link from the file (the live path). An
  // explicit null means "this row is chain-NEUTRAL" and is what the historical
  // backfill passes: a backfilled row carries an old `ts` but is appended after
  // rows that are newer than it, so deriving its predecessor from the file
  // would record a link that runs backwards in time. findChainBreaks() skips
  // rows with no prevTs, so chain-neutral rows never manufacture a false gap.
  prevTs,
  ledgerPath = DEFAULT_PATH,
} = {}) {
  if (typeof conditionKey !== 'string' || !conditionKey) {
    throw new TypeError('appendTransition requires a conditionKey');
  }
  if (from !== OK && from !== TRIPPED) {
    throw new TypeError(`from must be '${OK}' or '${TRIPPED}', got ${JSON.stringify(from)}`);
  }
  if (to !== OK && to !== TRIPPED) {
    throw new TypeError(`to must be '${OK}' or '${TRIPPED}', got ${JSON.stringify(to)}`);
  }
  if (from === to) return null;

  let link = prevTs;
  if (link === undefined) {
    const prior = rowsForKey(loadTransitions(ledgerPath), conditionKey);
    link = prior.length ? prior[prior.length - 1].ts : null;
  }

  const row = {
    ts: ts || new Date().toISOString(),
    conditionKey,
    from,
    to,
    day: day || null,
    // `units` is provider-native and deliberately un-normalised: SD bills
    // credits, BD bills requests. Naming it `units` rather than `dayCredits`
    // keeps one row shape across both without either provider's row lying
    // about what it counted; `ceiling` is in the same units by construction.
    units: Number.isFinite(units) ? units : null,
    ceiling: Number.isFinite(ceiling) ? ceiling : null,
    ceilingSource: ceilingSource || null,
    // 'history-backfill' marks a row reconstructed from the state file's own
    // commit history rather than observed live, so a reader can discount it:
    // that channel is lossy by construction (BRO-2951), so backfilled days are
    // a floor, never a complete week. Live rows leave this null.
    source: source || null,
    prevTs: link,
  };

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  // ONE already-newline-terminated line, ONE appendFileSync (O_APPEND) — the
  // shape scripts/lib/import-ledger.js documents, so concurrent writers
  // interleave whole lines instead of clobbering each other's snapshot.
  fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
  return row;
}

/**
 * Chain integrity for one conditionKey.
 *
 * `gaps`  — rows whose prevTs names a timestamp ABSENT from the file. Rows were
 *           lost between them (a dropped CI commit, or a conflicted push that
 *           kept the other side). This is what makes `lowerBound` real.
 * `forks` — two or more rows claiming the SAME prevTs. Two writers raced; both
 *           rows are present and nothing is missing, so this is reported but is
 *           explicitly NOT loss.
 *
 * Named findChainBreaks, not findGaps: `findGaps` already means "test.yml
 * coverage gaps" in scripts/lib/audit-test-yml-lib-deps.js and two siblings.
 */
function findChainBreaks(rows, conditionKey) {
  const mine = rowsForKey(rows, conditionKey);
  const present = new Set(mine.map((r) => r.ts));
  const byPrev = new Map();
  const gaps = [];
  for (const row of mine) {
    if (!row.prevTs) continue;
    if (!present.has(row.prevTs)) gaps.push({ ts: row.ts, missingPrevTs: row.prevTs });
    byPrev.set(row.prevTs, (byPrev.get(row.prevTs) || 0) + 1);
  }
  const forks = [...byPrev.entries()]
    .filter(([, n]) => n > 1)
    .map(([prevTs, count]) => ({ prevTs, count }));
  return { gaps, forks };
}

/**
 * Sprint 3's number: the distinct UTC days on which this guard tripped, over
 * [sinceDay, untilDay] inclusive (either bound optional, both `YYYY-MM-DD`).
 *
 * Counted from `to === 'tripped'` rows, one day per row's own `day` field — NOT
 * from trip/recovery pairs. That is deliberate, and it is the day-rollover case:
 * both checkers read their previous state through a DAY-SCOPED predicate
 * (scrapingdog-caps.js isBreakerActive / brightdata-caps.js
 * isBreakerActiveForZone both require state.day === today), so a breaker still
 * over its ceiling at UTC midnight reads as not-active on the new day and
 * re-trips, emitting a fresh ok->tripped row for the new day and never a
 * recovery row for the old one. Pairing trips with recoveries would therefore
 * score a 3-day run as a single 1-day incident. Counting distinct tripped-days
 * gets it right, and is duplicate-proof (rule (a) above) into the bargain.
 *
 * KNOWN LIMIT, for whoever writes the next reader: because of that same
 * day-scoping, these rows CANNOT answer "how long was this breaker capped for"
 * — an unrecovered trip has no closing row. They answer "which days did it
 * trip", which is the question the DEFECT rule actually asks.
 *
 * `lowerBound` is true when findChainBreaks() saw real loss, i.e. the true
 * count may be higher than `days`. Sprint 3 must not clear a guard on a
 * lowerBound count.
 */
function daysTripped(rows, { conditionKey, sinceDay = null, untilDay = null } = {}) {
  const mine = rowsForKey(rows, conditionKey);
  const days = new Set();
  for (const row of mine) {
    if (row.to !== TRIPPED || !row.day) continue;
    if (sinceDay && row.day < sinceDay) continue;
    if (untilDay && row.day > untilDay) continue;
    days.add(row.day);
  }
  const { gaps } = findChainBreaks(mine, conditionKey);
  return { days: days.size, dayList: [...days].sort(), lowerBound: gaps.length > 0 };
}

/** UTC day of an ISO timestamp, matching brightdata-caps.js's utcDay(). */
function dayOf(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : null;
}

/**
 * Reconstruct trip transitions from a chronological sequence of observed
 * breaker-state snapshots — the pure core of
 * scripts/backfill-breaker-transitions.js, extracted here per project rule 15
 * so the test exercises the real function rather than a copy of it.
 *
 * `trippedAt` is preserved across the hourly re-checks of a single day and
 * re-stamped only on a FRESH trip, so a change in its value is exactly one
 * trip and an unchanged value is not a transition. The emitted row's `ts` is
 * the trippedAt value itself, which makes the reconstruction deterministic and
 * therefore idempotent — re-running the backfill yields byte-identical rows.
 *
 * Recovery rows are deliberately NOT reconstructed: the state files record no
 * "clearedAt", so a recovery's timestamp is unknowable and any synthesised one
 * would be non-deterministic, breaking that idempotency. Trip days are what the
 * DEFECT rule needs, and they are all recovered.
 *
 * @param {{trippedAt: ?string, units: ?number, ceiling: ?number}[]} observations
 *        oldest first
 * @param {string} conditionKey
 */
function reconstructTransitions(observations, conditionKey) {
  const rows = [];
  let prev = null;
  for (const obs of (Array.isArray(observations) ? observations : [])) {
    const now = (obs && obs.trippedAt) || null;
    if (now === prev) continue;
    if (now) {
      rows.push({
        conditionKey,
        ts: now,
        day: dayOf(now),
        from: OK,
        to: TRIPPED,
        units: obs && Number.isFinite(obs.units) ? obs.units : null,
        ceiling: obs && Number.isFinite(obs.ceiling) ? obs.ceiling : null,
      });
    }
    prev = now;
  }
  return rows;
}

/**
 * The one call site wrapper both checkers use. A ledger row is strictly less
 * important than the alert that follows it, so a broken/unwritable ledger must
 * never take down the check — same rule provider-telemetry.js states for the
 * spend ledger ("persistence must never break scraping"). Returns the row, or
 * null when unchanged OR when the append failed.
 */
function recordTransitionSafely(opts, log = console) {
  try {
    return appendTransition(opts);
  } catch (err) {
    log.warn(`  breaker-transitions: could not record ${opts && opts.conditionKey} transition — ${err.message}`);
    return null;
  }
}

module.exports = {
  DEFAULT_PATH,
  OK,
  TRIPPED,
  stateOf,
  dayOf,
  reconstructTransitions,
  parseTransitions,
  loadTransitions,
  rowsForKey,
  appendTransition,
  recordTransitionSafely,
  findChainBreaks,
  daysTripped,
};
