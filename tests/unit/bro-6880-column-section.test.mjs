// BRO-6880: a T1/T2 multi-show critic column (Washington Post shape) keeps only the
// target show's section; a true roundup (quotes other critics) is still refused.
// Synthetic prose, not article text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isolateMultiShowSection } = require('../../scripts/lib/multi-show-section-extract.js');
const { isolateColumnSection, countOtherCriticAttributions } = require('../../scripts/lib/column-section-extract.js');

const URL = 'https://www.washingtonpost.com/entertainment/theater/2026/10/23/stars-are-shining-broadway-an-upstart-musical-upstages-them-all/';
const TITLES = ['Other Desert Cities', 'School Girls; Or, The African Mean Girls Play', 'The Imaginary Invalid', 'Hamilton'];
const filler = (tag, n = 5) => Array.from({ length: n }, (_, i) => `The ${tag} cast keeps a steady pace through scene ${i + 1} and the staging stays clear.`).join(' ');

const ODC = `‘Other Desert Cities’ returns with a family fight over a memoir. ${filler('ODC')} ‘Other Desert Cities’ still has bite.\n\nThe second act of the ODC revival lands the reveal cleanly. ${filler('ODC-two')}`;
const SG = `Over at another house, ‘School Girls; Or, The African Mean Girls Play’ follows a clique in Ghana. ${filler('SG')} Seeing ‘School Girls; Or, The African Mean Girls Play’ again is a pleasure.\n\nThe ensemble of the SG production shares one voice. ${filler('SG-two')}`;
const TII = `Best of the three is ‘The Imaginary Invalid,’ a farce about a man sure he is dying. ${filler('TII')} ‘The Imaginary Invalid’ is the one to see.\n\nIts closing scene earns the loudest laugh of the column. ${filler('TII-two')}`;
const COLUMN = `Three openings this week, and one clear winner.\n\n${ODC}\n\n${SG}\n\n${TII}`;

test('WaPo three-show column: the real isolation function keeps only the target section', () => {
  const iso = isolateMultiShowSection(URL, COLUMN, 'The Imaginary Invalid', [], TITLES);
  assert.equal(iso.action, 'isolated');
  assert.match(iso.text, /closing scene earns the loudest laugh/);
  assert.doesNotMatch(iso.text, /ODC|School Girls|SG production|Three openings/);
  const sg = isolateMultiShowSection(URL, COLUMN, 'School Girls; Or, The African Mean Girls Play', [], TITLES);
  assert.equal(sg.action, 'isolated');
  assert.match(sg.text, /ensemble of the SG production/);
  assert.doesNotMatch(sg.text, /Imaginary|ODC/);
});

test('a wrap-up paragraph naming several shows belongs to no section', () => {
  const wrap = `Compared with ‘Other Desert Cities’ and ‘School Girls; Or, The African Mean Girls Play’, this one is the funniest.`;
  const iso = isolateMultiShowSection(URL, `${COLUMN}\n\n${wrap}`, 'The Imaginary Invalid', [], TITLES);
  assert.equal(iso.action, 'isolated');
  assert.doesNotMatch(iso.text, /Compared with/);
});

test('true roundup that quotes other critics is refused, not isolated', () => {
  const quotes = (t) => `According to The New York Times, ${t} is a delight. Variety called it a triumph, and Jesse Green of the Times wrote that it sings.`;
  const roundup = `Critics weigh in this week.\n\n${ODC}\n\n${quotes('‘Other Desert Cities’')}\n\n${SG}\n\n${TII}\n\n${quotes('‘The Imaginary Invalid’')}`;
  assert.ok(countOtherCriticAttributions(roundup) >= 2);
  const iso = isolateMultiShowSection(URL, roundup, 'The Imaginary Invalid', [], TITLES);
  assert.equal(iso.action, 'refuse');
  assert.equal(iso.text, null);
  assert.equal(iso.reason, 'roundup');
});

