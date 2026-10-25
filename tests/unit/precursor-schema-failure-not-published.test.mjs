// BRO-3951: unknown show columns must not replace count-stable baseline winners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractCategoryEntries: parseCC } = require('../../scripts/lib/critics-circle-parser');
const { extractCategoryEntries: parseES } = require('../../scripts/lib/evening-standard-parser');
const { writePrecursorJson } = require('../../scripts/lib/precursor-wikipedia');

const baselines = Object.fromEntries(['critics-circle', 'evening-standard'].map(name => [
  name, JSON.parse(fs.readFileSync(new URL(`../../data/precursors/${name}.json`, import.meta.url))).data,
]));
const table = rows => `<table class="wikitable">${rows}</table>`;
const ccPage = (tables, section = 'Best_New_Play') =>
  `<div class="mw-heading mw-heading3"><h3 id="${section}"></h3></div>${tables}`;
const row = (cells, tag = 'td') => `<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
const example = (name, category) => baselines[name][category].find(e => e.year >= 1990 && e.winner);

// Exercise the production merge/write path, capturing its output instead of
// writing to the checked-in precursor files. --force must not bypass parsing.
function publish(t, name, category, entries) {
  let published;
  t.mock.method(fs, 'writeFileSync', (fp, content) => {
    assert.ok(String(fp).endsWith(`/precursors/${name}.json`));
    published = JSON.parse(content).data;
  });
  const result = writePrecursorJson(name, { [category]: entries }, { force: true });
  assert.equal(result.written, true);
  assert.equal(result.newCount, result.oldCount);
  return published;
}

for (const [name, category, headers, section] of [
  ['critics-circle', 'Best New Play', ['Year', 'Writer', 'Notes'], 'Best_New_Play'],
  ['critics-circle', 'Best New Play', ['Year', 'Playwright', 'Notes'], 'Best_New_Play'],
  ['critics-circle', 'Best Actor', ['Year', 'Recipient', 'Notes'], 'Best_Actor'],
  ['evening-standard', 'Best Play', ['Year', 'Writer', 'Notes']],
  ['evening-standard', 'Best Play', ['Year', 'Playwright', 'Notes']],
  ['evening-standard', 'Best Actor', ['Year', 'Actor', 'Notes']],
]) {
  test(`${name} ${category}: unsupported ${headers.join('/')} cannot overwrite a baseline winner`, t => {
    const original = example(name, category);
    const html = table(row(headers, 'th') + row([original.year, 'Wrong Person', 'Wrong Notes']));
    const entries = name === 'critics-circle'
      ? parseCC(ccPage(html, section), category, 1990)
      : parseES(html, category, 1990);
    assert.deepEqual(publish(t, name, category, entries), baselines[name]);
  });
}

test('CC Recipient alias resolves by label after reordering', () => {
  const html = ccPage(table(row(['Year', 'Writer', 'Recipient'], 'th') +
    row([1990, 'David Hare', 'Racing Demon'])));
  assert.equal(parseCC(html, 'Best New Play')[0].winner, 'Racing Demon');
});

for (const name of ['critics-circle', 'evening-standard']) {
  test(`${name}: skipped table preserves its slice while a healthy table updates`, t => {
    const category = name === 'critics-circle' ? 'Best New Play' : 'Best Play';
    const [badYear, goodYear] = baselines[name][category].filter(e => e.year >= 1990 && e.winner);
    const broken = table(row(['Year', 'Writer', 'Notes'], 'th') +
      row([badYear.year, 'Wrong Person', 'Wrong Notes']));
    const healthy = table(row(['Year', 'Play', 'Writer'], 'th') +
      row([goodYear.year, 'Corrected Show', 'Correct Writer']));
    const entries = name === 'critics-circle'
      ? parseCC(ccPage(broken + healthy), category, 1990)
      : parseES(broken + healthy, category, 1990);
    const published = publish(t, name, category, entries);
    const expected = structuredClone(baselines[name]);
    const updated = expected[category].find(e => e.year === goodYear.year);
    // Keep parser-specific fields (CC includes winners); this assertion is
    // about the production writer preserving every other record verbatim.
    Object.assign(updated, entries.find(e => e.year === goodYear.year));
    assert.equal(updated.winner, 'Corrected Show');
    assert.deepEqual(published, expected);
  });
}

test('ES: a missing Work cell cannot fall back to the actor cell', t => {
  const original = example('evening-standard', 'Best Actor');
  const html = table(row(['Year', 'Actor', 'Work'], 'th') + row([original.year, 'Wrong Person']));
  assert.deepEqual(publish(t, 'evening-standard', 'Best Actor', parseES(html, 'Best Actor')), baselines['evening-standard']);
});

test('ES: a labeled one-cell header is rejected, rather than treated as headerless', t => {
  const original = example('evening-standard', 'Best Play');
  const html = table(row(['Ceremony'], 'th') + row([original.year, 'Wrong Person']));
  assert.deepEqual(publish(t, 'evening-standard', 'Best Play', parseES(html, 'Best Play')), baselines['evening-standard']);
});

test('ES: a labeled table with Year moved off the first column is rejected', t => {
  const original = example('evening-standard', 'Best Actor');
  const html = table(row(['Actor', 'Year', 'Work'], 'th') +
    row([original.year, 'Wrong Person', 'Correct Show']));
  assert.deepEqual(publish(t, 'evening-standard', 'Best Actor', parseES(html, 'Best Actor')), baselines['evening-standard']);
});

for (const opening of [row(['36th (1990)']) + row(['Correct Show', 'Correct Writer']),
  row(['36th (1990)', 'Correct Show', 'Correct Writer'])]) {
  test('ES: known headerless ceremony layouts still parse', () => {
    assert.equal(parseES(table(opening), 'Best Play')[0].winner, 'Correct Show');
  });
}

test('CC: a TableSchemaError leaves baseline winners intact through the writer', t => {
  const original = example('critics-circle', 'Best New Play');
  const html = ccPage(table(row(['Year'], 'th') + row([original.year, 'Wrong Person'])));
  assert.deepEqual(publish(t, 'critics-circle', 'Best New Play', parseCC(html, 'Best New Play')), baselines['critics-circle']);
});

test('ES: ordinal text inside an unknown header does not permit positional parsing', t => {
  const html = table(row(['Edition 36th (1990)', 'Wrong Person', 'Wrong Notes']));
  assert.deepEqual(publish(t, 'evening-standard', 'Best Play', parseES(html, 'Best Play')), baselines['evening-standard']);
});

for (const [combined, empty] of [[true, false], [false, false], [true, true], [false, true]]) {
  test(`ES: ${empty ? 'empty' : 'missing'} Work (${combined ? 'combined' : 'separate'} ceremony row) cannot promote a later nominee`, t => {
    const category = 'Best Actor';
    const [badYear, goodYear] = baselines['evening-standard'][category].filter(e => e.year >= 1990 && e.winner);
    const opening = combined
      ? row([badYear.year, 'Wrong Person', ...(empty ? [''] : [])])
      : row([badYear.year]) + row(['Wrong Person', ...(empty ? [''] : [])]);
    const html = table(row(['Year', 'Actor', 'Work'], 'th') + opening +
      row(['Another Person', 'Nominee Show']) + row([goodYear.year, 'Correct Person', 'Correct Show']));
    const entries = parseES(html, category, 1990);
    const published = publish(t, 'evening-standard', category, entries);
    const expected = structuredClone(baselines['evening-standard']);
    Object.assign(expected[category].find(e => e.year === goodYear.year), entries.find(e => e.year === goodYear.year));
    assert.equal(published[category].find(e => e.year === goodYear.year).winner, 'Correct Show');
    assert.deepEqual(published, expected);
  });
}

test('ES: a short continuation after a valid opening show preserves that winner', () => {
  const html = table(row(['Year', 'Actor', 'Work'], 'th') +
    row([1990, 'Correct Person', 'Correct Show']) + row(['Continuation Person']) +
    row(['Another Person', 'Nominee Show']));
  const entries = parseES(html, 'Best Actor');
  assert.equal(entries[0].winner, 'Correct Show');
  assert.deepEqual(entries[0].nominees, ['Correct Show', 'Nominee Show']);
});
