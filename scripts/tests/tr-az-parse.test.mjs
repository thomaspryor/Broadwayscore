import { createRequire } from 'module';
import assert from 'assert';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { parseAzText, parseAzLines, dMonY } = require('../lib/tr-az-parse.js');
const fx = n => parseAzLines(parseAzText(fs.readFileSync(new URL(`../lib/__fixtures__/tr-az/${n}.azl.txt`, import.meta.url), 'utf8')));

// 2016 table layout (issue 170, real pdftotext -bbox-layout lines)
const a = fx('issue-170-p81');
assert.strictEqual(a.format, 2016);
assert.strictEqual(a.asAt, '2016-08-27');
const t = a.entries.map(e => e.title);
for (const want of ['AMERICAN IDIOT', 'KINKY BOOTS', 'LES MISERABLES', 'HOW THE OTHER HALF LOVES',
  'THE CURIOUS INCIDENT OF THE DOG IN THE NIGHT-TIME', 'THE PAST IS A TATTOOED SAILOR',
  'YOUNG CHEKHOV: PLATONOV', 'YOUNG CHEKHOV: THE SEAGULL', 'BEAUTIFUL – THE CAROLE KING MUSICAL', 'THE BODYGUARD']) {
  assert(t.includes(want), `missing ${want}`);
}
for (const bad of ['AMERICAN', 'KINKY', 'LES', 'HOW', 'YOUNG']) assert(!t.includes(bad), `fragment ${bad}`);
const kb = a.entries.find(e => e.title === 'KINKY BOOTS');
assert.strictEqual(kb.venue, 'Adelphi');
assert.strictEqual(kb.opened, '2015-09-15');
assert.strictEqual(a.entries.find(e => e.title === 'A MIDSUMMER NIGHT\'S DREAM').venue, 'Shakespeare\'s Globe');
assert(a.entries.every(e => !/\d{2}\/\d+|\b\d{1,2} [A-Z][a-z]{2} \d{2}\b/.test(e.venue || '')), 'venue carries date/vol text');
assert.strictEqual(new Set(t).size, t.length, 'duplicate titles');

// 2015 two-column layout (issue 929)
const b = fx('issue-929-p53');
assert.strictEqual(b.format, 2015);
const u = b.entries.map(e => e.title);
for (const want of ['AMERICAN IDIOT', 'BEAUTIFUL - THE CAROLE KING MUSICAL', 'THE BOOK OF MORMON', 'CATS']) assert(u.includes(want), `missing ${want}`);
assert(b.entries.every(e => !/\d{6,}/.test(e.title.replace(/\s/g, ""))), 'phone number glued to a title');

assert.strictEqual(dMonY('28 Jun 16'), '2016-06-28');
console.log('tr-az-parse ok', a.entries.length, b.entries.length);
