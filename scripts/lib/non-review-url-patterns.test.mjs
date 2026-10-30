// non-review-url-patterns.js — canonical not-a-review host/path patterns
// shared between audit-show-review-gap.js's isReviewUrl() and the S5
// adversarial probe's classifyNonReviewUrl() (task #907 ship-check finding:
// extracted so the two callers can't drift apart).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyGapCandidateUrl, namedNonReviewReason, NAMED_NON_REVIEW_URL_PATTERNS, NON_REVIEW_HOST_PATTERNS, ALLOWED_ORG_HOSTS } = require('./non-review-url-patterns.js');

// Mirrors audit-show-review-gap.js's registrableHost() collapse for a plain
// host-pattern check (task #71 residual-gap triage additions) — including its
// multi-part public-suffix list, so a .co.uk host collapses to 3 labels, not 2.
const MULTIPART_SUFFIXES = ['co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br'];
function isHostBlocked(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return false; }
  const parts = host.split('.').filter(Boolean);
  const keep = MULTIPART_SUFFIXES.some(s => host.endsWith('.' + s)) ? 3 : 2;
  const registrable = parts.length > keep ? parts.slice(-keep).join('.') : host;
  return NON_REVIEW_HOST_PATTERNS.some(rx => rx.test(registrable)) && !ALLOWED_ORG_HOSTS.has(registrable);
}

test('namedNonReviewReason: ticketing reseller hosts are named', () => {
  assert.equal(namedNonReviewReason('https://www.newyorkcitytheatre.com/some-show'), 'ticketing-reseller');
  assert.equal(namedNonReviewReason('https://newbrunswicktheater.com/tickets'), 'ticketing-reseller');
  assert.equal(namedNonReviewReason('https://www.broadway.com/shows/a-walk-on-the-moon/event/21764799/'), 'ticketing-reseller');
});

test('namedNonReviewReason: venue production pages are named', () => {
  assert.equal(namedNonReviewReason('https://www.nationaltheatre.org.uk/productions/the-car-man'), 'venue-production-page');
  assert.equal(namedNonReviewReason('https://www.theatermania.com/shows/new-york-city-theater/x_1832919/'), 'venue-production-page');
});

test('namedNonReviewReason: event listing pages are named', () => {
  assert.equal(namedNonReviewReason('https://middlesexcountyculture.com/event/the-car-man/'), 'event-listing');
});

