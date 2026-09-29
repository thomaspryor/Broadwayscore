/**
 * Season-config consistency for the Broadway Fantasy League.
 *
 * The 2025-26 trial kept season constants in two places and they drifted.
 * These checks pin the one config file to the generated catalog, to the
 * canonical Tony calendar (src/lib/tony-cutoffs.ts, data/tony-ceremony-dates.json)
 * and to the frozen price snapshot, so a stale regeneration or an unannounced
 * calendar change fails CI instead of shipping.
 *
 * Run with: npx tsx --test tests/unit/fantasy-season-config.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import seasonConfig from '../../src/config/fantasy-season.json';
import { tonySeasonForLabel } from '../../src/lib/tony-cutoffs';
import {
  FANTASY_SEASON, FANTASY_BUDGET, FANTASY_TEAM_SIZE, DRAFT_OPENS, DRAFT_DEADLINE,
  SCORING_START, SCORING_END, EARLY_BIRD_CUTOFF, validatePicks,
} from '../../src/config/fantasy';
import type { FantasyShow } from '../../src/config/fantasy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '..', 'data');
const league = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-league.json'), 'utf8'));
const frozen = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-league-frozen.json'), 'utf8'));
const scores = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-scores.json'), 'utf8'));
const ceremonies = JSON.parse(fs.readFileSync(path.join(dataDir, 'tony-ceremony-dates.json'), 'utf8')).ceremonies as Array<{ ceremony: number; date: string }>;

describe('fantasy-season.json is the single source of truth', () => {
  test('fantasy.ts re-exports the JSON values', () => {
    assert.equal(FANTASY_SEASON, seasonConfig.season);
    assert.equal(FANTASY_BUDGET, seasonConfig.budget);
    assert.equal(FANTASY_TEAM_SIZE, seasonConfig.teamSize);
    assert.equal(DRAFT_OPENS, seasonConfig.draftOpens);
    assert.equal(DRAFT_DEADLINE, seasonConfig.draftDeadline);
    assert.equal(SCORING_START, seasonConfig.scoringStart);
    assert.equal(SCORING_END, seasonConfig.scoringEnd);
    assert.equal(EARLY_BIRD_CUTOFF, seasonConfig.earlyBirdCutoff);
  });

  test('the generated catalog was built from this config', () => {
    assert.equal(league._meta.season, seasonConfig.season);
    assert.equal(league._meta.draftDeadline, seasonConfig.draftDeadline);
    assert.equal(league._meta.scoringStart, seasonConfig.scoringStart);
    assert.equal(league._meta.scoringEnd, seasonConfig.scoringEnd);
    assert.equal(league._meta.earlyBirdCutoff, seasonConfig.earlyBirdCutoff);
    assert.equal(league._meta.budget, seasonConfig.budget);
    assert.equal(league._meta.teamSize, seasonConfig.teamSize);
    assert.deepEqual(league.scoring, seasonConfig.scoring);
  });

  test('the weekly scores snapshot is for this season and carries the per-entry fields', () => {
    assert.equal(scores._meta.season, seasonConfig.season);
    // Without weeklyBoxOffice the leaderboard falls back to all-or-nothing
    // box office (entryPickPoints legacy branch), which silently mis-scores
    // late drafters. Every show must carry it.
    for (const [id, s] of Object.entries(scores.showScores as Record<string, { weeklyBoxOffice?: unknown; openingDate?: unknown }>)) {
      assert.equal(typeof s.weeklyBoxOffice, 'object', `${id} is missing weeklyBoxOffice`);
      assert.ok('openingDate' in s, `${id} is missing openingDate`);
    }
  });

  test('season dates are ordered: draft opens < scoring start < early-bird cutoff < deadline < scoring end', () => {
    assert.ok(seasonConfig.draftOpens < seasonConfig.scoringStart);
    assert.ok(seasonConfig.scoringStart < seasonConfig.earlyBirdCutoff);
    assert.ok(seasonConfig.earlyBirdCutoff < seasonConfig.draftDeadline.slice(0, 10));
    assert.ok(seasonConfig.draftDeadline.slice(0, 10) < seasonConfig.scoringEnd);
  });
});

describe('Tony calendar alignment', () => {
  test('tonyWindow matches src/lib/tony-cutoffs.ts for the season label', () => {
    const record = tonySeasonForLabel(seasonConfig.tonyWindow.label);
    assert.ok(record, `tony-cutoffs has no record for ${seasonConfig.tonyWindow.label}`);
    assert.equal(seasonConfig.tonyWindow.start, record!.start);
    assert.equal(seasonConfig.tonyWindow.end, record!.end);
    assert.equal(seasonConfig.tonyCeremonyYear, record!.ceremonyYear);
  });

  test('scoringEnd is the ceremony date once the ceremony is on the calendar', () => {
    // 80th ceremony = ceremonyYear 2027. Until it is announced this passes
    // vacuously; the day it lands in tony-ceremony-dates.json, scoringEnd
    // must be updated to match (fantasy-season.json scoringEndNote).
    const ceremony = ceremonies.find(c => c.date.startsWith(String(seasonConfig.tonyCeremonyYear)));
    if (!ceremony) return;
    assert.equal(seasonConfig.scoringEnd, ceremony.date, 'scoringEnd must equal the Tony ceremony date');
  });

  test('draft deadline closes before the Tony eligibility cutoff', () => {
    assert.ok(seasonConfig.draftDeadline.slice(0, 10) <= seasonConfig.tonyWindow.end);
  });
});

describe('catalog integrity', () => {
  const shows = league.shows as Record<string, FantasyShow>;

  test('every Broadway show opened (or opens) inside the Tony window', () => {
    for (const [id, s] of Object.entries(shows)) {
      if (s.category !== 'broadway') continue;
      assert.ok(s.openingDate, `${id} has no opening date`);
      assert.ok(s.openingDate! >= seasonConfig.tonyWindow.start && s.openingDate! <= seasonConfig.tonyWindow.end, `${id} opens ${s.openingDate}, outside ${seasonConfig.tonyWindow.start}..${seasonConfig.tonyWindow.end}`);
    }
  });

  test('every catalog show has a frozen price and every frozen price is in the catalog', () => {
    assert.equal(frozen._meta.season, seasonConfig.season);
    for (const id of Object.keys(shows)) assert.equal(shows[id].price, frozen.prices[id], `${id} price differs from the frozen snapshot`);
    for (const id of Object.keys(frozen.prices)) assert.ok(shows[id], `frozen show ${id} missing from the catalog (append-only rule)`);
  });

  test('shows that opened before the draft opened are score-locked, later ones are not', () => {
    for (const [id, s] of Object.entries(shows)) {
      if (!s.openingDate) continue;
      const expected = s.openingDate >= seasonConfig.draftOpens;
      assert.equal(s.eligible.criticScore, expected, `${id} (opens ${s.openingDate}) criticScore eligibility`);
      assert.equal(s.eligible.audienceGrade, expected, `${id} audienceGrade eligibility`);
    }
  });

  test('a full-price roster of the most expensive shows cannot exceed the budget rules', () => {
    const sorted = Object.entries(shows).sort((a, b) => b[1].price - a[1].price);
    const topEight = sorted.slice(0, 8).map(([id]) => id);
    const result = validatePicks(topEight, shows);
    assert.equal(result.valid, false, 'the eight priciest shows should not fit in the budget');
    const cheapest = sorted.slice(-8).map(([id]) => id);
    assert.equal(validatePicks(cheapest, shows).valid, true, 'the eight cheapest shows should fit');
    assert.equal(validatePicks(sorted.slice(-9).map(([id]) => id), shows).valid, false, 'nine picks is over the roster limit');
  });

  test('every priced show carries a plain-language price note', () => {
    for (const [id, s] of Object.entries(shows)) {
      assert.ok(s.priceNote && s.priceNote.length > 10, `${id} has no priceNote`);
    }
  });
});
