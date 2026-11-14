// BRO-7426: wiki list templates leaked into creative-team names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cleanWikitext, hasWikiMarkup } = require('./wikitext-clean.js');

test('plainlist with a space before the pipe becomes two names (Galileo)', () => {
  assert.equal(cleanWikitext('{{plainlist |\n* Zoe Sarnak\n* Michael Weiner\n}}'), 'Zoe Sarnak, Michael Weiner');
});
test('plainlist with no space, ubl with pipes, links', () => {
  assert.equal(cleanWikitext('{{Plainlist|\n* [[Stephen Sondheim]]\n* [[Leonard Bernstein|Bernstein]]\n}}'), 'Stephen Sondheim, Bernstein');
  assert.equal(cleanWikitext('{{ubl|Benj Pasek|Justin Paul}}'), 'Benj Pasek, Justin Paul');
});
test('plain values are unchanged', () => {
  assert.equal(cleanWikitext('[[Danny Strong]]'), 'Danny Strong');
  assert.equal(cleanWikitext('Lin-Manuel Miranda<ref>x</ref>'), 'Lin-Manuel Miranda');
  assert.equal(cleanWikitext('Tom Kitt<br />Brian Yorkey'), 'Tom Kitt, Brian Yorkey');
  assert.equal(cleanWikitext('{{nowrap|Jason Robert Brown}}'), 'Jason Robert Brown');
});
test('hasWikiMarkup flags leftovers only', () => {
  assert.equal(hasWikiMarkup('{{plainlist | Zoe Sarnak Michael Weiner'), true);
  assert.equal(hasWikiMarkup('[[Danny Strong'), true);
  assert.equal(hasWikiMarkup('Zoe Sarnak'), false);
});

test('sortname, lang and maintenance templates do not split or leak (BRO-7426 review)', () => {
  assert.strictEqual(cleanWikitext('{{sortname|Lin-Manuel|Miranda}}'), 'Lin-Manuel Miranda');
  assert.strictEqual(cleanWikitext('{{lang|fr|Claude-Michel Schönberg}}'), 'Claude-Michel Schönberg');
  assert.strictEqual(cleanWikitext('Jane Doe{{citation needed|date=May 2020}}'), 'Jane Doe');
  assert.strictEqual(cleanWikitext('{{plainlist |\n* {{sortname|Zoe|Sarnak}}\n* Michael Weiner\n}}'), 'Zoe Sarnak, Michael Weiner');
});