test('namedNonReviewReason: host+path pairs only exclude the specific path, not the whole host', () => {
  // londontheatre.co.uk publishes real reviews under /reviews/ — only /show/NNNN is excluded.
  assert.equal(namedNonReviewReason('https://www.londontheatre.co.uk/show/1234/the-car-man'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://www.londontheatre.co.uk/reviews/the-car-man'), null);
  // BRO-3964: UKTW show listings (live and /archive/) are booking pages; /news/ articles stay candidates.
  assert.equal(namedNonReviewReason('https://www.uktw.co.uk/London/The-Coronet/Play/De-Profundis/L1410119577/'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://www.uktw.co.uk/archive/Chichester/Minerva-Theatre/Play/Antigone-Exits/L350214576/'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://www.uktw.co.uk/Kingston/Rose-Theatre-Kingston/Play/Three-Men-In-a-Boat/L0539480084'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://www.uktw.co.uk/news/What-The-Animals-Say/7599.html'), null);
  assert.equal(classifyGapCandidateUrl('https://www.uktw.co.uk/London/BAC/Play/Nina/L0470592871/').ok, false);
  // theatermania publishes real reviews under /news/review-.../ — only /shows/ is excluded.
  assert.equal(namedNonReviewReason('https://www.theatermania.com/news/review-camping-a-romantic-tragedy_1842335/'), null);
});

test('namedNonReviewReason: an ordinary outlet URL is not classified', () => {
  assert.equal(namedNonReviewReason('https://theartsdesk.com/new-reviews/frank-sinatra-review'), null);
});

test('namedNonReviewReason: seventh wave — OWE opening ticketing/listing hosts (2026-08-06)', () => {
  // Each of these reached a census "missing reviews" list on the Cats/NYSM/
  // I'm Every Woman openings; the groupon one was auto-ingested as a bogus
  // provisional outlet before downstream guards caught it.
  assert.equal(namedNonReviewReason('https://www.groupon.co.uk/deals/ingresso-now-you-see-me'), 'ticketing-reseller');
  assert.equal(namedNonReviewReason('https://www.groupon.com/deals/some-show'), 'ticketing-reseller');
  assert.equal(namedNonReviewReason('https://www.officialtheatre.com/london-coliseum/now-you-see-me-live/'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://www.kxtickets.com/whats-on/i-m-every-woman-the-chaka-khan-musical'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://www.westend.com/shows/now-you-see-me-live/'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://www.mischiefcomedy.com/whats-on/the-comedy-about-spies/london/'), 'venue-production-page');
  // westendtheatre.com (the WET aggregator) must NOT be caught by the
  // westend.com host pattern — WET review-roundup pages are a real source.
  assert.equal(namedNonReviewReason('https://www.westendtheatre.com/reviews/cats/'), null);
});

test('classifyReviewUrl: NYTG /theatre-news/ cast announcements are news, /reviews/ stays ok', () => {
  const { classifyReviewUrl } = require('./non-review-url-patterns.js');
  assert.deepEqual(classifyReviewUrl('https://www.newyorktheatreguide.com/theatre-news/news/cast-set-for-creation-stories-and-all-the-important-importants-off-broadway'), { ok: false, reason: 'news-article' });
  assert.equal(classifyReviewUrl('https://www.newyorktheatreguide.com/reviews/creation-stories-and-all-the-important-importants-off-broadway-review').ok, true);
});

test('classifyReviewUrl: nyc.com /events/ ticketing pages blocked (BRO-5500)', () => {
  const { classifyReviewUrl } = require('./non-review-url-patterns.js');
  assert.deepEqual(classifyReviewUrl('https://www.nyc.com/events/sea_wall.443831802918871040/'), { ok: false, reason: 'ticketing-listing' });
  assert.equal(classifyReviewUrl('https://www.nyc.com/some-review-article/').ok, true);
});

test('classifyReviewUrl: host-scoped ticket pages blocked, real review shapes stay ok', () => {
  const { classifyReviewUrl } = require('./non-review-url-patterns.js');
  // WET /NNNNNN/shows/… show pages and LBO root ticket slugs are listings.
  assert.deepEqual(classifyReviewUrl('https://www.westendtheatre.com/317407/shows/cats-tickets/'), { ok: false, reason: 'ticketing-listing' });
  assert.deepEqual(classifyReviewUrl('https://www.londonboxoffice.co.uk/now-you-see-me-tickets'), { ok: false, reason: 'ticketing-listing' });
  // …but the same hosts' REAL review pages must stay ok.
  assert.equal(classifyReviewUrl('https://www.westendtheatre.com/reviews/cats/').ok, true);
  assert.equal(classifyReviewUrl('https://www.londonboxoffice.co.uk/news/post/cats-review').ok, true);
  // Host-agnostic FP guards (full-corpus check 2026-08-06): real reviews whose
  // slugs end in "-ticket(s)" or that live under a /whats-on/ section. A bare
  // path rule for either shape ate these — keep them ok forever.
  assert.equal(classifyReviewUrl('https://www.express.co.uk/entertainment/theatre/1769203/Operation-Mincemeat-musical-review-London-2023-Fortune-theatre-dates-tickets').ok, true);
  assert.equal(classifyReviewUrl('https://www.digitalspy.com/movies/a63081350/devil-wears-prada-musical-review-buy-tickets/').ok, true);
  assert.equal(classifyReviewUrl('https://www.manchestereveningnews.co.uk/whats-on/whats-on-news/review-car-man--lowry-9336528').ok, true);
  assert.equal(classifyReviewUrl('https://www.liverpoolecho.co.uk/whats-on/theatre-news/mousetrap-liverpool-empire-clever-classic-25472794').ok, true);
  assert.equal(classifyReviewUrl('https://nypost.com/2025/09/29/entertainment/masquerade-review-secretive-off-broadway-phantom-of-the-opera-riff-is-a-sexy-hot-ticket/').ok, true);
  assert.equal(classifyReviewUrl('https://www.cityam.com/inter-alia-play-review-springs-must-book-west-end-ticket/').ok, true);
});

test('submissionNonReviewReason: SeatPlan ticket pages are refused, its /news/ reviews are not (BRO-2716)', () => {
  const { submissionNonReviewReason } = require('./non-review-url-patterns.js');
  // The page that reached the scores through /submit-review.
  assert.equal(submissionNonReviewReason('https://seatplan.com/new-york/cat-cohen-broad-strokes-tickets/'), 'ticket-seller-product-page');
  assert.equal(namedNonReviewReason('https://seatplan.com/london/heathers-the-musical-tickets'), 'ticket-seller-product-page');
  // Scored editorial reviews (data/review-texts, 2026-10-13).
  assert.equal(submissionNonReviewReason('https://seatplan.com/london/news/beetlejuice-review-prince-edward-theatre/'), null);
  assert.equal(namedNonReviewReason('https://seatplan.com/london/news/cats-review-regents-park-open-air-theatre-london/'), null);
});

test('namedNonReviewReason: an unparseable URL returns null, never throws', () => {
  assert.equal(namedNonReviewReason('not-a-url'), null);
  assert.equal(namedNonReviewReason(''), null);
  assert.equal(namedNonReviewReason(null), null);
});

test('NON_REVIEW_HOST_PATTERNS: page-asset chaff is blocked (task #71)', () => {
  // Measured in data/audit/show-review-gap.json's "missing" lists across
  // ~150 audited shows: fonts/CDN/maps/forms embedded in an aggregator
  // article's HTML.
  assert.equal(isHostBlocked('https://dalyklerwhmui.cloudfront.net'), true);
  assert.equal(isHostBlocked('https://fonts.gstatic.com'), true);
  assert.equal(isHostBlocked('https://fonts.googleapis.com/css2'), true);
  assert.equal(isHostBlocked('https://maps.google.com/'), true);
  assert.equal(isHostBlocked('https://docs.google.com/forms/d/e/abc/viewform'), true);
  assert.equal(isHostBlocked('https://www.todaytixgroup.com/careers'), true);
  // A real outlet is never blocked by this wave.
  assert.equal(isHostBlocked('https://www.nytimes.com/2026/01/01/theater/some-review.html'), false);
  // show-score.com is deliberately NOT blocked despite its own catalog links
  // leaking through the same way — coverage-adversarial-probe.js's
  // onDiskByUrlFor() depends on isReviewUrl() to index legitimately-captured
  // Show Score star-stub files by URL (see aggregator-domains.js).
  assert.equal(isHostBlocked('https://www.show-score.com/off-broadway-shows/bone-wars'), false);
});

test('NON_REVIEW_HOST_PATTERNS: UK ticketing/tourism-listing chaff is blocked (task #71 fifth wave)', () => {
  assert.equal(isHostBlocked('https://securepubads.g.doubleclick.net/pagead/managed/dict/m1/gpt'), true);
  assert.equal(isHostBlocked('https://www.showify.uk/shows/dog-man-the-musical'), true);
  assert.equal(isHostBlocked('https://www.showpass.com/dog-man-the-musical-affp3/'), true);
  assert.equal(isHostBlocked('https://showtours.co.uk/book/dog-man-the-musical-london/'), true);
  assert.equal(isHostBlocked('https://www.bookitplease.com/shows/united-kingdom/dog-man-6046'), true);
  assert.equal(isHostBlocked('https://www.visitlondon.com/things-to-do/event/51157787-dog-man'), true);
  // londontheatredirect.com is deliberately NOT blocked — it also publishes
  // /news/*-review posts alongside its ticketing pages.
  assert.equal(isHostBlocked('https://www.londontheatredirect.com/news/oh-mary-review'), false);
  // southlondon.co.uk is ALSO deliberately NOT blocked — it's a registered
  // Tier 4 outlet ("south-london") with real reviews under /lifestyle/review-*;
  // its /area/ listing pages are a different section of the same site.
  assert.equal(isHostBlocked('https://southlondon.co.uk/area/southwark/dog-man-the-musical/'), false);
  assert.equal(isHostBlocked('https://southlondon.co.uk/lifestyle/review-cyrano-de-bergerac-at-noel-coward-theatre/'), false);
});

test('NAMED_NON_REVIEW_URL_PATTERNS: every entry has a host regex and a reason string', () => {
  for (const p of NAMED_NON_REVIEW_URL_PATTERNS) {
    assert.ok(p.host instanceof RegExp, `missing host regex: ${JSON.stringify(p)}`);
    assert.equal(typeof p.reason, 'string');
    assert.ok(p.reason.length > 0);
    if (p.path) assert.ok(p.path instanceof RegExp);
  }
});

// ── task #1073: classifyReviewUrl — THE canonical candidate gate ──────────────
const { classifyReviewUrl, hostOf, registrableHost } = require('./non-review-url-patterns.js');
const domainFilters = require('./domain-filters.js');
const { isRoundupUrl } = require('./review-guards.js');
const { isProfileUrl } = require('./review-normalization.js');

test('classifyReviewUrl: page-asset / CDN / ad-tech junk rejected (The Vessel class)', () => {
  const junk = [
    'https://dalyklerwhmui.cloudfront.net',
    'https://fonts.gstatic.com',
    'https://fonts.googleapis.com/css2',
    'https://securepubads.g.doubleclick.net/pagead/managed/dict/m202608040101/gpt',
    'https://maps.google.com/',
    'https://www.todaytixgroup.com/careers',
    'https://docs.google.com/forms/d/e/1FAIpQLSe/viewform',
  ];
  for (const u of junk) assert.equal(classifyReviewUrl(u).ok, false, u);
});

test('classifyReviewUrl: merch / ticketing / feature pages rejected (Disruption class)', () => {
  assert.equal(classifyReviewUrl('https://www.borninthecity.com/product/the-vessel/').ok, false);
  assert.equal(classifyReviewUrl('https://www.eventticketscenter.com/disruption-new-york-08-04-2026/8172166/t').ok, false);
  assert.equal(classifyReviewUrl('https://stagebuddy.com/theater/theater-feature/disruption-signature-theatre').ok, false);
});

test('classifyReviewUrl: stagebuddy REVIEW paths still pass (path-scoped, not host-blocked)', () => {
  assert.equal(classifyReviewUrl('https://stagebuddy.com/theater/reviews/disruption-review').ok, true);
});

test('classifyReviewUrl: news-announcement slugs rejected; "first-look" reviews still pass', () => {
  assert.equal(classifyReviewUrl('https://www.westwaleschronicle.co.uk/blog/2026/07/29/dog-man-the-musical-releases-production-photos-and-announces-new-tour-dates-for-2027/').ok, false);
  assert.equal(classifyReviewUrl('https://www.thereviewshub.com/initial-casting-announced-for-burlesque-uk-tour/').ok, false);
  assert.equal(classifyReviewUrl('https://monstagigz.com/2026/07/14/first-look-theatre-midnight-at-the-never-get-starring-ben-platt-at-the-menier-chocolate-factory/').ok, true);
  assert.equal(classifyReviewUrl('https://www.thereviewshub.com/burlesque-the-musical-savoy-theatre-london/').ok, true);
  assert.equal(classifyReviewUrl('https://openingnight.online/photos-becoming-hamlet-celebrates-opening-night-off-broadway/').ok, false);
  // BRO-5134: Midnight's census "gap" was a previews/photo-release news post.
  assert.equal(classifyReviewUrl('https://24-ore.com/en/todrick-halls-midnight-begins-off-broadway-previews-first-photos-released-after-one-week-delay/').ok, false);
  assert.equal(classifyReviewUrl('https://example.com/news/show-x-photos-are-released/').ok, false);
  assert.equal(classifyReviewUrl('https://frontmezzjunkies.com/2026/03/30/a-story-that-still-demands-to-be-heard-joe-turners-come-and-gone-begins-broadway-previews/').ok, true);
});

test('classifyReviewUrl: myreviewer home-video (DVD/Blu-ray) reviews rejected, other sections pass', () => {
  const dvd = classifyReviewUrl('https://www.myreviewer.com/DVD/129315/As-You-Like-It-Globe-Theatre/130503/Review-by-Alan-Titherington');
  assert.deepEqual(dvd, { ok: false, reason: 'home-video-review' });
  assert.equal(classifyReviewUrl('https://www.myreviewer.com/Blu-ray/1/x/2/Review').ok, false);
  assert.equal(classifyReviewUrl('https://www.myreviewer.com/Theatre/1/x/2/Review').ok, true);
  assert.deepEqual(classifyReviewUrl('https://www.thestage.co.uk/news/mamma-mia-to-return-to-broadway-after-10-years-away'), { ok: false, reason: 'news-article' });
  assert.equal(classifyReviewUrl('https://www.thestage.co.uk/reviews/night-city-southwark-playhouse-review').ok, true);
  for (const u of [
    'https://www.newyorktheatreguide.com/show/25619-la-traviata',
    'https://www.gigantic.com/deep-heat-rivalry-tickets',
    'https://www.concordtheatricals.com/p/99588/mrs-stern-wanders-the-prussian-state-library',
    'https://www.abouttheartists.com/productions/208936-pre-existing-condition-at-greenwich-house-theater-2026-2027',
    'https://www.traverse.co.uk/whats-on/mrs-stern-wanders-the-prussian-state-library',
    'https://www.artsatmarblearch.com/events/million-dollar-quartet',
  ]) assert.equal(classifyReviewUrl(u).ok, false, u);
  assert.equal(classifyReviewUrl('https://www.newyorktheatreguide.com/reviews/space-dogs-off-broadway-review').ok, true);
});

test('classifyReviewUrl: BWW hub + cast/shows pages rejected, BWW article reviews pass', () => {
  assert.equal(classifyReviewUrl('https://www.broadwayworld.com/reviews/disruption').ok, false);
  assert.equal(classifyReviewUrl('https://www.broadwayworld.com/reviews/the-vessel').ok, false);
  assert.equal(classifyReviewUrl('https://www.broadwayworld.com/shows/The-Vessel-336202/cast').ok, false);
  assert.equal(classifyReviewUrl('https://www.broadwayworld.com/off-broadway/article/Review-THE-PASS-at-La-MaMa-20260804').ok, true);
  // Bare /shows/Title-123.html hosts REAL scored reviews (Oliver!, Something
  // Rotten!, Titanique — QA ship-check 2026-08-06). The WRITE path
  // (isProfileUrl, used by gather-reviews at ingest) must NOT block it —
  // only sub-pages (/cast, /synopsis) are listing pages. The audit-side
  // classifier still rejects it via the PRE-EXISTING BWW internal-nav
  // heuristic (unchanged discovery behavior, carried from old isReviewUrl —
  // these reviews were ingested via aggregator citations, not SERP/audit).
  assert.equal(isProfileUrl('https://www.broadwayworld.com/shows/Oliver!-335212.html'), false);
  assert.equal(isProfileUrl('https://www.broadwayworld.com/shows/The-Vessel-336202/cast'), true);
  assert.equal(classifyReviewUrl('https://www.broadwayworld.com/shows/Oliver!-335212.html').reason, 'aggregator-internal-nav');
});

test('classifyReviewUrl: bare Playbill/BWW section roots rejected, real article paths pass (task #361)', () => {
  // Bare section roots match the keyword regex (news/theater/etc) but are
  // category-listing pages, not reviews — 2+ path segments required.
  assert.equal(classifyReviewUrl('https://www.playbill.com/news').reason, 'aggregator-section-root');
  assert.equal(classifyReviewUrl('https://www.playbill.com/news/').reason, 'aggregator-section-root');
  assert.equal(classifyReviewUrl('https://www.broadwayworld.com/theater').reason, 'aggregator-section-root');
  assert.equal(
    classifyReviewUrl('https://www.playbill.com/article/theater-review-paranormal-activity').ok,
    true,
  );
});

test('classifyReviewUrl: static assets + unparseable rejected, real outlet reviews pass', () => {
  assert.equal(classifyReviewUrl('https://maxcdn.bootstrapcdn.com/bootstrap.min.css').ok, false);
  assert.equal(classifyReviewUrl('not-a-url').ok, false);
  assert.equal(classifyReviewUrl('https://www.nytimes.com/2026/08/04/theater/disruption-review.html').ok, true);
  assert.equal(classifyReviewUrl('https://culturesauce.com/the-pass-off-broadway-review/').ok, true);
  assert.equal(classifyReviewUrl('https://www.theatermania.com/news/review-the-pass_1847996/').ok, true);
});

test('classifyReviewUrl: unknown-but-real outlets are NOT rejected (onboarding stays open)', () => {
  // Rejection is by URL/host SHAPE only, never by registry membership (Codex review).
  assert.equal(classifyReviewUrl('https://some-brand-new-theater-blog.com/2026/08/the-pass-review/').ok, true);
});

// ── W5.2 parity: audit-side classifier agrees with the write-path guards ─────
test('parity: every isRoundupUrl-true fixture is also classifyReviewUrl-rejected', () => {
  const roundups = [
    'https://www.broadwayworld.com/reviews/disruption',
    'https://www.broadwayworld.com/article/Review-Roundup-THE-PASS-Opens-at-La-MaMa-20260804',
    'https://playbill.com/article/what-are-the-reviews-for-disruption-off-broadway',
    'https://www.thestage.co.uk/review-round-ups/some-show',
    'https://www.whatsonstage.com/news/some-show-review-round-up_123/',
  ];
  for (const u of roundups) {
    assert.equal(isRoundupUrl(u).isRoundup, true, `fixture should be a roundup: ${u}`);
    assert.equal(classifyReviewUrl(u).ok, false, `classifier must reject roundup: ${u}`);
  }
});

test('parity: listing/profile URL shapes rejected by BOTH isProfileUrl and classifyReviewUrl', () => {
  const listings = [
    'https://www.broadwayworld.com/shows/The-Vessel-336202/cast',
    'https://www.theatermania.com/shows/new-york-city-theater/x_1832919/',
  ];
  for (const u of listings) {
    assert.equal(isProfileUrl(u), true, `write path must reject listing: ${u}`);
    assert.equal(classifyReviewUrl(u).ok, false, `audit path must reject listing: ${u}`);
  }
});

test('hostOf/registrableHost: canonical host normalization moved intact', () => {
  assert.equal(hostOf('https://theater.nytimes.com/x'), 'nytimes.com');
  assert.equal(hostOf('https://amp.theguardian.com/stage/x'), 'theguardian.com');
  assert.equal(hostOf('https://www.thestage.co.uk/x'), 'thestage.co.uk');
  assert.equal(registrableHost('somepub.substack.com'), 'somepub.substack.com');
});

// GENERALIZED DRIFT GUARD (2026-09-01). domain-filters.js gates the WRITE path;
// classifyReviewUrl() gates the DISCOVERY path (audit-show-review-gap.js,
// show-score-discover.js). A host blocked by one and not the other is a phantom
// gap: the census reports it as an uncovered review while the write path throws
// it away, and the harvester keeps re-fetching it.
//
// This is not hypothetical. BRO-2712 mirrored southbank.london and
// spincyclenyc.com by hand with a comment explaining why. The very next host
// added to that file (vocal.media) was NOT mirrored, and /code-review had to
// catch it. A per-host convention that relies on remembering fails on the next
// host; asserting the SETS agree fails the moment anyone forgets.
test('parity: every write-path blocked domain is also blocked on the discovery path', () => {
  // ALL SEVEN sets isBlockedReviewUrl ORs together, not just three. Covering
  // only VENUE/PR_FIRM/UGC is how vocaleyes.co.uk was added to a blocklist on
  // 2026-09-02 with no discovery-path mirror and no test failure: it went into
  // AGGREGATOR, which nothing here enumerated. A blocklist this test does not
  // walk is a blocklist that can silently manufacture phantom SERP gaps.
  const {
    SOCIAL_DOMAINS, TICKET_DOMAINS, AGGREGATOR_DOMAINS, REFERENCE_DOMAINS,
    VENUE_DOMAINS, PR_FIRM_DOMAINS, UGC_PLATFORM_DOMAINS,
    LOOKALIKE_CONTENT_FARM_DOMAINS, CENSUS_JUNK_DOMAINS,
  } = domainFilters;
  const sets = {
    SOCIAL_DOMAINS,
    TICKET_DOMAINS,
    AGGREGATOR_DOMAINS,
    REFERENCE_DOMAINS,
    VENUE_DOMAINS,
    PR_FIRM_DOMAINS,
    UGC_PLATFORM_DOMAINS,
    LOOKALIKE_CONTENT_FARM_DOMAINS,
    CENSUS_JUNK_DOMAINS,
  };
  // Pre-existing unmirrored hosts, frozen 2026-09-02 when this test was widened
  // from three sets to all seven. Every one predates the widening. They are
  // BASELINED rather than mirrored because adding these 18 hosts to the discovery
  // path is a real behaviour change to SERP census coverage, not a cleanup —
  // some may be deliberately census-visible — and that needs its own analysis
  // per host. Tracked for draining; the point of the baseline is that a NEW
  // blocklist entry with no mirror still fails, which is the bug this test
  // exists to catch. Only ever shrink this list.
  const KNOWN_UNMIRRORED = new Set([
    'SOCIAL_DOMAINS: youtu.be',
    'SOCIAL_DOMAINS: tumblr.com',
    'SOCIAL_DOMAINS: vimeo.com',
    'SOCIAL_DOMAINS: spotify.com',
    'SOCIAL_DOMAINS: music.amazon.com',
    'SOCIAL_DOMAINS: apple.com',
    'AGGREGATOR_DOMAINS: show-score.com',
    'AGGREGATOR_DOMAINS: showscore.com',
    'AGGREGATOR_DOMAINS: ibdb.com',
    'AGGREGATOR_DOMAINS: lovelondonloveculture.com',
    'AGGREGATOR_DOMAINS: westendtheatre.com',
    'AGGREGATOR_DOMAINS: broadwayacrossamerica.com',
    'AGGREGATOR_DOMAINS: broadway.org.uk',
    'AGGREGATOR_DOMAINS: londonsbroadwaybuzz.ca',
    'AGGREGATOR_DOMAINS: stagedoor.com',
    'AGGREGATOR_DOMAINS: theatreandartreviews.com',
    'REFERENCE_DOMAINS: amazon.com',
    'REFERENCE_DOMAINS: iloveny.com',
  ]);

  const missed = [];
  for (const [setName, set] of Object.entries(sets)) {
    for (const domain of set) {
      const key = `${setName}: ${domain}`;
      if (KNOWN_UNMIRRORED.has(key)) continue;
      const verdict = classifyReviewUrl(`https://${domain}/some/path`);
      if (verdict.ok !== false) missed.push(key);
    }
  }
  assert.deepEqual(
    missed,
    [],
    'these hosts are blocked on the write path but NOT by classifyReviewUrl, so a SERP '
      + 'census will report them as uncovered review gaps — mirror them into '
      + 'NAMED_NON_REVIEW_URL_PATTERNS',
  );
});

test('The Stage non-review sections are blocked for every source; /reviews/ and /long-reviews/ are not', () => {
  // 2026-09-26: /news/ and /opinion/ pages scored live from sidebar star ratings
  // (kiss-of-the-spider-woman-1993 80, mamma-mia-2001 60, proof-2026 60).
  const blocked = [
    'https://www.thestage.co.uk/news/production-news/kiss-of-the-spider-woman-to-be-revived-at-curve-in-leicester',
    'https://www.thestage.co.uk/opinion/people-powered-creativity-will-outlive-ai-and-this-theatre-design-is-proof-jane-wheeler',
    'https://www.thestage.co.uk/opinion/hamilton-at-victoria-palace-theatre-london--review-round-up',
    'https://www.thestage.co.uk/promoted-content/the-last-self-tape-explores-how-art-performance-and-loneliness-collide',
    'https://thestage.co.uk/review-round-ups/cats-at-regents-park-open-air-theatre-review-round-up',
  ];
  for (const u of blocked) assert.equal(domainFilters.isBlockedReviewUrl(u), true, u);
  assert.equal(domainFilters.isBlockedReviewUrl('https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london'), false);
  assert.equal(domainFilters.isBlockedReviewUrl('https://www.thestage.co.uk/long-reviews/stranger-things-the-first-shadow-review-phoenix-theatre-london'), false);
});

test("Hampstead Theatre's own box-office pages are venue pages, not reviews", () => {
  assert.equal(domainFilters.isBlockedReviewUrl('https://www.hampsteadtheatre.com/whats-on/2026/the-urmetazoan/'), true);
});

test('any /whats-on/ listing without "review" in the path is blocked; outlet reviews filed there are not', () => {
  for (const u of [
    'https://kilntheatre.com/whats-on/table-17/',
    'https://www.stratfordeast.com/whats-on/all-shows/here-there-are-blueberries',
    'https://www.skiddle.com/whats-on/London/Gillian-Lynne-Theatre/My-Neighbour-Totoro/42468204/',
    'https://www.afridiziak.com/whatson/anansi-the-spider-regents-park-open-air-theatre/',
    // "preview" is not "review"
    'https://www.londonmumsmagazine.com/whats-on/million-dollar-quartet-preview-your-cheat-sheet-for-a-night-of-rock-n-roll/',
  ]) assert.equal(domainFilters.isBlockedReviewUrl(u), true, u);
  for (const u of [
    'https://www.manchestereveningnews.co.uk/whats-on/theatre-news/review-mousetrap-opera-house-manchester-11534540',
    'https://www.londonmumsmagazine.com/whats-on/review-holy-fool-at-park-theatre-a-powerful-story-of-art-fear-and-resistance/',
    'https://www.afridiziak.com/reviews/darkling/',
  ]) assert.equal(domainFilters.isBlockedReviewUrl(u), false, u);
});

test('classifyReviewUrl: Playbill Verdict roundup slugs are roundup-page, real reviews pass (BRO-4272)', () => {
  const { classifyReviewUrl } = require('./non-review-url-patterns.js');
  const roundup = classifyReviewUrl('https://playbill.com/article/reviews-are-out-for-school-girls-or-the-african-mean-girls-play-on-broadway');
  assert.equal(roundup.ok, false);
  assert.equal(roundup.reason, 'roundup-page');
  for (const u of [
    'https://www.theguardian.com/stage/2026/sep/28/school-african-mean-girls-play-review',
    'https://culturesauce.com/school-girls-african-mean-girls-play-broadway-review/',
    'https://stageandcinema.com/2026/09/28/school-girls-broadway-review/',
  ]) assert.equal(classifyReviewUrl(u).ok, true, u);
});

test('BRO-4386: ticket-seller product pages are named non-reviews, blog posts are not', () => {
  const reason = 'ticket-seller-product-page';
  assert.equal(namedNonReviewReason('https://www.theatrebookings.com/play/the-standard-of-living'), reason);
  assert.equal(namedNonReviewReason('https://www.bestoftheatre.co.uk/the-standard-of-living'), reason);
  assert.equal(namedNonReviewReason('https://www.bestoftheatre.co.uk/the-standard-of-living/'), reason);
  assert.equal(namedNonReviewReason('https://www.bestoftheatre.co.uk/blog/post/review-roundup-x'), null);
  assert.equal(namedNonReviewReason('https://www.bestoftheatre.co.uk/blog'), null);
  assert.equal(namedNonReviewReason('https://www.theatrebookings.com/blog/some-review'), null);
});

test('BRO-4386: allSourcesOnly returns only allSources entries; rebuild predicate covers submit-review-form', () => {
  assert.equal(namedNonReviewReason('https://www.broadway.com/shows/x/', { allSourcesOnly: true }), null);
  assert.equal(namedNonReviewReason('https://www.theatrebookings.com/play/x', { allSourcesOnly: true }), 'ticket-seller-product-page');
  const { isNamedNonReviewUrlRecord } = require('./review-guards.js');
  const url = 'https://www.bestoftheatre.co.uk/the-standard-of-living';
  assert.ok(isNamedNonReviewUrlRecord({ url, source: 'submit-review-form' }));
  assert.ok(isNamedNonReviewUrlRecord({ url, source: 'serp-discovery' }));
  assert.ok(!isNamedNonReviewUrlRecord({ url, source: 'submit-review-form', namedNonReviewUrlManualClear: true }));
  assert.ok(!isNamedNonReviewUrlRecord({ url: 'https://www.broadway.com/shows/x/', source: 'submit-review-form' }));
  assert.ok(isNamedNonReviewUrlRecord({ url: 'https://www.broadway.com/shows/x/', source: 'serp-discovery' }));
  assert.ok(!isNamedNonReviewUrlRecord({ url: 'https://www.bestoftheatre.co.uk/blog/post/review-roundup-x', source: 'submit-review-form' }));
});

test('BRO-4386: allowNonReviewUrl human override survives rebuild predicate', () => {
  const { isNamedNonReviewUrlRecord } = require('./review-guards.js');
  assert.ok(!isNamedNonReviewUrlRecord({ url: 'https://www.bestoftheatre.co.uk/cats', source: 'submit-review-form', allowNonReviewUrl: true }));
});

test('BRO-4455: ticket resellers / listings / PR firm from the creation-stories census are not review candidates', () => {
  const { classifyReviewUrl } = require('./non-review-url-patterns.js');
  for (const url of [
    'https://omdkc.com/first-look-photos-released-of-lct3s-creation-stories/',
    'https://nyc-shows.brooklynvegan.com/events/2026/10/1/creation-stories-tickets',
    'https://www.topstartickets.com/Event/Creation-Stories-Tickets',
    'https://www.ticketsales.com/creation-stories-tickets/event/7225055',
    'http://www.viagogo.dk/Billets-de-theatre/Theatre-et-Cabaret/Creation-Stories-Billets/E-161464547',
    'https://www.tennesseetickets.com/Events/8095092/Creation-Stories-Tickets',
  ]) assert.equal(classifyReviewUrl(url).ok, false, url);
  assert.equal(classifyReviewUrl('https://www.vulture.com/article/yes-its-tough-to-be-a-playwright-creation-stories.html').ok, true);
});

test('BRO-4596: express.co.uk theatre section index is a listing page, real articles are not', () => {
  const { listingPageUrlReason } = require('./non-review-url-patterns.js');
  assert.equal(listingPageUrlReason('https://www.express.co.uk/entertainment/theatre'), 'section-index-page');
  assert.equal(listingPageUrlReason('https://www.express.co.uk/entertainment/theatre/'), 'section-index-page');
  assert.equal(listingPageUrlReason('https://www.express.co.uk/latest/theatre'), 'section-index-page');
  assert.equal(listingPageUrlReason('https://www.express.co.uk/latest/theatre/?ref=search'), 'section-index-page');
  assert.equal(listingPageUrlReason('https://www.express.co.uk/entertainment/theatre/1845793/stephen-daldry-stranger-things-theatrical-prequel-dazzling-show'), null);
  assert.equal(listingPageUrlReason('https://example.com/latest/theatre'), null);
  assert.equal(listingPageUrlReason('https://www.express.co.uk/entertainment/theatre/1769203/Operation-Mincemeat-musical-review-London-2023-Fortune-theatre-dates-tickets'), null);
  assert.equal(listingPageUrlReason('https://www.express.co.uk/entertainment/films'), null);
});

test('Theater Scene tag archives are not reviews; its review urls and other hosts\' /tag/ urls are (BRO-5097)', async () => {
  const { classifyReviewUrl } = (await import('node:module')).createRequire(import.meta.url)('./non-review-url-patterns.js');
  assert.deepEqual(classifyReviewUrl('https://www.theaterscene.net/tag/burning-leaves/'), { ok: false, reason: 'tag-index-page' });
  assert.equal(classifyReviewUrl('https://www.theaterscene.net/plays/offbway-plays/burning-leaves/tony-marinelli/').ok, true);
  assert.equal(classifyReviewUrl('https://twi-ny.com/tag/an-american-daughter/').ok, true);
});

test('theatre.reviews roundups and London Theatre Direct product pages are not reviews; LTD /news/ is (BRO-5169)', async () => {
  const { classifyReviewUrl, classifyGapCandidateUrl } = (await import('node:module')).createRequire(import.meta.url)('./non-review-url-patterns.js');
  assert.deepEqual(classifyGapCandidateUrl('https://theatre.reviews/reviews-roundup/standard-of-living-reviews/'), { ok: false, reason: 'aggregator-roundup' });
  for (const u of [
    'https://www.londontheatredirect.com/play/the-standard-of-living-tickets?srsltid=abc',
    'https://www.londontheatredirect.com/de/play/buffy-revamped-tickets',
    'https://www.londontheatredirect.com/musical/kimberly-akimbo-tickets',
    'https://www.londontheatredirect.com/booking/paranormal-activity-tickets/11-2026/797027',
  ]) assert.deepEqual(classifyReviewUrl(u), { ok: false, reason: 'ticket-seller-product-page' }, u);
  assert.equal(classifyReviewUrl('https://www.londontheatredirect.com/news/the-standard-of-living-review').ok, true);
  assert.equal(classifyReviewUrl('https://www.londontheatredirect.com/de/news/x-review').ok, true);
});

test('gap census rejects the ticket page and Page Six gossip that alerted for Midnight (BRO-5134)', () => {
  const { classifyGapCandidateUrl } = require('./non-review-url-patterns.js');
  assert.equal(classifyGapCandidateUrl('https://www.broadway-show-tickets.com/musicals/midnight-tickets/').ok, false);
  assert.equal(classifyGapCandidateUrl('https://pagesix.com/2026/10/14/celebrity-news/scooter-braun-and-todrick-hall-join-forces-to-produce-star-studded-off-broadway-musical-midnight-to-rave-reviews/').ok, false);
  // Other Page Six paths are not blanket-rejected.
  assert.equal(classifyGapCandidateUrl('https://pagesix.com/2026/10/14/entertainment/theater/some-show-review/').ok, true);
});

test('BRO-5617: NY Post producer news is excluded without blocking critic reviews', () => {
  const news = 'https://nypost.com/2026/10/14/scooter-braun-and-todrick-hall-join-forces-to-produce-star-studded-off-broadway-musical-midnight-to-rave-reviews/';
  assert.equal(namedNonReviewReason(news), 'producer-news');
  assert.equal(classifyGapCandidateUrl(news).ok, false);
  assert.equal(namedNonReviewReason('https://www.nypost.com/2026/10/21/other-producers-join-forces-to-produce-a-new-musical-to-rave-reviews/'), 'producer-news');
  for (const url of [
    'https://nypost.com/2024/07/11/entertainment/oh-mary-review-get-to-the-funniest-show-on-broadway/',
    'http://nypost.com/2015/08/06/hamilton-isnt-quite-revolutionary/',
    'http://nypost.com/2003/10/31/broom-shtick-wicked-witches-most-entrancing/',
    'https://nypost.com/2026/10/14/midnight-review-a-rave-for-the-musical/',
    'https://example.com/2026/10/14/artists-join-forces-to-produce-a-review/',
  ]) assert.equal(namedNonReviewReason(url), null, url);
});

test('BRO-3719: variety.com/shop/ ticket guide is a non-review, variety reviews are not', () => {
  assert.equal(namedNonReviewReason('https://variety.com/shop/broadway-show-tickets-where-to-buy-1234970196/'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://variety.com/2026/legit/reviews/some-show-review-1234567890/'), null);
});

test('BRO-5349: ticket/event pages cited for Jena Friedman: Motherfucker are not review candidates', () => {
  for (const u of [
    'https://www.captainticket.com/NY/New-York-Events/Cheap-Jena-Friedman-Motherfucker-Tickets-Soho-Playhouse-Main-Theatre-2026-10-03-19-00-00-3501097',
    'https://thecomedybureau.com/show/jena-friedman-motherfucker-in-nyc/2026-10-11/',
    'http://www.oklahomatickets.com/Events/Comedy-Tickets/Jena-Friedman-Motherfucker-2026-10-11-19-00-00-3501105',
    'https://www.ticketsmarter.com/e/jena-friedman-motherfucker-tickets-new-york-10-2-2026-soho-playhouse-main-theatre/3501096',
    'https://www.axs.com/events/1630006/jena-friedman-motherfucker-tickets',
  ]) {
    assert.equal(namedNonReviewReason(u), 'ticketing-reseller', u);
    assert.equal(classifyGapCandidateUrl(u).ok, false, u);
  }
});

test('BRO-5349: axs.com is excluded only on /events/ (it also hosted /theatre-review-* pages); lookalike hosts untouched', () => {
  assert.equal(namedNonReviewReason('https://www.axs.com/theatre-review-sweat-at-arena-stage-75388'), null);
  assert.equal(namedNonReviewReason('https://www.maxs.com/events/1'), null);
  for (const u of ['https://www.ticketx.com/x', 'https://www.viptickets.com/x', 'https://www.ticketwarehouse.com/x']) {
    assert.equal(namedNonReviewReason(u), 'ticketing-reseller', u);
  }
});

test('BRO-5377: axs.com locale-prefixed /uk/events/ ticket pages are ticketing-reseller; review pages still pass', () => {
  assert.equal(namedNonReviewReason('https://www.axs.com/uk/events/1629908/jena-friedman-motherfucker-tickets'), 'ticketing-reseller');
  assert.equal(classifyGapCandidateUrl('https://www.axs.com/uk/events/1629908/jena-friedman-motherfucker-tickets').ok, false);
  assert.equal(namedNonReviewReason('https://www.axs.com/uk/theatre-review-sweat-75388'), null);
  assert.equal(namedNonReviewReason('https://www.axs.com/theatre-review-sweat-at-arena-stage-75388'), null);
});

const { ingestRefusalReason, submissionNonReviewReason } = require('./non-review-url-patterns.js');

test('BRO-5132: festies.co.uk Fringe fan-review pages are UGC, not review-gap candidates', () => {
  for (const u of [
    'https://festies.co.uk/@TrashP/events/2026/elf-lyons-is-the-woman-on-the-edge',
    'https://festies.co.uk/@em_dashes/events/2026/elf-lyons-is-the-woman-on-the-edge',
  ]) {
    assert.equal(namedNonReviewReason(u), 'ugc-platform', u);
    assert.equal(classifyGapCandidateUrl(u).ok, false, u);
    assert.equal(ingestRefusalReason(u), 'ugc-platform', u);
    assert.equal(submissionNonReviewReason(u), 'ugc-platform', u);
  }
  // The named-critic exemption stays vocal.media's alone.
  assert.equal(submissionNonReviewReason('https://vocal.media/critique/some-show-review'), null);
  assert.equal(submissionNonReviewReason('https://www.trustpilot.com/review/example.com'), 'ugc-platform');
});

test('BRO-5355: viagogo (any TLD) and me-ticket event pages are not review candidates', () => {
  for (const u of [
    'https://www.viagogo.pl/Theatre-Tickets/Theatre/Anon-A-Tempest-At-Our-Kitchen-Table-Tickets/E-162101583',
    'https://www.viagogo.co.uk/Theatre-Tickets/x/E-1',
    'https://me-ticket.com/ko/event/view/anon-a-tempest-at-our-kitchen-table-13',
    'https://me-ticket.com/ms/event/view/anon-a-tempest-at-our-kitchen-table-11',
  ]) {
    assert.equal(classifyGapCandidateUrl(u).ok, false, u);
  }
  assert.equal(classifyGapCandidateUrl('https://www.vulture.com/article/anon-review.html').ok, true);
});

test('BRO-5377: theatermap.nyc /shows/ listing pages are event-listing; other paths and lookalikes untouched', () => {
  assert.equal(namedNonReviewReason('https://www.theatermap.nyc/shows/jena-friedman'), 'event-listing');
  assert.equal(classifyGapCandidateUrl('https://theatermap.nyc/shows/jena-friedman').ok, false);
  assert.equal(namedNonReviewReason('https://www.theatermap.nyc/reviews/some-show'), null);
  assert.equal(namedNonReviewReason('https://www.nottheatermap.nyc/shows/x'), null);
});

test('namedNonReviewReason: cbsnews.com /video/ segment pages are named (BRO-5863), articles are not', () => {
  assert.equal(namedNonReviewReason('https://www.cbsnews.com/video/other-desert-cities-on-broadway-family-secrets-laid-bare/'), 'video-segment');
  assert.equal(namedNonReviewReason('https://www.cbsnews.com/news/some-show-review/'), null);
  assert.equal(namedNonReviewReason('https://www.cbsnews.com/newyork/video/some-segment/'), 'video-segment');
  assert.equal(namedNonReviewReason('https://www.cbsnews.com/newyork/news/some-show-review/'), null);
  assert.equal(namedNonReviewReason('https://notcbsnews.com/video/x'), null);
});

test('namedNonReviewReason: cast-album reviews are not production reviews (BRO-6580)', () => {
  for (const u of [
    'https://www.npr.org/2015/09/21/440925873/first-listen-cast-recording-hamilton',
    'https://www.billboard.com/music/music-news/hamilton-original-broadway-cast-recording-album-review-6715240/',
    'https://www.vulture.com/2019/09/the-moulin-rouge-broadway-cast-album-is-surprisingly-good.html',
    'https://musicaltheatrereview.com/music-review-the-little-big-things-original-west-end-cast-recording/',
    'https://playbill.com/article/on-the-record-the-light-in-the-piazza-and-little-women-com-126426',
  ]) assert.equal(namedNonReviewReason(u), 'cast-album-review', u);
  // The same hosts' stage reviews stay reviews.
  assert.equal(namedNonReviewReason('https://www.vulture.com/2019/07/moulin-rouge-broadway-review.html'), null);
  assert.equal(namedNonReviewReason('https://musicaltheatrereview.com/review-hamilton-victoria-palace/'), null);
  assert.equal(namedNonReviewReason('https://www.npr.org/2015/08/06/hamilton-broadway-review'), null);
});

test('namedNonReviewReason: Musical Theatre Review cd-review slugs are album reviews (BRO-6580)', () => {
  assert.equal(namedNonReviewReason('https://musicaltheatrereview.com/cd-review-the-prince-of-egypt-original-london-cast/'), 'cast-album-review');
});

// BRO-6588: pre-opening news/feature pages on review outlets (A Few Good Men
// press night saved ~12 of them as reviews) are refused at discovery.
const { preOpeningNonReviewReason, listingPageUrlReason } = require('./non-review-url-patterns.js');
const AFGM = { id: 'a-few-good-men-2026', openingDate: '2026-10-29', category: 'broadway' };

test('BRO-6588: EW first-look dated 2026-10-08 for a show opening 2026-10-29 is rejected', () => {
  const url = 'https://ew.com/a-few-good-men-broadway-first-look-photos-11823456';
  assert.equal(preOpeningNonReviewReason(url, { publishDate: '2026-10-08', outletId: 'ew', show: AFGM }), 'pre-opening-non-review');
  assert.equal(preOpeningNonReviewReason(url, { publishDate: '2026-10-08T14:00:00Z', outletId: 'ew', show: AFGM }), 'pre-opening-non-review', 'ISO datetime');
  assert.equal(preOpeningNonReviewReason('https://www.nytimes.com/2026/10/20/theater/a-few-good-men-broadway.html',
    { publishDate: '2026-10-20', outletId: 'nytimes', show: AFGM }), 'pre-opening-non-review');
});

test('BRO-6588: letterboxd /reviews/page/5/ is a review hub', () => {
  assert.equal(listingPageUrlReason('https://letterboxd.com/film/a-few-good-men/reviews/page/5/'), 'review-hub-page');
  assert.equal(listingPageUrlReason('https://letterboxd.com/film/a-few-good-men/reviews/'), 'review-hub-page');
});

test('BRO-6588: real opening-night and early-but-legit reviews are accepted', () => {
  const ctx = (publishDate, extra = {}) => ({ publishDate, outletId: 'nytimes', show: AFGM, ...extra });
  assert.equal(preOpeningNonReviewReason('https://www.nytimes.com/2026/10/29/theater/a-few-good-men-review.html', ctx('2026-10-29')), null);
  assert.equal(preOpeningNonReviewReason('https://www.nytimes.com/2026/10/30/theater/a-few-good-men-broadway.html', ctx('2026-10-30')), null, 'slugless but on/after opening');
  assert.equal(preOpeningNonReviewReason('https://www.vulture.com/article/a-few-good-men-broadway-critic.html', ctx('2026-10-08')), null, 'critic slug');
  assert.equal(preOpeningNonReviewReason('https://pagesonstages.com/a-few-good-men-broadway', ctx('2026-10-08')), null, 'host not listed');
  assert.equal(preOpeningNonReviewReason('https://ew.com/a-few-good-men-broadway-11823456', ctx('2026-10-08', { dateSource: 'text-regex' })), null, 'body date never refuses');
  assert.equal(preOpeningNonReviewReason('https://ew.com/a-few-good-men-broadway-11823456', ctx('2026-10-08', { allowEarlyDate: true })), null, 'override');
  assert.equal(preOpeningNonReviewReason('https://ew.com/a-few-good-men-broadway-11823456', ctx(null)), null, 'no date');
  const offB = { id: 'x', openingDate: '2026-10-29', category: 'off-broadway' };
  assert.equal(preOpeningNonReviewReason('https://www.nytimes.com/2026/10/24/theater/x.html', { publishDate: '2026-10-24', outletId: 'nytimes', show: offB }), null, 'off-Broadway grace');
  const prior = { ...AFGM, priorRuns: [{ openingDate: '2026-09-01', closingDate: '2026-09-30' }] };
  assert.equal(preOpeningNonReviewReason('https://www.nytimes.com/2026/09/15/theater/x.html', { publishDate: '2026-09-15', outletId: 'nytimes', show: prior }), null, 'prior run');
});

test('listingPageUrlReason: Talkin\' Broadway index page is a listing, a numbered review page is not (BRO-6584)', () => {
  const { listingPageUrlReason } = require('./non-review-url-patterns.js');
  assert.equal(listingPageUrlReason('https://www.talkinbroadway.com/page/world/index.html'), 'review-index-page');
  assert.equal(listingPageUrlReason('https://www.talkinbroadway.com/page/world/860.html'), null);
});
