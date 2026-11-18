// BRO-7791: a review headline that names a subtitled show by its one-word lead is admitted by the lane only with every
// corroboration (tonight's show, a direct same-market outlet source, review + market/venue cues, a distinctive word in
// title position, no other staging). Found by the BRO-7781 simulated night: TheaterMania's "Review: Dollygram Glitters on
// Broadway" was a near-miss and went live 70 minutes later through the BWW roundup.
// Red with the matcher change reverted: the replay below admits nothing and reports a near-miss instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const { corroboratedLeadWord } = require('../../scripts/lib/opening-night-lane/lead-word-match.js');
const { setPressNameShows } = require('../../scripts/lib/show-names.js');

const NIGHT = '2026-11-19';
const DOLLYGRAM = { id: 'sim-dollygram-2026', title: 'Dollygram: An Original Musical', venue: 'Imperial Theatre', category: 'broadway', market: 'broadway', openingDate: NIGHT, status: 'previews', cast: [] };
const SHOWS = [
  DOLLYGRAM,
  { id: 'hello-dolly-2017', title: 'Hello, Dolly!', status: 'closed' },
  { id: 'hamilton', title: 'Hamilton', status: 'open' },
  { id: 'the-outsiders', title: 'The Outsiders', status: 'open' },
];
const TM_INDEX = 'https://www.theatermania.com/news/?categories=reviews';
const TM_URL = 'https://www.theatermania.com/news/review-dollygram-glitters-on-broadway_1234567/';
const TM_HEADLINE = 'Review: Dollygram Glitters on Broadway';
const CTX = { night: NIGHT, direct: true, outletId: 'theatermania', reviewCue: true };

function withShows(shows, fn) {
  setPressNameShows(shows);
  try { return fn(); } finally { setPressNameShows(null); }
}
const judge = (title, url = TM_URL, show = DOLLYGRAM, ctx = CTX, shows = SHOWS) => withShows(shows, () => corroboratedLeadWord({ title, url }, show, ctx));

test('accepts the Dollygram TheaterMania index headline with every corroboration', () => {
  assert.deepEqual(judge(TM_HEADLINE), { admit: true, reason: 'lead-word-corroborated', word: 'dollygram' });
  // other real headline shapes: quoted title, "<title> review", venue cue instead of "Broadway", star prefix
  for (const h of ["'Dollygram' review: a sweet, slight new musical on Broadway", 'Dollygram review: Broadway gets a valentine',
    'Review: Dollygram Brings Glitter to the Imperial', 'Broadway Review: Dollygram', '4 stars: Dollygram on Broadway']) {
    assert.equal(judge(h, 'https://www.theatermania.com/news/x_1/').admit, true, h);
  }
});

test('refuses a one-word lead with no corroboration', () => {
  const cases = [
    ['wrong market', 'Review: Dollygram Glitters in the West End', 'other-market-cue'],
    ['off-broadway cue for a Broadway show', 'Off-Broadway Review: Dollygram', 'other-market-cue'],
    ['no market or venue cue', 'Review: Dollygram Glitters', 'no-market-or-venue-cue', 'https://www.theatermania.com/news/review-dollygram-glitters_1/'],
    ['casting article', 'Dollygram Broadway casting announced: review the full company', 'non-review-article'],
    ['another staging (tryout)', 'Review: Dollygram glitters in its pre-Broadway tryout', 'other-staging-cue'],
    ['another staging (venue)', 'Review: Dollygram at the Paper Mill Playhouse is Broadway-ready', 'other-venue:Paper Mill Playhouse'],
    ['another staging (company possessive)', "Review: Goodspeed's Dollygram eyes Broadway", 'other-production:possessive:Goodspeed'],
    ['word not used as a title', 'Review: Hamlet on Broadway is a dollygram of grief', 'lead-word-not-in-title-position', 'https://www.theatermania.com/news/review-hamlet_1/'],
    ['a roundup naming another show', 'Review: Dollygram and The Outsiders on Broadway', 'other-show-named:the-outsiders'],
  ];
  for (const [what, h, reason, url] of cases) {
    const v = judge(h, url || 'https://www.theatermania.com/news/x_1/');
    assert.equal(v.admit, false, `${what}: admitted "${h}"`);
    assert.equal(v.reason, reason, `${what}: ${JSON.stringify(v)}`);
  }
});

