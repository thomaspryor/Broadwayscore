import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  hasEmptyCast,
  isPlaceholderSynopsis,
  hasStaleUpcomingTag,
  hasStoredStaleUpcomingTag,
  isUpcomingTag,
  stripUpcomingTag,
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
  it('false for a tour entry (BRO-5439: tours are not revivals of their parent or sibling segments)', () => {
    const show = { id: 'legally-blonde-tour-2027', title: 'Legally Blonde', category: 'tour', market: 'tour', tourOf: 'legally-blonde-2007' };
    const shows = [show, { id: 'legally-blonde-2007', title: 'Legally Blonde', category: 'broadway' }, { id: 'legally-blonde-tour-2026', title: 'Legally Blonde', category: 'tour' }];
    assert.equal(hasSameMarketTitleMatch(show, shows), false);
    for (const t of [{ tourOf: 'x' }, { category: 'tour' }, { market: 'tour' }]) {
      const s2 = { id: 'a-tour', title: 'Legally Blonde', ...t };
      assert.equal(hasSameMarketTitleMatch(s2, [s2, { id: 'b', title: 'Legally Blonde', ...t }]), false);
    }
  });
  it('revival-unverified check passes a show with revivalVerifiedNot despite title match (BRO-5439)', () => {
    const chk = require('../../scripts/lib/opening-night-checks/revival-unverified.check.js');
    const show = { id: 'pa-2026', title: 'Paranormal Activity', category: 'broadway', status: 'open', openingDate: '2026-08-25', revivalVerifiedNot: true };
    const sib = { id: 'pa-2020', title: 'Paranormal Activity', category: 'broadway', openingDate: '2020-01-01' };
    assert.equal(chk.run(show, { shows: [show, sib], reviewTextsRoot: '/nonexistent' }).ok, true);
    assert.equal(chk.run({ ...show, revivalVerifiedNot: undefined }, { shows: [show, sib], reviewTextsRoot: '/nonexistent' }).ok, false);
  });
  it('revival-unverified check passes a tour even with revival-heavy title match', () => {
    const chk = require('../../scripts/lib/opening-night-checks/revival-unverified.check.js');
    const show = { id: 'p-tour', title: 'Parade', category: 'tour', tourOf: 'p', status: 'upcoming' };
    const r = chk.run(show, { shows: [show, { id: 'q', title: 'Parade', category: 'tour' }], reviewTextsRoot: '/nonexistent' });
    assert.equal(r.ok, true);
  });
  it('true for same title, same market (real revival, e.g. Death of a Salesman)', () => {
    const show = { id: 'death-of-a-salesman-2026', title: 'Death of a Salesman', market: 'broadway' };
    const shows = [show, { id: 'death-of-a-salesman-2012', title: 'Death of a Salesman', market: 'broadway' }];
    assert.equal(hasSameMarketTitleMatch(show, shows), true);
  });
  it('false when the only same-title sibling is a LATER production (BRO-5439: sacrilegious 2026 vs 2027)', () => {
    const show = { id: 's-2026', title: 'Sacrilegious', category: 'off-west-end', previewsStartDate: '2026-12-05' };
    const later = { id: 's-2027', title: 'Sacrilegious', category: 'off-west-end', previewsStartDate: '2027-04-03', isRevival: true };
    assert.equal(hasSameMarketTitleMatch(show, [show, later]), false);
    assert.equal(hasSameMarketTitleMatch(later, [show, later]), true);
    // undated: a sibling already flagged isRevival is the later one
    const u = { id: 'u1', title: 'X', category: 'broadway' };
    assert.equal(hasSameMarketTitleMatch(u, [u, { id: 'u2', title: 'X', category: 'broadway', isRevival: true }]), false);
    // undated target, dated sibling: sibling presumed earlier
    assert.equal(hasSameMarketTitleMatch(u, [u, { id: 'u3', title: 'X', category: 'broadway', openingDate: '2012-01-01', isRevival: true }]), true);
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

describe('hasStoredStaleUpcomingTag (BRO-3208)', () => {
  it('flags open, previews and closed shows still tagged upcoming, any case', () => {
    assert.equal(hasStoredStaleUpcomingTag({ status: 'closed', tags: ['upcoming', 'new'] }), true);
    assert.equal(hasStoredStaleUpcomingTag({ status: 'previews', tags: ['Upcoming'] }), true);
    assert.equal(hasStoredStaleUpcomingTag({ status: 'open', tags: ['upcoming'] }), true);
  });
  it('leaves upcoming/announced shows and untagged shows alone', () => {
    assert.equal(hasStoredStaleUpcomingTag({ status: 'upcoming', tags: ['upcoming'] }), false);
    assert.equal(hasStoredStaleUpcomingTag({ status: 'announced', tags: ['upcoming'] }), false);
    assert.equal(hasStoredStaleUpcomingTag({ status: 'closed', tags: ['new'] }), false);
    assert.equal(hasStoredStaleUpcomingTag({ status: 'closed' }), false);
  });
});

describe('isUpcomingTag / stripUpcomingTag (BRO-5261)', () => {
  it('matches any case, only strings', () => {
    assert.equal(isUpcomingTag('upcoming'), true);
    assert.equal(isUpcomingTag('Upcoming'), true);
    assert.equal(isUpcomingTag('UPCOMING'), true);
    assert.equal(isUpcomingTag('upcoming-soon'), false);
    assert.equal(isUpcomingTag(null), false);
    assert.equal(isUpcomingTag(1), false);
  });
  it('strips every case variant in place and reports it', () => {
    const show = { tags: ['Upcoming', 'musical', 'upcoming'] };
    assert.equal(stripUpcomingTag(show), true);
    assert.deepEqual(show.tags, ['musical']);
  });
  it('is a no-op (false) with no tag or no tags array', () => {
    const show = { tags: ['musical'] };
    const before = show.tags;
    assert.equal(stripUpcomingTag(show), false);
    assert.equal(show.tags, before);
    assert.equal(stripUpcomingTag({}), false);
    assert.equal(stripUpcomingTag(null), false);
  });
  it('after stripping, hasStoredStaleUpcomingTag is false', () => {
    const show = { status: 'open', tags: ['UPCOMING'] };
    assert.equal(hasStoredStaleUpcomingTag(show), true);
    stripUpcomingTag(show);
    assert.equal(hasStoredStaleUpcomingTag(show), false);
  });
});
