import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  hasEmptyCast,
  isPlaceholderSynopsis,
  hasStaleUpcomingTag,
  hasSameMarketTitleMatch,
  countRevivalMentions,
  MIN_SYNOPSIS_LENGTH,
} = require('../../scripts/lib/opening-night-completeness.js');

describe('hasEmptyCast', () => {
  it('true for empty array', () => {
    assert.equal(hasEmptyCast({ cast: [] }), true);
  });
  it('true for missing cast field', () => {
    assert.equal(hasEmptyCast({}), true);
  });
  it('false for non-empty cast', () => {
    assert.equal(hasEmptyCast({ cast: [{ name: 'Kerry Washington' }] }), false);
  });
});

describe('isPlaceholderSynopsis', () => {
  it('true for empty string', () => {
    assert.equal(isPlaceholderSynopsis(''), true);
  });
  it('true for null/undefined', () => {
    assert.equal(isPlaceholderSynopsis(null), true);
    assert.equal(isPlaceholderSynopsis(undefined), true);
  });
  it('true for the exact Whoopi-Monologues-class placeholder', () => {
    assert.equal(
      isPlaceholderSynopsis('brings back characters, stories, and monologues by the acclaimed comedian in this special theatrical experience'),
      true
    );
  });
  it('true for a short synopsis under the min length', () => {
    assert.equal(isPlaceholderSynopsis('A new play about grief.'), true);
  });
  it('false for a real synopsis at/over the min length', () => {
    const synopsis = '*The Whoopi Monologues* revives the characters from Whoopi Goldberg\'s landmark 1984 Broadway solo show, reimagined by director Whitney White for a cast of five: Kerry Washington, Kara Young, Dominique Fishback, Danielle Pinnock, and Kecia Lewis.';
    assert.ok(synopsis.length >= MIN_SYNOPSIS_LENGTH);
    assert.equal(isPlaceholderSynopsis(synopsis), false);
  });
  it('false for a real synopsis containing "brings back" but not the placeholder phrase (regression: Scottsboro Boys FP)', () => {
    const synopsis = "As she is waiting for a bus, a lady lifts a corner of a cake box she's holding. As it brings back memories, the scene around her fades away, and the minstrels arrive (\"Minstrel March\"). The Interlocutor, the host of the Minstrel Show, introduces the players in the troupe, including Mr. Bones and Mr.";
    assert.equal(isPlaceholderSynopsis(synopsis), false);
  });
});

describe('hasStaleUpcomingTag', () => {
  it('true when status=open and tags include upcoming', () => {
    assert.equal(hasStaleUpcomingTag({ status: 'open', tags: ['upcoming', 'lottery'] }), true);
  });
  it('false when status=open and no upcoming tag', () => {
    assert.equal(hasStaleUpcomingTag({ status: 'open', tags: ['lottery'] }), false);
  });
  it('false when status=previews and tags include upcoming (not stale yet)', () => {
    assert.equal(hasStaleUpcomingTag({ status: 'previews', tags: ['upcoming'] }), false);
  });
  it('false when tags is missing', () => {
    assert.equal(hasStaleUpcomingTag({ status: 'open' }), false);
  });
});

describe('hasSameMarketTitleMatch', () => {
  it('true for same title, same market (real revival, e.g. Death of a Salesman)', () => {
    const show = { id: 'death-of-a-salesman-2026', title: 'Death of a Salesman', market: 'broadway' };
    const shows = [show, { id: 'death-of-a-salesman-2012', title: 'Death of a Salesman', market: 'broadway' }];
    assert.equal(hasSameMarketTitleMatch(show, shows), true);
  });
  it('false for same title, different market (transfer, not revival — regression: Hamilton/Wicked/Hadestown/Oh Mary FP)', () => {
    const show = { id: 'hamilton-2015', title: 'Hamilton', market: 'broadway' };
    const shows = [show, { id: 'hamilton-west-end-2021', title: 'Hamilton', market: 'west-end' }];
    assert.equal(hasSameMarketTitleMatch(show, shows), false);
  });
  it('false when no other show shares the title', () => {
    const show = { id: 'something-new-2026', title: 'Something New', market: 'broadway' };
    assert.equal(hasSameMarketTitleMatch(show, [show]), false);
  });
  it('falls back to market when category is absent', () => {
    const show = { id: 'a-2026', title: 'A Play', market: 'broadway' };
    const shows = [show, { id: 'a-2015', title: 'A Play', market: 'broadway' }];
    assert.equal(hasSameMarketTitleMatch(show, shows), true);
  });
  it('false for same title, different category despite same coarse market (regression: Oh Mary! off-Broadway->Broadway transfer, both market=broadway)', () => {
    const show = { id: 'oh-mary-2024', title: 'Oh, Mary!', market: 'broadway', category: 'broadway' };
    const shows = [show, { id: 'oh-mary-off-broadway-2024', title: 'Oh, Mary!', market: 'broadway', category: 'off-broadway' }];
    assert.equal(hasSameMarketTitleMatch(show, shows), false);
  });
});

describe('countRevivalMentions', () => {
  it('counts standalone "revival" occurrences case-insensitively', () => {
    const texts = ['This REVIVAL is terrific.', 'A revival of a revival, sort of.'];
    assert.equal(countRevivalMentions(texts), 3);
  });
  it('does not match "revivalist" or other substrings', () => {
    assert.equal(countRevivalMentions(['A revivalist tent show, not a revival exactly.']), 1);
  });
  it('returns 0 for empty/undefined input', () => {
    assert.equal(countRevivalMentions([]), 0);
    assert.equal(countRevivalMentions(undefined), 0);
  });
});