test('target not in the column, or too thin, is refused rather than guessed', () => {
  assert.equal(isolateMultiShowSection(URL, COLUMN, 'Hamilton', [], TITLES).action, 'refuse');
  const thin = `‘Other Desert Cities’ opens here. ${filler('A')}\n\n${ODC}\n\n${SG}\n\nQuick note on ‘The Imaginary Invalid’: fun.`;
  assert.equal(isolateMultiShowSection(URL, thin, 'The Imaginary Invalid', [], TITLES).action, 'refuse');
});

test('a single-show WaPo review that mentions another show in passing is left whole', () => {
  const single = `‘The Imaginary Invalid’ is a farce about a hypochondriac. ${filler('TII', 8)}\n\n${filler('TII-b', 8)}\n\nIt recalls ‘Hamilton’ only in its pace.\n\n${filler('TII-c', 8)}`;
  const iso = isolateMultiShowSection(URL, single, 'The Imaginary Invalid', [], TITLES);
  assert.equal(iso.action, 'single-section');
  assert.equal(iso.text, single);
});

test('non-column hosts are untouched; short text is returned unchanged', () => {
  assert.equal(isolateMultiShowSection('https://example.com/a', COLUMN, 'The Imaginary Invalid', [], TITLES).action, 'not-multi-show');
  assert.equal(isolateColumnSection('Short.', 'The Imaginary Invalid', { knownTitles: TITLES }).action, 'single-section');
});

// BRO-6872: some fetch routes flatten the column to one line. Sections are then found from each review's listing
// footer ("About 1 hour 30 minutes. example.org."), and a section belongs to the show it names first.
const foot = (site) => `Through Nov. 22 at the Example Theatre. About 1 hour 30 minutes. ${site}.org.`;
const FLAT_ODC = `Two big names lead this week. ‘Other Desert Cities’ returns with a family fight over a memoir. ${filler('ODC', 8)} ${foot('odc')}`;
const FLAT_SG = `Here are two more. ‘School Girls; Or, The African Mean Girls Play’ follows a clique in Ghana. ${filler('SG', 8)} ${foot('sg')}`;
const FLAT_TII = `If anyone can adapt Moliere, it is this company with ‘The Imaginary Invalid,’ a farce about a man sure he is dying. ${filler('TII', 6)} Unlike ‘Other Desert Cities,’ it never sags. Sometimes that is just what the doctor ordered. ${foot('tii')}`;
const FLAT = [FLAT_ODC, FLAT_SG, FLAT_TII].join(' ');
const FLAT_TITLES = [...TITLES, 'The Doctor', 'Broadway'];

test('flattened column: the target section is kept, sentences naming another show are dropped', () => {
  assert.ok(!FLAT.includes('\n') && FLAT.length > 1500);
  const iso = isolateMultiShowSection(URL, FLAT, 'The Imaginary Invalid', [], FLAT_TITLES);
  assert.equal(iso.action, 'isolated');
  assert.match(iso.text, /^If anyone can adapt Moliere/);
  assert.match(iso.text, /just what the doctor ordered/, 'lower-case prose is not the title "The Doctor"');
  assert.match(iso.text, /tii\.org\.$/);
  assert.doesNotMatch(iso.text, /Desert Cities|School Girls|ODC|SG cast/);
  const sg = isolateMultiShowSection(URL, FLAT, 'School Girls; Or, The African Mean Girls Play', [], FLAT_TITLES);
  assert.equal(sg.action, 'isolated');
  assert.doesNotMatch(sg.text, /Imaginary|ODC/);
});

test('flattened column: refuses when the show owns no section or two; one footer is a single review', () => {
  assert.equal(isolateMultiShowSection(URL, FLAT, 'Hamilton', [], FLAT_TITLES).action, 'refuse');
  const twice = `${FLAT} ‘The Imaginary Invalid’ again, briefly. ${filler('again', 6)} ${foot('again')}`;
  assert.equal(isolateMultiShowSection(URL, twice, 'The Imaginary Invalid', [], FLAT_TITLES).reason, 'ambiguous');
  const one = `${FLAT_TII} ${filler('more', 10)}`;
  assert.equal(isolateMultiShowSection(URL, one, 'The Imaginary Invalid', [], FLAT_TITLES).action, 'single-section');
});
