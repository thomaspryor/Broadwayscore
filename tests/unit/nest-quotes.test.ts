import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { nestQuotes } from '../../src/lib/nest-quotes';

test('straight-quoted title inside a pull quote becomes single quotes', () => {
  assert.equal(
    nestQuotes('"Kramer/Fauci" is the most beautiful show I\u2019ve seen this year.'),
    '\u2018Kramer/Fauci\u2019 is the most beautiful show I\u2019ve seen this year.'
  );
});

test('curly-quoted phrase mid-sentence becomes single quotes', () => {
  assert.equal(
    nestQuotes('in the words of the moderator, \u201Can interesting and informative hour\u201D that works'),
    'in the words of the moderator, \u2018an interesting and informative hour\u2019 that works'
  );
});

test('quotes without nested quotation are unchanged', () => {
  const plain = 'Daniel Fish\u2019s brief, potent Kramer/Fauci makes the argument.';
  assert.equal(nestQuotes(plain), plain);
});

test('an unpaired quote mark mid-sentence is left alone', () => {
  assert.equal(nestQuotes('He said "it works'), 'He said "it works');
});

test('a quote wrapped entirely in its own marks loses the wrapper', () => {
  assert.equal(
    nestQuotes('"Gold\'s invigorating production showcases four stellar performances."'),
    'Gold\'s invigorating production showcases four stellar performances.'
  );
  assert.equal(nestQuotes('“A quietly devastating evening.”'), 'A quietly devastating evening.');
});

test('a stray unmatched opening or closing mark is dropped', () => {
  assert.equal(
    nestQuotes('"You will be thrilled by the performances...'),
    'You will be thrilled by the performances...'
  );
  assert.equal(nestQuotes('It soars.”'), 'It soars.');
});

test('an odd number of inner marks is left as written rather than mispaired', () => {
  const odd = 'In the Still of the Night, “Gloria,” “You Can‘t Hurry Love.';
  assert.equal(nestQuotes(odd), odd);
});

test('a trailing inch mark is not treated as a stray quote', () => {
  assert.equal(nestQuotes('He stands a towering 6\'2"'), 'He stands a towering 6\'2"');
});

test('every critic quote wrapped in curly marks goes through nestQuotes', () => {
  // Critic and outlet pages showed doubled marks because only ReviewsList
  // used nestQuotes (BRO-4881). Any &ldquo;{...quote...}&rdquo; must call it.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.tsx')) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          const m = line.match(/&ldquo;\{([^}]*[qQ]uote[^}]*)\}/);
          if (m && !m[1].includes('nestQuotes(')) offenders.push(`${p}:${i + 1}`);
        });
      }
    }
  };
  walk(path.join(__dirname, '../../src'));
  assert.deepEqual(offenders, []);
});

test('a stray opening mark plus a nested title keeps the title as single quotes', () => {
  assert.equal(
    nestQuotes('"The standard advice is \'Write about what you know.\' In the case of "A Strange Loop," both apply.'),
    'The standard advice is \'Write about what you know.\' In the case of ‘A Strange Loop,’ both apply.'
  );
});
