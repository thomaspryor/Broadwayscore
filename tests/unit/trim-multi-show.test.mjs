import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trimByAsteriskDivider } = require('../../scripts/lib/multi-show-asterisk-divider.js');

// Invented prose only. These mirror the layouts of Finkle's First Nighter columns.
const prose = 'The performers develop each scene carefully, and the staging lets the dialogue breathe. '.repeat(9);
const section = title => `${title} opens the evening. ${prose} The final scene of ${title} lands well.`;
const divider = '******************';
const source = { outletId: 'huffpost', criticName: 'David Finkle' };

test('scoring-delta requires an A/B check for section selection changes', () => {
  const { LLM_INPUT_FILES } = require('../../scripts/lib/scoring-watchlists.js');
  for (const file of ['scripts/lib/multi-show-asterisk-divider.js', 'scripts/llm-scoring/trim-multi-show.ts', 'scripts/llm-scoring/multi-show-detector.ts']) {
    assert.ok(LLM_INPUT_FILES.includes(file), `${file} must be an LLM input dependency`);
  }
});

for (const [title, index, marker] of [
  ['Fade', 0, `\n${divider}\n`],
  ['Fool for Love', 2, `\n${divider}\n`],
  ['Heisenberg', 1, divider],
  ['Henry IV', 0, `\n${divider}\n`],
  ['Othello: The Remix', 2, divider],
]) {
  test(`isolates ${title}, section ${index + 1}, including flattened dividers`, () => {
    const parts = [section('Invented Alpha'), section('Invented Beta'), section('Invented Gamma')];
    // The printed title omits our catalogue's colon.
    parts[index] = section(title.replace(':', ''));
    const text = parts.join(marker);
    const result = trimByAsteriskDivider(text, title, source);
    assert.equal(result.trimFailed, false);
    assert.equal(result.trimmed, true);
    assert.equal(result.method, 'asterisk-divider');
    assert.equal(result.text, parts[index]);
    assert.equal(result.originalLength, text.length);
    assert.equal(result.trimmedLength, parts[index].length);
  });
}

test('other outlets, other critics and unknown sources retain the full text', () => {
  const text = `${section('Fade')}${divider}${section('Invented Beta')}`;
  for (const other of [undefined, { outletId: 'wsj', criticName: 'David Finkle' }, { outletId: 'huffpost', criticName: 'Michael Giltz' }]) {
    assert.equal(trimByAsteriskDivider(text, 'Fade', other).text, text);
  }
});

test('Henry IV cross-references in the next review do not outweigh its own section', () => {
  const own = `${section('Henry IV')} Henry IV. Henry IV. Henry IV.`;
  const other = `${section('Invented Beta')} The earlier Henry IV offers a contrast to Henry IV on film.`;
  assert.equal(trimByAsteriskDivider(`${own}\n${divider}\n${other}`, 'Henry IV', source).text, own);
});

test('a standalone asterisk rule with whitespace and CRLF is recognised', () => {
  const own = section('Fool for Love');
  const text = `${section('Invented Alpha')}\r\n  ${divider}  \r\n${own}`;
  assert.equal(trimByAsteriskDivider(text, 'Fool for Love', source).text, own);
});

for (const [label, text, title] of [
  ['no divider', section('Fade'), 'Fade'],
  ['ordinary bold', `**Fade** ${prose} **Fade** ${prose}`, 'Fade'],
  ['inline footnote stars', `${section('Fade')}***${section('Invented Alpha')}`, 'Fade'],
  ['standalone five-star rating', `${section('Fade')}\n*****\n${section('Invented Beta')}`, 'Fade'],
  ['title absent', `${section('Invented Alpha')}${divider}${section('Invented Beta')}`, 'Fade'],
  ['substring only', `${section('Faded')}${divider}${section('Invented Beta')}`, 'Fade'],
  ['one incidental mention', `${section('Invented Alpha')} Fade.${divider}${section('Invented Beta')}`, 'Fade'],
  ['ambiguous equal mentions', `${section('Fade')}${divider}${section('Fade')}`, 'Fade'],
  ['ambiguous close counts', `${section('Fade')} Fade.${divider}${section('Fade')}`, 'Fade'],
  ['too short', `Fade. Fade.${divider}${section('Invented Beta')}`, 'Fade'],
  ['decorative rules around one review', `${divider}\n${section('Fade')}\n${divider}`, 'Fade'],
  ['a divider before a short footer', `${section('Fade')}\n${divider}\nAn invented author biography.`, 'Fade'],
]) {
  test(`leaves the full article intact: ${label}`, () => {
    const result = trimByAsteriskDivider(text, title, source);
    assert.equal(result.trimmed, false);
    assert.equal(result.text, text);
  });
}
