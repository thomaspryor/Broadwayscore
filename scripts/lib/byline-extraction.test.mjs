/**
 * Basquiat 2026-09-16: TheaterMania's "In Honor of Jean-Michel Basquiat" review
 * landed as criticName "Unknown" (displayed as "TheaterMania Staff") because
 * ingest-review-from-url.js's byline regex only matched an author-name element
 * with the name as direct text — TheaterMania nests the name inside a child
 * <a id="article-author-tag">. Verified against the live page (Kenji Fujishima)
 * with a plain curl (bot-challenge only hit automated scraper IPs).
 *
 * Follow-up (same day, adversarial review of the fix): an unscoped version of
 * the new nested-<a> candidate matched the first nested anchor inside ANY
 * author-name-classed ancestor, anywhere in the page — a "Share"/related-
 * article link sitting inside such a wrapper could win over a real .byline or
 * rel="author" match found earlier in the HTML, because the candidate ran
 * before those checks. Fixed by (a) moving the candidate to run last and
 * (b) requiring the nested <a> itself to carry rel="author" or an id/class
 * containing "author" before it's trusted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractByline, extractJsonLdAuthor } from './byline-extraction.js';
import { extractAuthorFromHtml } from './content-quality.js';

for (const handle of ['Sam - Admin', 'Lily - Admin', 'Ri-admin', 'VivantAdmin', 'LALadmin', 'ARH Admin', 'OperaWireAdmin2', 'Admin', 'Editor', 'Staff', 'Webmaster']) {
  test(`ingest rejects CMS author ${handle} in metadata and author links`, () => {
    const jsonLd = `<script type="application/ld+json">${JSON.stringify({ author: { '@type': 'Person', name: handle } })}</script>`;
    assert.equal(extractJsonLdAuthor(jsonLd), null);
    for (const markup of [jsonLd, `<meta name="author" content="${handle}">`, `<meta property="article:author" content="${handle}">`, `<a rel="author">${handle}</a>`, `<span class="author-name">${handle}</span>`]) {
      assert.equal(extractByline(markup), null, markup);
      assert.equal(extractByline(`${markup}<span class="byline">By Michael Buzzelli</span>`), 'Michael Buzzelli');
    }
  });
}

test('ingest falls back to the printed Plays International header after rejecting its account', () => {
  const text = '“Electra/Persona” at the Lyttelton, National Theatre Neil Dowden on the South Bank ★★★☆☆ 4 September 2026';
  const html = '<meta name="author" content="Ri-admin">';
  assert.equal(extractByline(html, { outletId: 'plays-international', text }), 'Neil Dowden');
  assert.equal(extractByline(html, { outletId: 'another-outlet', text }), null);
  assert.equal(extractByline(html, { outletId: 'plays-international', text: 'No printed byline.' }), null);
  assert.equal(extractByline(html, { outletId: 'plays-international', text: 'Jan van der Berg in North London ★★★☆☆ 4 September 2026' }), null);
  assert.equal(extractByline('<meta name="author" content="Jane Critic">', { outletId: 'plays-international', text }), 'Jane Critic');
});

test('ingest accepts the lowercase printed byline under the Burgh Vivant account', () => {
  assert.equal(extractByline('<meta name="author" content="VivantAdmin"><p>by Michael Buzzelli</p>'), 'Michael Buzzelli');
  assert.equal(extractByline('<p>by the company</p>'), null);
});

test('extracts a byline nested inside an <a id="article-author-tag"> (TheaterMania live-page shape)', () => {
  const html = `<p class="author-name mb-0 me-2 text-decoration-none text-blue"><a id="article-author-tag" class="text-decoration-none text-blue" href="https://www.theatermania.com/authors/kenji-fujishima">Kenji Fujishima</a></p>`;
  assert.equal(extractByline(html), 'Kenji Fujishima');
});

test('extracts a byline nested in an <a rel="author"> inside class="author-name"', () => {
  const html = `<div class="author-name"><a rel="author" href="/authors/jane">Jane Critic</a></div>`;
  assert.equal(extractByline(html), 'Jane Critic');
});

test('still extracts a byline that is direct text inside class="author-name" (pre-existing shape)', () => {
  const html = `<span class="author-name">Jane Critic</span>`;
  assert.equal(extractByline(html), 'Jane Critic');
});

test('meta[name=author] still wins when present (checked before author-name)', () => {
  const html = `<meta name="author" content="Meta Name"><span class="author-name"><a rel="author">Nested Name</a></span>`;
  assert.equal(extractByline(html), 'Meta Name');
});

test('a real .byline wins over an unrelated nested anchor inside an author-name wrapper', () => {
  // Regression for the adversarial-review finding: a "Share" link (no author
  // hint) sitting inside class="author-name" must not outrank a real byline
  // that appears earlier in the page order but later in candidate priority.
  const html = `<span class="byline">By Real Critic</span><div class="author-name"><a href="/share">Share</a></div>`;
  assert.equal(extractByline(html), 'Real Critic');
});

test('a nested anchor with no author hint (no rel=author, no author id/class) is not trusted', () => {
  const html = `<div class="author-name"><a href="/tag/related">Related Article</a></div>`;
  assert.equal(extractByline(html), null);
});

test('returns null with no matching markup', () => {
  assert.equal(extractByline('<p>no byline here</p>'), null);
});

test('returns null for empty/falsy input', () => {
  assert.equal(extractByline(''), null);
  assert.equal(extractByline(null), null);
});

test('an explicit "Reviewer: Name" line beats a house-account meta author (The Reviews Hub, BRO-4431)', () => {
  const html = '<meta name="author" content="The Reviews Hub - London" /><h1 class="post-title">Cleansed – Almeida Theatre, London</h1><div class="sub-title">Reviewer: Scott Matthewman</div><a href="/author/trh_london/" rel="author">The Reviews Hub - London</a>';
  assert.equal(extractByline(html), 'Scott Matthewman');
  assert.equal(extractAuthorFromHtml(html, '', { url: 'https://www.thereviewshub.com/cleansed-almeida-theatre-london/' }), 'Scott Matthewman');
  // Placeholder or initial-only reviewer lines fall through to the meta author.
  assert.equal(extractByline('<meta name="author" content="Jane Doe" /><div>Reviewer: Anonymous Guest</div>'), 'Jane Doe');
  assert.equal(extractByline('<meta name="author" content="Jane Doe" /><li>Reviewer: John D</li>'), 'Jane Doe');
  // House names on a Reviewer line are not people.
  for (const house of ['The Reviews Hub', 'Our Critic', 'Press Night']) {
    assert.equal(extractByline(`<meta name="author" content="Jane Doe" /><div>Reviewer: ${house}</div>`), 'Jane Doe', house);
  }
  assert.equal(extractByline('<div>Reviewer:&nbsp;Jo Smith</div>'), 'Jo Smith');
  // No Reviewer line: the meta author still wins as before.
  assert.equal(extractByline('<meta name="author" content="Jane Doe" />'), 'Jane Doe');
});

// BRO-4475: BWW author page URL was stored as criticName.
test('never returns an author-page URL from meta author; falls through to the real name', () => {
  const html = `<meta name="author" content="https://www.broadwayworld.com/author/Alexander-Cohen"><span class="author-name">Alexander Cohen</span>`;
  assert.equal(extractByline(html), 'Alexander Cohen');
});

test('URL-only byline candidates yield null, not the href', () => {
  const html = `<a rel="author" href="/author/x">https://www.broadwayworld.com/author/Alexander-Cohen</a>`;
  assert.equal(extractByline(html), null);
});

test('JSON-LD author name is preferred over a URL meta author', () => {
  const html = `<script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Alexander Cohen","url":"https://www.broadwayworld.com/author/Alexander-Cohen"}}</script><meta name="author" content="https://www.broadwayworld.com/author/Alexander-Cohen">`;
  assert.equal(extractByline(html), 'Alexander Cohen');
});

test('JSON-LD author given as a URL string is ignored', () => {
  const html = `<script type="application/ld+json">{"author":"https://www.broadwayworld.com/author/Alexander-Cohen"}</script><span class="author-name">Jane Critic</span>`;
  assert.equal(extractByline(html), 'Jane Critic');
});

test('JSON-LD Organization / house-name / domain authors are ignored; meta byline wins', () => {
  for (const author of ['{"@type":"Organization","name":"BroadwayWorld.com"}', '{"@type":"Person","name":"BroadwayWorld.com"}', '{"@type":"Person","name":"BWW Staff"}']) {
    const html = `<script type="application/ld+json">{"author":${author}}</script><meta name="author" content="Real Critic">`;
    assert.equal(extractByline(html), 'Real Critic');
  }
});

test('JSON-LD author array: first valid Person in document order', () => {
  const html = `<script type="application/ld+json">{"author":[{"@type":"Person","name":"Jane Smith"},{"@type":"Person","name":"John Doe"}]}</script>`;
  assert.equal(extractByline(html), 'Jane Smith');
});

// BRO-5065: excludeNames (the show's cast + creative team) must veto a
// meta/JSON-LD author too, not only the text-byline fallback. A Theatricalia
// page's author meta is the playwright.
test('BRO-5065: an excluded creative name from author meta or JSON-LD is not returned', () => {
  const meta = '<html><head><meta name="author" content="Ayn Rand"></head><body>x</body></html>';
  const ld = '<html><head><script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"Ayn Rand"}}</script></head><body>x</body></html>';
  const opts = { url: 'https://theatricalia.com/play/39r/night-of-january-16th/production/1b3b', excludeNames: ['Ayn Rand'] };
  assert.equal(extractAuthorFromHtml(meta, 'x', { url: opts.url }), 'Ayn Rand', 'control: extracted without the exclusion');
  assert.equal(extractAuthorFromHtml(meta, 'x', opts), null);
  assert.equal(extractAuthorFromHtml(ld, 'x', opts), null);
  assert.equal(extractAuthorFromHtml(meta, 'x', { ...opts, excludeNames: ['Someone Else'] }), 'Ayn Rand');
  // Exact match only: a critic who merely shares a last name and first-name
  // prefix with a credited person keeps the attribution.
  assert.equal(extractAuthorFromHtml(meta, 'x', { ...opts, excludeNames: ['Ayn Randall', 'Aynsley Rand'] }), 'Ayn Rand');
  // A vetoed meta author falls through to the article's own text byline.
  const body = 'By Jane Critic | October 10, 2026\n\nThe play is a courtroom drama staged at Theatre Row with real energy.';
  assert.equal(extractAuthorFromHtml(meta, body, opts), 'Jane Critic');
  assert.equal(extractAuthorFromHtml(meta, body.replace('Jane Critic', 'Ayn Rand'), opts), null);
});

// BRO-3414: placeholder bylines on theaterscene / New Yorker / theaterlife.
test('Yoast @graph author reference resolves to the article Person, not a sidebar author widget', () => {
  const graph = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Article', '@id': 'https://x.net/a/#article', author: { '@id': 'https://x.net/#/schema/person/1' } },
    { '@type': 'Person', '@id': 'https://x.net/#/schema/person/1', name: 'Joseph Pisano' },
  ] };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(graph)}</script></head><body>`
    + '<div class="uw-text"><a href="/author/victor-gluck/" class="author-name">Victor Gluck, Editor-in-Chief</a></div></body></html>';
  assert.equal(extractByline(html), 'Joseph Pisano');
});

test('publisher meta author and house byline are skipped; Condé Nast byline link wins', () => {
  const head = '<meta name="author" content="Condé Nast"/>';
  const named = `${head}<span class="byline"><span class="byline__preamble">By </span><a class="BylineLink byline__name-link byline link" href="/contributors/helen-shaw">Helen Shaw</a></span>`;
  assert.equal(extractByline(named), 'Helen Shaw');
  const house = `${head}<span class="byline"><span class="byline__preamble">By </span><a class="byline__name-link" href="/">The New Yorker</a></span>`;
  assert.equal(extractByline(house), null);
});

test('"By Name" closed by a tag or slash keeps the full name', () => {
  assert.equal(extractByline('<p>By Isa Goldberg</p><p>Text</p>'), 'Isa Goldberg');
  assert.equal(extractByline('<em>By Isa Goldberg/Chief Theater Critic</em>'), 'Isa Goldberg');
  assert.equal(extractByline('<p>By: David Sheward</p>'), 'David Sheward');
});

test('publisher meta author PLASA Media falls through to the bold sign-off', () => {
  const html = '<meta name="author" content="PLASA Media Inc - Lighting &amp; Sound America"><p>it seems shockingly apt. <b>--David Barbour</b></font></p>';
  assert.equal(extractByline(html), 'David Barbour');
});

// BRO-3414 ship-check: prose-shaped candidates must look like a name.
test('inline By / sign-off reject nav and rating text', () => {
  assert.equal(extractByline('<a href="/sort">By Date</a>'), null);
  assert.equal(extractByline('<li>By The Numbers</li>'), null);
  assert.equal(extractByline('<p><b>--Highly Recommended</b></p>'), null);
  assert.equal(extractByline('<p>By Sunday</p>'), null);
  assert.equal(extractByline('<p>By Ross</p>'), 'Ross');
  assert.equal(extractByline('<p>By Holly O&rsquo;Mahony</p>'), "Holly O'Mahony");
});

// Playbill multi-author byline: other-desert-cities-2026 roundup was filed as
// critic "Meg" because the name class has no ',' and the lookahead only
// allowed "<word> <Capital>", so the capture backtracked to the first word.
test('multi-author inline By yields the first FULL name', () => {
  assert.equal(extractByline('<p>By Meg Masseron, Logan Culwell-Block</p>'), 'Meg Masseron');
  assert.equal(extractByline('<p>By Meg Masseron &amp; Logan Culwell-Block</p>'), 'Meg Masseron');
  assert.equal(extractByline('<p>By Meg Masseron and Logan Culwell-Block</p>'), 'Meg Masseron');
  assert.equal(extractByline('<p>By Ross Smith, Chief Critic</p>'), 'Ross Smith');
  assert.equal(extractByline('<p>By Isa Goldberg</p>'), 'Isa Goldberg');
});

test('publisher names are skipped in JSON-LD and with &eacute; entities', () => {
  const ld = '<script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Cond&eacute; Nast"}}</script>';
  assert.equal(extractJsonLdAuthor(ld), null);
  assert.equal(extractByline('<meta name="author" content="Cond&eacute; Nast"><p class="byline">By <a class="byline__name-link" href="/x">Helen Shaw</a></p>'), 'Helen Shaw');
});

test('one-word capture before a comma is a sort widget, not a byline', () => {
  assert.equal(extractByline('<p>By Relevance, Date</p>'), null);
  assert.equal(extractByline('<p>By Newest, Oldest</p>'), null);
  assert.equal(extractByline('<p>By Meg Masseron, Logan Culwell-Block</p>'), 'Meg Masseron');
});
