/**
 * BRO-6477: the former-cast guard flagged Phelim McDermott (director) and
 * Hayao Miyazaki (author of the source film) on my-neighbour-totoro-west-end-2025
 * and failed the former-cast sweep on every main run from 2026-10-28 09:50Z.
 *
 * Cause 1: backfill-cast-web.js stored the LLM's `role: "role not specified"`
 * on three cast rows. The guard split that into role cues "role", "not",
 * "specified", so "it is not an exact replica" 40 characters from a name made
 * the name look like a departed cast member.
 * Cause 2: "Hayao Miyazaki's tale of Satsuki and Mei" names the source film's
 * author next to real role names; "tale"/"film"/"anime" were not on the
 * source-work noun list that exempts an author.
 *
 * Fixtures are the real review sentences, so these fail on the old code
 * without needing the private review-texts corpus.
 *
 * Run: node --test tests/unit/former-cast-placeholder-role.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { excerptMentionsFormerCast } = require('../../scripts/lib/excerpt-validation');
const { isPlaceholderRole, cleanRole, findPlaceholderCastRoles } = require('../../scripts/lib/cast-role');

const TOTORO = {
  id: 'my-neighbour-totoro-west-end-2025',
  title: 'My Neighbour Totoro',
  venue: 'Gillian Lynne Theatre',
  cast: [
    { name: 'Victoria Chen', role: 'Satsuki' },
    { name: 'Ai Ninomiya', role: 'Mei' },
    { name: 'Dai Tabuchi', role: 'role not specified' },
    { name: 'Jacqueline Tate', role: 'role not specified' },
  ],
  // The structured creative team is incomplete (playwright only), as it is for
  // most fringe and regional shows: the guard must not depend on it.
  creativeTeam: [{ name: 'Tom Morton-Smith', role: 'Playwright' }],
  priorRuns: [{ venue: 'Barbican Theatre', openingDate: '2022-10-08', closingDate: '2023-01-21' }],
};

const check = (show, excerpt, extra = {}) =>
  excerptMentionsFormerCast(excerpt, {
    show,
    reviewDate: '2022-11-01',
    reviewData: { publishDate: '2022-11-01', fullText: excerpt, westEndTheatreExcerpt: excerpt, ...extra },
  });

describe('placeholder cast roles are not role cues', () => {
  it('does not flag a director named in "Under the direction of ..." beside the word "not"', () => {
    const excerpt = 'Under the direction of Phelim McDermott, it is not an exact replica. There is a different imagination at work here.';
    assert.strictEqual(check(TOTORO, excerpt).mentionsFormerCast, false);
  });

  it('gives the same answer with the placeholder rows removed', () => {
    const clean = { ...TOTORO, cast: TOTORO.cast.filter((c) => c.role !== 'role not specified') };
    const excerpt = 'Under the direction of Phelim McDermott, it is not an exact replica. There is a different imagination at work here.';
    assert.strictEqual(check(clean, excerpt).mentionsFormerCast, check(TOTORO, excerpt).mentionsFormerCast);
  });

  it('still flags a genuine former lead beside a real role name (recall)', () => {
    const excerpt = 'Jo Former is wonderful as Satsuki, and the puppetry is joyous.';
    const res = check(TOTORO, excerpt);
    assert.strictEqual(res.mentionsFormerCast, true);
    assert.strictEqual(res.name, 'former');
  });
});

describe('source-film author beside role names is not a former cast member', () => {
  it('does not flag "Hayao Miyazaki’s tale of Satsuki and Mei"', () => {
    const excerpt = 'But Hayao Miyazaki’s tale of Satsuki and Mei, the daughters, is told with warmth.';
    assert.strictEqual(check(TOTORO, excerpt).mentionsFormerCast, false);
  });

  it('does not flag "Hayao Miyazaki’s beloved anime" beside role names', () => {
    const excerpt = 'Hayao Miyazaki’s beloved anime has Satsuki and Mei at its heart.';
    assert.strictEqual(check(TOTORO, excerpt).mentionsFormerCast, false);
  });

  it('keeps flagging an actor possessive that is not a source work (recall)', () => {
    const excerpt = 'Jo Former’s Satsuki is the heart of the evening.';
    assert.strictEqual(check(TOTORO, excerpt).mentionsFormerCast, true);
  });
});

describe('screen-work nouns do not hide actors (ship-check recall)', () => {
  for (const excerpt of [
    'Jo Former stole the film as Satsuki, and the puppetry is joyous.',
    'Jo Former brings the script to life as Satsuki.',
    'Jo Former’s film debut as Satsuki is a delight.',
    'Jo Former turns the tale on its head as Satsuki.',
  ]) {
    it(`still flags: ${excerpt}`, () => assert.strictEqual(check(TOTORO, excerpt).mentionsFormerCast, true));
  }
});

describe('cast-role helper', () => {
  it('recognises "no answer" sentences as placeholders', () => {
    for (const r of ['role not specified', 'Role Not Specified', 'role unknown', 'not specified', 'unspecified', 'N/A', 'n/a', 'none', 'null', 'TBD', '?', '--', ' role not specified. ']) {
      assert.strictEqual(isPlaceholderRole(r), true, JSON.stringify(r));
    }
  });

  it('leaves real roles and real casting labels alone', () => {
    for (const r of ['Atticus Finch', 'Satsuki', 'Ensemble', 'Unknown Male', 'Cast of Richard III', 'Judge Taylor', 'Mr. Not-Specified-Smith', 'Understudy for Mei']) {
      assert.strictEqual(isPlaceholderRole(r), false, JSON.stringify(r));
      assert.strictEqual(cleanRole(r), r);
    }
  });

  it('cleanRole drops placeholders and empties, trims real roles', () => {
    assert.strictEqual(cleanRole('role not specified'), undefined);
    assert.strictEqual(cleanRole('   '), undefined);
    assert.strictEqual(cleanRole(undefined), undefined);
    assert.strictEqual(cleanRole(null), undefined);
    assert.strictEqual(cleanRole('  Mei  '), 'Mei');
  });

  it('findPlaceholderCastRoles lists every offending cast row', () => {
    assert.deepStrictEqual(findPlaceholderCastRoles([TOTORO, { id: 'ok', cast: [{ name: 'A', role: 'Mei' }] }]), [
      { id: TOTORO.id, name: 'Dai Tabuchi', role: 'role not specified' },
      { id: TOTORO.id, name: 'Jacqueline Tate', role: 'role not specified' },
    ]);
  });
});
