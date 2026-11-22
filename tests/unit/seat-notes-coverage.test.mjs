// LIVE-DATA-LANE: reads data/theater-metadata.json and the seat-notes audit (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * Seat-notes coverage (BRO-8057 ramp). The pipeline (scripts/seat-notes.js)
 * writes structuredTips.seating.seatNotes and records every theater it
 * published in data/seat-research-eval/audits/seat-notes.json. This pins:
 *   1. every stored note passes the shared validator (sourced, house-only,
 *      allowed hosts, no value note on the Center Orchestra, ...);
 *   2. every theater the audit says was published still has notes that render,
 *      so a later job that wipes some of them fails here (the quarterly merge
 *      wiped sections once, BRO-932);
 *   3. a floor on the number of theaters with rendering notes, set from the
 *      measured count after the full ramp.
 *
 * Run with: node --test tests/unit/seat-notes-coverage.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const meta = require(path.join(__dirname, '../../data/theater-metadata.json'));
const audit = require(path.join(__dirname, '../../data/seat-research-eval/audits/seat-notes.json'));
const { validateSeatNotes } = require('../../scripts/lib/seat-notes-validators.js');
const { publishableSeatNotes, latestVerified } = require('../../scripts/lib/seat-notes-publish.js');
const { houseTitles } = require('../../scripts/seat-notes.js');
const showsJson = require(path.join(__dirname, '../../data/shows.json'));
const shows = Array.isArray(showsJson) ? showsJson : showsJson.shows || [];

// Theaters with notes that render, measured after each ramp step (BRO-8057).
const MIN_THEATERS_WITH_NOTES = 12;

const theaters = Object.keys(meta).filter((k) => !k.startsWith('_'));
const notesOf = (t) => meta[t]?.structuredTips?.seating?.seatNotes;
// Judged on the day the notes were checked, so value-note expiry does not fail the test later.
const rendering = (t) => publishableSeatNotes(notesOf(t), { today: new Date(latestVerified(notesOf(t)) || 0) });
const renders = (t) => rendering(t).length > 0;

describe('seat notes in theater-metadata.json', () => {
  test('every stored note passes the validator', () => {
    const problems = theaters.flatMap((t) => (notesOf(t) ? validateSeatNotes(t, notesOf(t), { showTitles: houseTitles(shows, t) }) : []));
    assert.deepEqual(problems, []);
  });

  test('every theater the pipeline published still has notes that render', () => {
    const published = Object.entries(audit.theaters || {})
      .filter(([, a]) => Array.isArray(a.published) && a.published.length > 0)
      .map(([t]) => t);
    const missing = published.filter((t) => !renders(t));
    assert.deepEqual(missing, [], `published by seat-notes.js but no rendering notes now: ${missing.join(', ')}`);
  });

  test('no audited theater lost more than 20% of its notes or watch-outs (shrink backstop)', () => {
    // Same bar apply holds itself to without --allow-shrink; this catches any other writer.
    const shrunk = [];
    for (const [t, a] of Object.entries(audit.theaters || {})) {
      if (!Array.isArray(a.published) || !a.published.length) continue;
      const now = rendering(t);
      const wo = (xs) => xs.filter((n) => n.type === 'watch-out').length;
      if (now.length < Math.ceil(a.published.length * 0.8)) shrunk.push(`${t}: ${now.length} notes, published ${a.published.length}`);
      else if (wo(now) < Math.ceil(wo(a.published) * 0.8)) shrunk.push(`${t}: ${wo(now)} watch-outs, published ${wo(a.published)}`);
    }
    assert.deepEqual(shrunk, []);
  });

  test('every theater with notes meets the publish rule (2+ notes, 1+ watch-out or value)', () => {
    // Does not trust the audit: a job that thins a theater's notes fails here too.
    const thin = theaters.filter((t) => notesOf(t)?.length).filter((t) => {
      const r = rendering(t);
      return r.length < 2 || !r.some((n) => n.type === 'watch-out' || n.type === 'value');
    });
    assert.deepEqual(thin, []);
  });

  test(`at least ${MIN_THEATERS_WITH_NOTES} theaters have notes that render`, () => {
    const n = theaters.filter(renders).length;
    assert.ok(n >= MIN_THEATERS_WITH_NOTES, `${n} theaters with seat notes, floor ${MIN_THEATERS_WITH_NOTES}`);
  });
});
