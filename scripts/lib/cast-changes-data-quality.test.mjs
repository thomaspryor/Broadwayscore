/**
 * Regression coverage for BRO-1297 (cast-changes.json data quality):
 *   1. Garbage arrival/departure name: an LLM extraction storing placeholder
 *      prose ("Anne Boleyn replacement") in the `name` field instead of a
 *      real performer name, which then renders as "X replacement — X".
 *   2. Dateless casting events with neither `date` nor `endDate` — not
 *      newsworthy, and must be marked `incomplete: true` so consumers can
 *      skip them explicitly rather than relying on an implicit null check.
 *   3. Closure `addedDate` bulk re-stamp: a re-scrape of an old article
 *      overwriting the first-seen announcement date, which makes long-closed
 *      shows (Moulin Rouge, Titanique) look newly-announced in the weekly
 *      "Recently Announced Closings" newsletter section.
 *   4. Duplicate closure events for the same closing date.
 *
 * Live-data assertions (2, 3, 4) read the real data/cast-changes.json, same
 * pattern as cast-changes-real-data.test.mjs. Fixture-based regressions (1,
 * write-once semantics) pin the underlying mechanism unconditionally so they
 * can't self-delete as live data drifts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'cast-changes.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

const { validateEvent, mergeEvents } = require('../scrape-cast-changes.js');

function eachUpcoming(fn) {
  for (const [showId, show] of Object.entries(data.shows || {})) {
    for (const event of show.upcoming || []) {
      fn(showId, event, show);
    }
  }
}

// ---------------------------------------------------------------------------
// AC2: no placeholder names in arrival/departure events
// ---------------------------------------------------------------------------

test('validateEvent rejects placeholder phrases in arrival/departure name field', () => {
  assert.equal(
    validateEvent({ type: 'arrival', name: 'Anne Boleyn replacement', role: 'Anne Boleyn' }),
    false,
  );
  assert.equal(validateEvent({ type: 'departure', name: 'TBA', role: 'Elphaba' }), false);
  assert.equal(validateEvent({ type: 'arrival', name: 'TBD', role: 'Elphaba' }), false);
  // note-type events legitimately use TBA/TBD as placeholder SUBJECT text
  // ("Additional casting TBA") — only arrival/departure must name a real person.
  assert.equal(
    validateEvent({ type: 'note', name: 'TBA', role: 'Various principal roles', note: 'x' }),
    true,
  );
  assert.equal(
    validateEvent({ type: 'arrival', name: 'Jeremy Jordan', role: 'Bobby Darin' }),
    true,
  );
});

test('live data: no arrival/departure event has a placeholder name (replacement/TBA/TBD)', () => {
  const offenders = [];
  eachUpcoming((showId, e) => {
    if (e.type !== 'arrival' && e.type !== 'departure') return;
    if (/replacement|TBA|TBD/i.test(e.name || '')) {
      offenders.push(`${showId}: ${e.type} name="${e.name}" role="${e.role}"`);
    }
  });
  assert.deepEqual(offenders, [], `placeholder names found:\n${offenders.join('\n')}`);
});

test('validateEvent flags ANY dateless arrival/departure incomplete:true, not just AUTO-FLAGGED diffs', () => {
  // Regression for a gap an adversarial review caught: the AUTO-FLAGGED
  // cast-page-diff creation sites stamp incomplete:true literally, but a
  // dateless event reaching validateEvent via a DIFFERENT path (e.g. the LLM
  // article extractor told to omit the date field for a vague mention) must
  // still get flagged — otherwise the next scrape silently reintroduces the
  // un-flagged rows the BRO-1297 backfill just cleaned up.
  const articleEvent = { type: 'arrival', name: 'Jinkx Monsoon', role: 'Mary', note: 'Current Mary' };
  assert.equal(validateEvent(articleEvent), true);
  assert.equal(articleEvent.incomplete, true);

  const departureEvent = { type: 'departure', name: 'Cole Escola', role: 'Mary', note: 'Left after Tony win' };
  assert.equal(validateEvent(departureEvent), true);
  assert.equal(departureEvent.incomplete, true);

  // A dated event must NOT be flagged.
  const datedEvent = { type: 'arrival', name: 'Jeremy Jordan', role: 'Bobby Darin', date: '2026-09-01' };
  assert.equal(validateEvent(datedEvent), true);
  assert.equal(datedEvent.incomplete, undefined);

  // note-type and closure events are exempt (never required to name a
  // dated individual).
  const noteEvent = { type: 'note', name: '', role: 'Claire', note: 'Further casting TBA' };
  assert.equal(validateEvent(noteEvent), true);
  assert.equal(noteEvent.incomplete, undefined);
});

// ---------------------------------------------------------------------------
// AC3: no dateless arrival/departure without an explicit incomplete flag
// ---------------------------------------------------------------------------

test('live data: every dateless arrival/departure event is flagged incomplete:true', () => {
  const offenders = [];
  eachUpcoming((showId, e) => {
    if (e.type !== 'arrival' && e.type !== 'departure') return;
    if (e.date || e.endDate) return;
    if (e.incomplete !== true) {
      offenders.push(`${showId}: ${e.type} ${e.name} (${e.role || 'Unknown'})`);
    }
  });
  assert.deepEqual(offenders, [], `dateless events missing incomplete:true:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// AC4: write-once addedDate semantics — re-running the writer never advances
// an existing event's addedDate.
// ---------------------------------------------------------------------------

test('mergeEvents: write-once addedDate survives a higher-priority re-scrape and a repeat run', () => {
  const showId = 'zz-fixture-show-1999';
  const existing = {
    shows: {
      [showId]: { currentCast: [], upcoming: [], history: [] },
    },
  };

  // First-seen: low-priority source, first-seen addedDate.
  mergeEvents(
    existing,
    {
      [showId]: [
        {
          type: 'closure', name: 'ZZ Fixture Show', role: 'Production', date: '2026-07-01',
          note: 'Show is closing', sourceUrl: 'https://reddit.com/r/broadway/x', sourceType: 'reddit',
          addedDate: '2026-02-01',
        },
      ],
    },
    'reddit',
  );
  const afterFirst = existing.shows[showId].upcoming.find(e => e.type === 'closure');
  assert.equal(afterFirst.addedDate, '2026-02-01');

  // Re-discovered months later via a higher-priority, richer-note source —
  // content should upgrade, but addedDate must stay pinned to first-seen.
  mergeEvents(
    existing,
    {
      [showId]: [
        {
          type: 'closure', name: 'ZZ Fixture Show', role: 'Production', date: '2026-07-01',
          note: 'Production closes 2026-07-01 after its Broadway run at the Fixture Theatre',
          sourceUrl: 'https://playbill.com/article/zz-fixture-show-closes', sourceType: 'playbill',
          addedDate: '2026-05-27',
        },
      ],
    },
    'articles',
  );
  const afterUpgrade = existing.shows[showId].upcoming.find(e => e.type === 'closure');
  assert.equal(afterUpgrade.addedDate, '2026-02-01', 'addedDate must not advance on a source-priority upgrade');
  assert.equal(afterUpgrade.sourceType, 'playbill', 'content (source/note) should still upgrade');

  // Re-running the identical writer call again ("re-running the writer
  // twice") must be a complete no-op on addedDate.
  mergeEvents(
    existing,
    {
      [showId]: [
        {
          type: 'closure', name: 'ZZ Fixture Show', role: 'Production', date: '2026-07-01',
          note: 'Production closes 2026-07-01 after its Broadway run at the Fixture Theatre',
          sourceUrl: 'https://playbill.com/article/zz-fixture-show-closes', sourceType: 'playbill',
          addedDate: '2026-05-27',
        },
      ],
    },
    'articles',
  );
  const afterRepeat = existing.shows[showId].upcoming.find(e => e.type === 'closure');
  assert.equal(afterRepeat.addedDate, '2026-02-01');
  assert.equal(
    existing.shows[showId].upcoming.filter(e => e.type === 'closure').length,
    1,
    'must not create a duplicate closure row',
  );
});

test('regression: bulk re-scrape of old closure articles never re-stamps addedDate to the scrape date (2026-05-27 bug)', () => {
  const showIds = ['zz-fixture-a', 'zz-fixture-b', 'zz-fixture-c'];
  const existing = { shows: {} };
  for (const id of showIds) {
    existing.shows[id] = {
      currentCast: [],
      upcoming: [{
        type: 'closure', name: id, role: 'Production', date: '2026-07-01',
        note: 'Production closes 2026-07-01', sourceUrl: `https://playbill.com/${id}`,
        sourceType: 'reddit', addedDate: '2026-02-01',
      }],
      history: [],
    };
  }

  const newEvents = {};
  for (const id of showIds) {
    newEvents[id] = [{
      type: 'closure', name: id, role: 'Production', date: '2026-07-01',
      note: 'Production closes 2026-07-01 (confirmed)', sourceUrl: `https://playbill.com/${id}-confirmed`,
      sourceType: 'playbill', addedDate: '2026-05-27',
    }];
  }
  mergeEvents(existing, newEvents, 'articles');

  for (const id of showIds) {
    const closure = existing.shows[id].upcoming.find(e => e.type === 'closure');
    assert.equal(
      closure.addedDate,
      '2026-02-01',
      `${id}: addedDate must stay pinned to first-seen date, not bulk-restamped to the re-scrape date`,
    );
  }
});

// ---------------------------------------------------------------------------
// AC5: no show has more than one closure event for the same closing date
// ---------------------------------------------------------------------------

test('live data: no show has more than one closure event for the same closingDate', () => {
  const offenders = [];
  for (const [showId, show] of Object.entries(data.shows || {})) {
    const byDate = {};
    for (const e of show.upcoming || []) {
      if (e.type !== 'closure' || !e.date) continue;
      byDate[e.date] = (byDate[e.date] || 0) + 1;
    }
    for (const [date, count] of Object.entries(byDate)) {
      if (count > 1) offenders.push(`${showId}: ${count} closure events for ${date}`);
    }
  }
  assert.deepEqual(offenders, [], `duplicate closures:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// AC6: Moulin Rouge / Titanique closure addedDate reflects real announcement
// weeks, not the 2026-05-27 bulk re-stamp — so they don't wrongly appear in
// "Recently Announced Closings" for the week of 2026-05-25.
// ---------------------------------------------------------------------------

test('Moulin Rouge and Titanique closures do not fall inside the buggy 2026-05-25 announcement week', () => {
  const WEEK_START = '2026-05-25';
  const WEEK_END = '2026-05-31';
  for (const showId of ['moulin-rouge-2019', 'titanique-2026']) {
    const show = data.shows && data.shows[showId];
    // A closed show is pruned from cast-changes.json entirely (cleanClosedShows)
    // — absent is fine, it can't misrender in any newsletter.
    if (!show) continue;
    const closures = (show.upcoming || []).filter(e => e.type === 'closure' && e.addedDate);
    for (const c of closures) {
      const inBuggyWeek = c.addedDate >= WEEK_START && c.addedDate <= WEEK_END;
      assert.equal(
        inBuggyWeek,
        false,
        `${showId}: closure addedDate ${c.addedDate} falls inside the 2026-05-25 bulk-restamp bug window`,
      );
    }
  }
});
