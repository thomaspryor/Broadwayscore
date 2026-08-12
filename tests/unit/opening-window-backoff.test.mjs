/**
 * Unit tests for scripts/lib/opening-window-backoff.js.
 *
 * Card #1314: Death Note (opened 2026-08-11) hit 20 consecutive no-op poller
 * runs during quiet previews, pushing nextRunAfter to ~11:10 UTC on
 * 2026-08-12 — the exact morning WhatsOnStage's review dropped. The old
 * carve-out only exempted [openingDate, openingDate+6h) from backoff; reviews
 * routinely land well after that. isInOpeningWindow widens the carve-out to
 * [openingDate-1d, openingDate+3d].
 *
 * Run: node --test tests/unit/opening-window-backoff.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isInOpeningWindow, WINDOW_BEFORE_MS, WINDOW_AFTER_MS } = require('../../scripts/lib/opening-window-backoff.js');

describe('isInOpeningWindow', () => {
  it('is true the morning after opening, even with 20+ consecutive no-ops (Death Note canary)', () => {
    const show = { id: 'death-note-the-musical-west-end-2026', openingDate: '2026-08-11' };
    const now = new Date('2026-08-12T11:10:00Z'); // exact backoff-deferred instant from the incident
    assert.strictEqual(isInOpeningWindow(show, now), true);
  });

  it('is true 1 day before opening (press-embargo slip)', () => {
    const show = { openingDate: '2026-08-11T20:00:00Z' };
    const now = new Date('2026-08-10T20:30:00Z');
    assert.strictEqual(isInOpeningWindow(show, now), true);
  });

  it('is true up to 3 days after opening (T2/T3 long tail)', () => {
    const show = { openingDate: '2026-08-11T20:00:00Z' };
    const now = new Date(new Date(show.openingDate).getTime() + WINDOW_AFTER_MS - 1000);
    assert.strictEqual(isInOpeningWindow(show, now), true);
  });

  it('is false more than 1 day before opening', () => {
    const show = { openingDate: '2026-08-11T20:00:00Z' };
    const now = new Date(new Date(show.openingDate).getTime() - WINDOW_BEFORE_MS - 1000);
    assert.strictEqual(isInOpeningWindow(show, now), false);
  });

  it('is false more than 3 days after opening — normal backoff applies', () => {
    const show = { openingDate: '2026-08-11T20:00:00Z' };
    const now = new Date(new Date(show.openingDate).getTime() + WINDOW_AFTER_MS + 1000);
    assert.strictEqual(isInOpeningWindow(show, now), false);
  });

  it('defaults to always-aggressive when openingDate is missing', () => {
    assert.strictEqual(isInOpeningWindow({ id: 'no-date-show' }, new Date('2026-08-12T00:00:00Z')), true);
  });

  it('defaults to always-aggressive when openingDate is unparseable', () => {
    assert.strictEqual(isInOpeningWindow({ openingDate: 'not-a-date' }, new Date('2026-08-12T00:00:00Z')), true);
  });
});
