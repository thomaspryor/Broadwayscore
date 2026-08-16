import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { discoverLboRoundupHtml } = require('./lbo-roundup-discover.js');
const { extractReviewsFromLBO } = require('../scrape-london-box-office-roundups.js');

// Real (trimmed) HTML pulled from the two live archived pages that motivated
// #1708 — data/aggregator-archive/lbo-roundups/{death-note-the-musical,
// how-the-other-half-loves}-west-end-2026.html, captured 2026-08-16. These
// are LBO's own single-critic review pages (JSON-LD author + .pctnt/.pmain
// paragraph wrappers + "bstarsN" CSS class + "100% Honest Reviews"
// disclaimer) — a different template than the multi-outlet "<h4>Outlet</h4>"
// roundup template extractReviewsFromLBO was written for. The old code
// returned 0 rows for this template (the "parser drift" false positive);
// audit-show-review-gap.js/gap-reference-sources.js flagged it as an
// empty-parse failure even though the page has one citable review.
const INDIVIDUAL_REVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Review: HOW THE OTHER HALF LOVES at the Duke of York's Theatre - West End Theatre News and Reviews</title>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "NewsArticle",
  "headline": "Review: HOW THE OTHER HALF LOVES at the Duke of York's Theatre",
  "author": {"@type": "Person", "name": "Andrew Bewley", "url": "https://www.londonboxoffice.co.uk/news/author/abewley"}
}
</script>
</head>
<body>
<div class="pctnt">
  <h1 class="pttl">Review: HOW THE OTHER HALF LOVES at the Duke of York's Theatre</h1>
  <div class="pdtls">
    <span><a href="https://www.londonboxoffice.co.uk/news/author/abewley" rel="author">Andrew Bewley</a>
    <span>19 July, 2016, 12:57</span></span>
    <span class="bstars"><span class="bstars3"></span></span>
  </div>
  <p>It’s the 60s. Alan Ayckbourn’s comedy presents three couples: Frank and Teresa Foster (old, stuffy and, in Frank’s words, married “because it’s better than nothing”), Bob and Theresa Phillips (burdened with a child, and burdened by each other for most of the play, before passionately resolving their differences in the bedroom) and William and Mary Featherstone.</p>
  <div class="pmain">
    <p>Anyway, the plot: Bob and Fiona are having an affair. Their spouses Teresa and Frank don’t know about Bob and Fiona’s affair. William and Mary aren’t having an affair with anybody, but Frank thinks Mary is having an affair with Bob, not his wife Fiona… And we’re off.</p>
    <p>How the Other Half Loves is a brilliant piece of writing and there is so much good work in this production, but ultimately the performances don’t always match the script's potential and therefore there are too many occasions where the piece slows down to almost a halt.</p>
  </div>
