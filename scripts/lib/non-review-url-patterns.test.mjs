// non-review-url-patterns.js — canonical not-a-review host/path patterns
// shared between audit-show-review-gap.js's isReviewUrl() and the S5
// adversarial probe's classifyNonReviewUrl() (task #907 ship-check finding:
// extracted so the two callers can't drift apart).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { namedNonReviewReason, NAMED_NON_REVIEW_URL_PATTERNS, NON_REVIEW_HOST_PATTERNS, ALLOWED_ORG_HOSTS } = require('./non-review-url-patterns.js');

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