test('refuses outside the opening night, off a direct source, off the market, without a review cue', () => {
  assert.equal(judge(TM_HEADLINE, TM_URL, DOLLYGRAM, { ...CTX, night: '2026-11-18' }).reason, 'not-opening-tonight');
  assert.equal(judge(TM_HEADLINE, TM_URL, DOLLYGRAM, { ...CTX, night: undefined }).reason, 'not-opening-tonight');
  assert.equal(judge(TM_HEADLINE, TM_URL, DOLLYGRAM, { ...CTX, direct: false }).reason, 'not-a-direct-outlet-source');
  assert.equal(judge(TM_HEADLINE, TM_URL, DOLLYGRAM, { ...CTX, outletId: undefined }).reason, 'not-a-direct-outlet-source');
  assert.equal(judge(TM_HEADLINE, TM_URL, DOLLYGRAM, { ...CTX, outletId: 'artsdesk' }).reason, 'outlet-off-market'); // London-only outlet
  assert.equal(judge(TM_HEADLINE, TM_URL, DOLLYGRAM, { ...CTX, outletId: 'no-such-outlet' }).reason, 'unknown-outlet');
  assert.equal(judge(TM_HEADLINE, TM_URL, DOLLYGRAM, { ...CTX, reviewCue: false }).reason, 'no-review-cue');
});

test('refuses a shared or generic lead word', () => {
  const dolly = { ...DOLLYGRAM, id: 'dolly-2027', title: 'Dolly: A True Original Musical' };
  const partons = { id: 'dolly-partons-smoky-mountain-christmas-carol-tour-2026', title: "Dolly Parton's Smoky Mountain Christmas Carol", status: 'upcoming' };
  assert.match(judge('Review: Dolly Glitters on Broadway', TM_URL, dolly, CTX, [dolly, partons]).reason, /^shared-with-active:dolly-partons/);
  // two closed shows hold the word: generic ("Othello")
  const othello = { ...DOLLYGRAM, id: 'othello-2026', title: 'Othello: A New Staging' };
  const old = [{ id: 'othello-2016', title: 'Othello', status: 'closed' }, { id: 'othello-2023', title: 'Othello', status: 'closed' }];
  const generic = [{ id: 'm1', title: 'The Moor: Othello Retold', status: 'closed' }, { id: 'm2', title: 'Desdemona and Othello in Love', status: 'closed' }];
  assert.equal(judge('Review: Othello on Broadway', TM_URL, othello, CTX, [othello, ...generic]).reason, 'shared-with-closed-shows');
  // a closed namesake blocks it ("Degenerates" for "Degenerates: Dec & Jan", backtest 2026-11-18)
  assert.equal(judge('Review: Othello on Broadway', TM_URL, othello, CTX, [othello, old[0]]).reason, 'closed-namesake:othello-2016');
  const degen = { ...DOLLYGRAM, id: 'degenerates-dec-jan', title: 'Degenerates: Dec & Jan', category: 'off-broadway' };
  assert.equal(judge('', 'https://www.newyorktheatreguide.com/reviews/degenerates-off-broadway-review', degen, { ...CTX, outletId: 'nytg' },
    [degen, { id: 'degenerates-off-broadway-2026', title: 'Degenerates', status: 'closed' }]).reason, 'closed-namesake:degenerates-off-broadway-2026');
  // one closed show holding the word inside a longer title is allowed
  assert.equal(judge('Review: Othello on Broadway', TM_URL, othello, CTX, [othello, { id: 'moor', title: 'The Moor: Othello Retold Again', status: 'closed' }]).admit, true);
  // a month is never a title word on its own (August: Osage County)
  const aoc = { ...DOLLYGRAM, id: 'aoc', title: 'August: Osage County', market: 'west-end', category: 'west-end' };
  assert.equal(judge('Review: August in the West End', TM_URL, aoc, { ...CTX, outletId: 'artsdesk' }, [aoc]).reason, 'lead-word-is-a-month');
  // the same production listed twice (Diana Off-Broadway and Off-West End) is shared
  const dianaOB = { id: 'diana-ob', title: 'Diana: The Untold and Untrue Story', venue: 'SoHo Playhouse', category: 'off-broadway', market: 'broadway', openingDate: NIGHT, status: 'upcoming' };
  const dianaOWE = { ...dianaOB, id: 'diana-owe', category: 'off-west-end', market: 'west-end', openingDate: null };
  assert.match(judge('Off-Broadway Review: Diana', 'https://www.theatermania.com/news/x_1/', dianaOB, CTX, [dianaOB, dianaOWE]).reason, /^shared-with-active:diana-owe/);
});