</div>
<p><strong>100% Honest Reviews.</strong> All show reviews are written by independent theatregoers, directors, or actors. All views expressed in these articles are those of the authors and do not necessarily represent the views of London Box Office.</p>
<p>Not every review published by London Box Office includes a star rating. Where no rating is shown, our reviewer has chosen to share their thoughts and observations without assigning a numerical score.</p>
<h4>Categories</h4>
<h4>Connect with us</h4>
</body></html>`;

// Real (trimmed) two-outlet slice of a genuine LBO multi-outlet roundup page
// (data/aggregator-archive/lbo-roundups/im-sorry-prime-minister-west-end-2026.html)
// — regression guard: the individual-page fallback must NOT fire when the
// page actually has <h4>Outlet</h4> markers.
const GENUINE_ROUNDUP_HTML = `<!DOCTYPE html>
<html lang="en"><head><title>Review Round-Up: I'M SORRY PRIME MINISTER, I CAN'T QUITE REMEMBER</title></head>
<body>
<h4>The Telegraph</h4>
<p><strong>“Yes Minister returns to tackle dementia, trigger warnings and the woke brigade”</strong></p>
<h4>★★★★</h4>
<p><strong>Reviewer: Dominic Cavendish</strong></p>
<p>“No performers could match the hallowed memory of Paul Eddington and Nigel Hawthorne in the leads (a photo of them gets its own round of applause at the curtain-call). Still, there is something winning about Rhys Jones’s portrayal, which sees him hobbling madly about, boggling for Britain in exasperation, and constantly chortling in a cajoling attempt to laugh off serious situations and dismiss criticism.”</p>
<p><a href="https://www.telegraph.co.uk/theatre/what-to-see/im-sorry-prime-minister-review-west-end/">Read the review here.</a></p>
<h4>TimeOut</h4>
<p><strong>“Griff Rhys Jones stars in the disarmingly elegiac final chapter of the ‘Yes, Minister’ saga”</strong></p>
<h4>★★★</h4>
<p><strong>Reviewer: Tom Wicker</strong></p>
<p>“A blustering Rhys Jones is amusing as Hacker, playing up his Churchillian delusions of self-importance while surrounded by boxes of his unsold memoirs. But Humphrey is the truly compelling character here – a creature of the civil service who is finally speaking his mind now inscrutability is no longer relevant.”</p>
<p><a href="https://www.timeout.com/london/theatre/im-sorry-prime-minister-review">Read the review here.</a></p>
</body></html>`;

function makeDataDir(showId, url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbo-discover-test-'));
  fs.writeFileSync(path.join(dir, 'lbo-roundup-urls.json'), JSON.stringify({ shows: { [showId]: url } }));
  return dir;
}

test('individual-review-template page (#1708 fixture) parses 1 row instead of 0', async () => {
  const showId = 'how-the-other-half-loves-west-end-2026';
  const url = 'https://www.londonboxoffice.co.uk/news/post/how-the-other-half-loves-the-old-vic-review';
  const dataDir = makeDataDir(showId, url);
  const fetchPage = async () => ({ content: INDIVIDUAL_REVIEW_HTML });

  const discovered = await discoverLboRoundupHtml(
    { id: showId, title: 'How the Other Half Loves' },
    { dataDir, fetchPage, log: () => {} },
  );
  assert.ok(discovered, 'discovery returned a page (title validation passed)');

  const rows = extractReviewsFromLBO(discovered.html, showId);
  assert.equal(rows.length, 1, 'parser recovers the single LBO review instead of 0 rows');
  assert.equal(rows[0].outlet, 'London Box Office');
  assert.equal(rows[0].critic, 'Andrew Bewley');
  assert.equal(rows[0].stars, 3);
  assert.equal(rows[0].isIndividual, true);
  assert.ok(rows[0].excerpt.length > 30, 'excerpt is populated from .pctnt/.pmain paragraphs, not empty');
});

test('genuine multi-outlet roundup still parses via the <h4>Outlet</h4> path (no regression)', () => {
  const showId = 'im-sorry-prime-minister-west-end-2026';
  const rows = extractReviewsFromLBO(GENUINE_ROUNDUP_HTML, showId);
  assert.equal(rows.length, 2, 'both outlets extracted');
  const outlets = rows.map((r) => r.outlet);
  assert.ok(outlets.includes('The Telegraph'));
  assert.ok(outlets.includes('TimeOut'));
  const telegraph = rows.find((r) => r.outlet === 'The Telegraph');
  assert.equal(telegraph.stars, 4);
  assert.equal(telegraph.critic, 'Dominic Cavendish');
  assert.ok(!rows.some((r) => r.isIndividual), 'genuine roundup rows are not flagged isIndividual');
});

test('live archive fixtures for the two #1708 shows, if present locally, parse non-zero', () => {
  // Mirrors scripts/test-bww-roundup-parser.js's real-archive-fixture pattern:
  // data/aggregator-archive/ is gitignored (private data), so this check is a
  // no-op in CI and only exercises real data on a machine that has it synced.
  const dir = '/Users/tompryor/Broadwayscore/data/aggregator-archive/lbo-roundups';
  for (const showId of ['death-note-the-musical-west-end-2026', 'how-the-other-half-loves-west-end-2026']) {
    const archivePath = path.join(dir, `${showId}.html`);
    if (!fs.existsSync(archivePath)) {
      console.log(`  ⚠ skip — fixture not found at ${archivePath}`);
      continue;
    }
    const html = fs.readFileSync(archivePath, 'utf8');
    const rows = extractReviewsFromLBO(html, showId);
    assert.ok(rows.length > 0, `${showId}: live archive parses > 0 rows (was 0 pre-fix)`);
  }
});
