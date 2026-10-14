import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decodeBloxRot47, rot47 } = require('./blox-rot47-decode.js');
const { cleanText } = require('./text-cleaning.js');

test('rot47 is its own inverse and maps <p> to kAm', () => {
  assert.equal(rot47('<p>'), 'kAm');
  assert.equal(rot47('</p>'), 'k^Am');
  assert.equal(rot47(rot47('Beetlejuice, "ok" & fun!')), 'Beetlejuice, "ok" & fun!');
});

test('decodes scrambled paragraphs in place and leaves normal markup alone', () => {
  const html = `<div><p>Free lede.</p>${rot47('<p>Paywalled paragraph one.</p>')}${rot47('<p>Two &amp; more.</p>')}</div>`;
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