test('Off-Broadway and West End market cues', () => {
  const sac = { id: 'sacrifices', title: 'SACRIFICES: The Musical', venue: 'Angel Orensanz Foundation', category: 'off-broadway', market: 'broadway', openingDate: NIGHT, status: 'upcoming' };
  assert.equal(judge('Off-Broadway Review: Sacrifices', 'https://www.theatermania.com/news/x_1/', sac, CTX, [sac]).admit, true);
  assert.equal(judge('Review: Sacrifices at Angel Orensanz Foundation', 'https://www.theatermania.com/news/x_1/', sac, CTX, [sac]).admit, true);
  assert.equal(judge('Broadway Review: Sacrifices', 'https://www.theatermania.com/news/x_1/', sac, CTX, [sac]).reason, 'other-market-cue');
  const cin = { id: 'cin', title: 'Cinderella: Buttons Undone!', venue: 'Charing Cross Theatre', category: 'off-west-end', market: 'west-end', openingDate: NIGHT, status: 'upcoming' };
  assert.equal(judge('Review: Cinderella at Charing Cross Theatre', 'https://www.thestage.co.uk/reviews/x', cin, { ...CTX, outletId: 'artsdesk' }, [cin]).admit, true);
  assert.equal(judge('Review: Cinderella on Broadway', 'https://www.thestage.co.uk/reviews/x', cin, { ...CTX, outletId: 'artsdesk' }, [cin]).reason, 'other-market-cue');
});

// ---- the lane path end to end: section index -> candidate -> date check -> admitted --------------------------------
const INDEX_HTML = `<html><body><main>
  <article><a href="${TM_URL}"><h3>${TM_HEADLINE}</h3></a></article>
  <article><a href="https://www.theatermania.com/news/dollygram-broadway-casting-announced_1234500/"><h3>Dollygram Sets Broadway Casting</h3></a></article>
  <article><a href="https://www.theatermania.com/news/review-dollygram-dazzles-west-end_1234501/"><h3>Review: Dollygram Dazzles the West End</h3></a></article>
</main></body></html>`;
const ARTICLE = `<html><head><meta property="article:published_time" content="2026-11-20T02:05:00Z"><title>${TM_HEADLINE}</title></head>
  <body><article><h1>${TM_HEADLINE}</h1><p>Dollygram: An Original Musical opened tonight at the Imperial Theatre.</p></article></body></html>`;

function replay(show = DOLLYGRAM, night = NIGHT) {
  const fetchText = async (u) => {
    if (String(u) === TM_INDEX) return INDEX_HTML;
    if (String(u).startsWith('https://www.theatermania.com/news/')) return ARTICLE;
    throw new Error(`not recorded: ${u}`);
  };
  return withShows(SHOWS, () => d.runDiscoveryPass({
    show, night, now: Date.parse('2026-11-20T02:10:00Z'), startedAt: Date.parse('2026-11-20T01:30:00Z'), fetchText, timeZone: 'America/New_York',
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'theatermania', indexUrl: TM_INDEX }], matchOpts: { fuzzy: true } })],
  }));
}

test('lane replay: the Dollygram TheaterMania index review is admitted on the first pass; the casting and West End items are not', async () => {
  const r = await replay();
  const urls = (r.admitted || []).map((a) => a.url);
  assert.ok(urls.some((u) => u.includes('1234567')), `not admitted: ${JSON.stringify({ admitted: r.admitted, rejected: r.rejected, nearMisses: r.nearMisses })}`);
  assert.ok(!urls.some((u) => u.includes('1234500') || u.includes('1234501')), `admitted a non-review or another market: ${urls}`);
  assert.ok(!(r.nearMisses || []).some((n) => n.url.includes('1234567')), 'an admitted review must not also alert as a near-miss');
  // the West End headline stays a near-miss (reported, never admitted)
  assert.ok((r.nearMisses || []).some((n) => n.url.includes('1234501')), JSON.stringify(r.nearMisses));
});

test('lane replay: the night before its opening the same headline is only a near-miss', async () => {
  const r = await replay({ ...DOLLYGRAM, openingDate: '2026-11-20' });
  assert.ok(!(r.admitted || []).some((a) => a.url.includes('1234567')), 'admitted on the wrong night');
  assert.ok((r.nearMisses || []).some((n) => n.url.includes('1234567')), 'near-miss alarm silent');
});

test('feed path: an own-host feed item with a one-word lead is admitted on its night', async () => {
  const FEED = 'https://www.theatermania.com/feed/';
  const xml = `<?xml version="1.0"?><rss><channel><item><title>${TM_HEADLINE}</title><link>${TM_URL}</link><pubDate>Fri, 20 Nov 2026 02:05:00 GMT</pubDate></item></channel></rss>`;
  const run = (night) => withShows(SHOWS, () => d.rssAdapter({ feeds: [{ url: FEED, outletId: 'theatermania' }], matchOpts: { fuzzy: true } })
    .discover({ show: DOLLYGRAM, night, fetchText: async () => xml }));
  const on = await run(NIGHT);
  assert.ok(on.some((c) => c.url === TM_URL && !c.nearMiss), JSON.stringify(on));
  const off = await run('2026-11-18');
  assert.ok(!off.some((c) => c.url === TM_URL && !c.nearMiss), JSON.stringify(off));
});
