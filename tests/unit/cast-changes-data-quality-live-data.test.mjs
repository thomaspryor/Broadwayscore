// BRO-5729 (BRO-3425 pattern): live-data assertions split out of scripts/lib/cast-changes-data-quality.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/cast-changes.json), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health), excluded from the unit batches in
// scripts/lib/unit-test-collection.js. Pure-logic tests stay in scripts/lib/cast-changes-data-quality.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'cast-changes.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

function eachUpcoming(fn) {
  for (const [showId, show] of Object.entries(data.shows || {})) {
    for (const event of show.upcoming || []) {
      fn(showId, event, show);
    }
  }
}
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
