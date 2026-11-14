import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decodeBloxRot47, rot47 } = require('./blox-rot47-decode.js');
const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const { cleanText } = require('./text-cleaning.js');

test('rot47 is its own inverse and maps <p> to kAm', () => {
  assert.equal(rot47('<p>'), 'kAm');
  assert.equal(rot47('</p>'), 'k^Am');
  assert.equal(rot47(rot47('Beetlejuice, "ok" & fun!')), 'Beetlejuice, "ok" & fun!');
});

test('decodes scrambled paragraphs in place and leaves normal markup alone', () => {
  const html = `<div><p>Free lede.</p>${esc(rot47('<p>Paywalled paragraph one.</p>'))}${esc(rot47('<p>Two &amp; more.</p>'))}</div>`;
  const out = decodeBloxRot47(html);
  assert.ok(out.includes('<p>Paywalled paragraph one.</p>'));
  assert.ok(out.includes('<p>Two &amp; more.</p>'));
  assert.ok(out.includes('<p>Free lede.</p>'));
});

test('handles HTML-escaped scrambled blocks (entities in the scrambled text)', () => {
  const scrambled = rot47('<p>He said &quot;wow&quot;</p>').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  assert.ok(decodeBloxRot47(`x${scrambled}y`).includes('<p>He said &quot;wow&quot;</p>'));
});

test('leaves an unterminated kAm block', () => {
  const s = 'kAm unterminated scramble, no closing tag';
  assert.equal(decodeBloxRot47(s), s);
  assert.equal(decodeBloxRot47('no scramble here'), 'no scramble here');
});

test('cleanText strips the video.js modal and app-prompt boilerplate', () => {
  const t = 'Great show.\n\nBeginning of dialog window. Escape will cancel and close the window.\n\nEnd of dialog window.\n\nStill great.';
  const out = cleanText(t);
  assert.ok(!/dialog window/i.test(out));
  assert.ok(out.includes('Great show.') && out.includes('Still great.'));
});

test('a stray kAm earlier in real markup does not swallow the page (review finding)', () => {
  const html = `<script>x="base64,QkAmZz"</script><p>Free lede by critic.</p>${esc(rot47('<p>Paid paragraph.</p>'))}`;
  const out = decodeBloxRot47(html);
  assert.ok(out.includes('<p>Free lede by critic.</p>'));
  assert.ok(out.includes('<p>Paid paragraph.</p>'));
  assert.ok(out.includes('QkAmZz'));
});

test('numeric entities (&#039; &#60;) in scrambled text are unescaped before rot47', () => {
  const plain = "<p>It's V</p>";
  const scrambled = rot47(plain).replace(/'/g, '&#039;').replace(/</g, '&#60;');
  assert.equal(decodeBloxRot47(scrambled), plain);
});

// ---- BRO-5261 retro-review hardening ----
const { decodeBloxRot47InDocument } = require('./blox-rot47-decode.js');
const PROSE = '<p>The revival is sharp, funny and beautifully sung from start to finish.</p>';

test('named entities in the scrambled text decode (curly quote, nbsp) instead of rotating', () => {
  const plain = '<p>It’s a triumph, the best musical revival of the season.</p>';
  const scrambled = rot47(plain).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/’/g, '&rsquo;').replace(/ /g, '&nbsp;');
  assert.equal(decodeBloxRot47(`<div>${scrambled}</div>`), `<div>${plain}</div>`);
});

test('astral numeric entities keep their code point; &#38;lt; is unescaped once', () => {
  const plain = '<p>Pure joy \u{1F600} from the first number onward, truly.</p>';
  const scrambled = esc(rot47(plain)).replace('\u{1F600}', '&#128512;');
  assert.equal(decodeBloxRot47(scrambled), plain);
  // A literal scrambled "&lt;" (outer "&#38;lt;") must stay "&lt;" before rot47.
  const lit = '<p>Rated a &lt;b&gt; tag joke, which the critic enjoyed a lot.</p>';
  const outer = rot47(lit).replace(/&/g, '&#38;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  assert.equal(decodeBloxRot47(outer), lit);
});

test('a kAm...k^Am span that is not scrambled prose is left alone', () => {
  const s = '<code>kAm hello world, this is plain text and not a scramble k^Am</code>';
  assert.equal(decodeBloxRot47(s), s);
});

test('attribute values and script bodies are never decoded', () => {
  const run = esc(rot47(PROSE));
  const attr = `<div data-x="${run.replace(/"/g, '&quot;')}">x</div>`;
  assert.equal(decodeBloxRot47(attr), attr);
  const script = `<script type="application/ld+json">{"articleBody":"${run}"}</script>`;
  assert.equal(decodeBloxRot47(script), script);
  assert.ok(decodeBloxRot47(`<div>${run}</div>`).includes(PROSE));
});

test('a scrambled run with a subhead between paragraphs decodes whole', () => {
  const plain = `${PROSE}<h2>Second act</h2>${PROSE}`;
  assert.equal(decodeBloxRot47(`<div>${esc(rot47(plain))}</div>`), `<div>${plain}</div>`);
});

test('collect-review-texts extractTextFromHtml decodes BLOX paragraphs (the collector path)', () => {
  const { extractTextFromHtml } = require('../collect-review-texts.js');
  const html = `<html><body><article><p>Free lede about the show.</p>${esc(rot47(PROSE))}</article></body></html>`;
  const text = extractTextFromHtml(html, 'https://tulsaworld.com/entertainment/review-x.html');
  assert.match(text, /beautifully sung from start to finish/);
  assert.doesNotMatch(text, /k\^Am/);
});

test('decodeBloxRot47InDocument decodes a scrambled text node in a live DOM', async () => {
  const { JSDOM } = await import('jsdom');
  // In the DOM the run is one text node with entities already decoded.
  const dom = new JSDOM(`<body><div id="a"><p>Free lede.</p><div class="encrypted-content">${esc(rot47(PROSE))}</div></div><script>var s="${'kAm'}x${'k^Am'}";</script></body>`);
  const fn = new dom.window.Function('document', `return (${decodeBloxRot47InDocument.toString()})(document)`);
  assert.equal(fn(dom.window.document), 1);
  const box = dom.window.document.querySelector('.encrypted-content');
  assert.equal(box.querySelector('p').textContent, 'The revival is sharp, funny and beautifully sung from start to finish.');
  assert.match(dom.window.document.querySelector('script').textContent, /kAmxk\^Am/);
});

test('cleanText strips the other video.js modal strings', () => {
  const out = cleanText('Great show.\n\nThis is a modal window. This modal can be closed by pressing the Escape key or activating the close button.\n\nStill great.');
  assert.ok(!/modal/i.test(out));
});
