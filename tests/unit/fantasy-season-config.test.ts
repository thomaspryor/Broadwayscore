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
  SCORING_START, SCORING_END, EARLY_BIRD_CUTOFF, validatePicks, draftDeadlineDate, hasLateEntry,
} from '../../src/config/fantasy';
import type { FantasyShow } from '../../src/config/fantasy';
import { LISTED_FROM, isFantasyListed } from '../../src/config/fantasy-listing';

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

  test('season dates are ordered: draft opens < early-bird cutoff <= deadline < scoring end', () => {
    const deadlineNy = draftDeadlineDate();
    assert.ok(seasonConfig.draftOpens < seasonConfig.scoringStart);
    assert.ok(seasonConfig.draftOpens < seasonConfig.earlyBirdCutoff);
    assert.ok(seasonConfig.earlyBirdCutoff <= deadlineNy);
    assert.ok(deadlineNy < seasonConfig.scoringEnd);
  });

  test('the deadline is 11:59:59pm New York time (EST or EDT handled in the UTC string)', () => {
    const t = new Date(seasonConfig.draftDeadline).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    assert.equal(t, '23:59:59');
  });

  test('with rolling box office, each week of waiting costs a week of grosses (owner, BRO-5478)', async () => {
    if (!hasLateEntry()) return;
    const { entryPickPoints } = await import('../../src/lib/data-fantasy');
    const weekAfter = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    // Weeks end on Sundays; scoringStart is a Monday.
    const w1 = weekAfter(seasonConfig.scoringStart, 6), w2 = weekAfter(w1, 7), w3 = weekAfter(w2, 7);
    const score = {
      criticScorePoints: 0, audienceGradePoints: 0, boxOfficePoints: 9, awardsPoints: 0, totalPoints: 9,
      openingDate: null, weeklyBoxOffice: { [w1]: 3, [w2]: 3, [w3]: 3 },
      breakdown: { criticTier: null, audienceGrade: null, boxOfficeWeeks: 3, boxOfficeTotal: '$3M', awards: [] },
    };
    const atLaunch = entryPickPoints(score, null, `${seasonConfig.draftOpens}T16:00:00Z`).boxOffice;
    const weekLater = entryPickPoints(score, null, `${weekAfter(w1, 1)}T16:00:00Z`).boxOffice;
    assert.equal(atLaunch, 9, 'launch-weekend entries score every week from scoringStart');
    assert.equal(weekLater, 6, 'an entry a week later misses the first week');
  });

  test('a single draft window starts box office after it closes, so nobody drafts with known grosses', () => {
    if (hasLateEntry()) return; // rolling draft: late entries score from their own draft day
    assert.ok(seasonConfig.scoringStart > seasonConfig.earlyBirdCutoff,
      `scoringStart ${seasonConfig.scoringStart} must be after the last draft day ${seasonConfig.earlyBirdCutoff}`);
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

  test('every Tony-eligible Broadway show opened (or opens) inside the Tony window', () => {
    // A frozen show that postpones past the cutoff stays in the catalog
    // (rosters may hold it) with eligible.tonys false (generate-fantasy-config.js).
    for (const [id, s] of Object.entries(shows)) {
      if (s.category !== 'broadway' || !s.eligible.tonys) continue;
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

  test('every priced show carries an internal price note, and none reaches the public config', () => {
    const frozen = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/fantasy-league-frozen.json'), 'utf-8'));
    for (const id of Object.keys(shows)) {
      assert.ok(frozen.notes?.[id] && frozen.notes[id].length > 10, `${id} has no frozen price note`);
      // fantasy-league.json is bundled into the client (draft page): the rationale must not be in it.
      assert.equal((shows[id] as unknown as Record<string, unknown>).priceNote, undefined, `${id} leaks priceNote into the public config`);
    }
  });
});

// Unlisted until listedFrom (BRO-5483). The probes sit on the same side of
// New York midnight under EDT and EST.
describe('listing date', () => {
  test('listedFrom is a date the draft is still open on', () => {
    assert.match(LISTED_FROM, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(LISTED_FROM <= draftDeadlineDate(), `listedFrom ${LISTED_FROM} is after the deadline ${draftDeadlineDate()}`);
    // A stale date from last season would list the game a year early.
    assert.ok(LISTED_FROM.startsWith(FANTASY_SEASON.slice(0, 4)), `listedFrom ${LISTED_FROM} is not in season ${FANTASY_SEASON}`);
  });
  test('the public can find the game before the early-bird cutoff', () => {
    // Otherwise people with the direct link (testers, friends) get box office
    // weeks the public never had a chance at.
    if (hasLateEntry()) {
      assert.ok(LISTED_FROM <= EARLY_BIRD_CUTOFF, `listedFrom ${LISTED_FROM} is after earlyBirdCutoff ${EARLY_BIRD_CUTOFF}: move earlyBirdCutoff (and scoringStart) with it`);
    }
  });
  test('unlisted the evening before listedFrom, listed that morning', () => {
    assert.equal(isFantasyListed(new Date(`${LISTED_FROM}T03:00:00Z`)), false);
    assert.equal(isFantasyListed(new Date(`${LISTED_FROM}T12:00:00Z`)), true);
  });
});
