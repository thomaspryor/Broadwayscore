// BRO-5488: the replay and open-card sweep use the front door's own rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { replayFilings, openDuplicateGroups } = require('./linear-dedupe-sweep.js');
const card = (identifier, title, h, extra = {}) => ({ identifier, title, createdAt: new Date(Date.parse('2026-10-16T12:00:00Z') - h * 3600e3).toISOString(), description: '', ...extra });

test('replay: a repeat of a still-open card counts, one closed before it does not, router and --dispatch cards only in the upper bound', () => {
  const history = [
    card('BRO-1', 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', 30),
    card('BRO-2', 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', 5, { description: 'PARKED: auto-filed' }),
    card('BRO-3', 'Corpus drift: URL swapped for a prior production', 40, { completedAt: new Date(Date.parse('2026-10-16T12:00:00Z') - 20 * 3600e3).toISOString() }),
    card('BRO-4', 'Corpus drift: URL swapped for a prior production', 4, { description: 'PARKED: auto-filed' }),
    card('BRO-7', 'BSC Rebuild: 50 reviews dropped [SUSPICIOUS]', 2),
    card('BRO-5', 'Daily gap check found stale rows', 30, { description: 'Auto-filed by owner-alert-router (condition: a)' }),
    card('BRO-6', 'Daily gap check found stale rows today', 3, { description: 'Auto-filed by owner-alert-router (condition: a)' }),
  ];
  const windowCards = history.filter((c) => ['BRO-2', 'BRO-4', 'BRO-6', 'BRO-7'].includes(c.identifier));
  const shipped = replayFilings({ windowCards, history });
  assert.deepEqual(shipped.nearDup.map((r) => `${r.card.identifier}->${r.match.identifier}`), ['BRO-2->BRO-1']);
  const upper = replayFilings({ windowCards, history, allFilers: true });
  assert.ok(upper.nearDup.length >= shipped.nearDup.length);
});

test('open sweep: newer copies point at the oldest card, a chain never points at a copy', () => {
  const pairs = openDuplicateGroups([
    card('BRO-10', 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', 50),
    card('BRO-11', 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', 20),
    card('BRO-12', 'BSC Rebuild: 52 reviews dropped [SUSPICIOUS]', 2),
    card('BRO-13', 'Review gap — "Tru" missing 1 cited review(s)', 2),
  ]);
  assert.deepEqual(pairs.map((p) => `${p.card.identifier}->${p.keep.identifier}`), ['BRO-11->BRO-10', 'BRO-12->BRO-10']);
});
