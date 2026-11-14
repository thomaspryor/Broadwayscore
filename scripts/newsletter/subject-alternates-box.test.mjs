import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subjectAlternatesBox, injectSubjectBox } from './subject-alternates-box.mjs';

test('lists the pick and runners-up, escaped', () => {
  const html = subjectAlternatesBox({ subject: 'A & B close Saturday', subjectWriter: { writer: 'ai', angle: 'last chance' },
    subjectAlternates: [{ subject: 'See <The Bridge>', preheader: 'p', angle: 'book' }] });
  assert.match(html, /A &amp; B close Saturday/);
  assert.match(html, /See &lt;The Bridge&gt;/);
  assert.match(html, /Option 2 \(book\)/);
});

test('nothing for template subjects or no alternates', () => {
  assert.equal(subjectAlternatesBox({ subject: 'x', subjectWriter: { writer: 'template' }, subjectAlternates: [{ subject: 'y' }] }), '');
  assert.equal(subjectAlternatesBox({ subject: 'x', subjectWriter: { writer: 'ai' }, subjectAlternates: [] }), '');
  assert.equal(subjectAlternatesBox(null), '');
});

test('box lands after the real body tag and preheader, not inside the u-tag comment', () => {
  const html = '<!-- trick: <u></u> before <body> --><u></u>\n<body id="body" class="x">\n<div style="display:none !important;">Preview text<span style="display:none">&zwnj;</span></div><table>content</table></body>';
  const out = injectSubjectBox(html, '<p>BOX</p>');
  assert.ok(out.indexOf('<p>BOX</p>') > out.indexOf('Preview text'));
  assert.ok(out.indexOf('<p>BOX</p>') < out.indexOf('<table>content'));
  assert.ok(out.startsWith('<!-- trick: <u></u> before <body> -->'));
});
