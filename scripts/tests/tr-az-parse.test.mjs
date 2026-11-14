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

// BRO-6343: issue 159 prints the 2015 layout 125pt right and 175pt down
const c = fx('issue-159-p81');
assert.strictEqual(c.format, 2015);
assert.strictEqual(c.asAt, '2016-02-16');
const v = c.entries.map(e => e.title);
for (const want of ['ANDY CAPP THE MUSICAL', 'BEND IT LIKE BECKHAM', 'NELL GWYNN', 'MR FOOTE\'S OTHER LEG', 'WONDER.LAND']) assert(v.includes(want), `159 missing ${want}`);
assert.strictEqual(c.entries.find(e => e.title === 'BEND IT LIKE BECKHAM').opened, '2015-06-24');
assert.strictEqual(c.entries.find(e => e.title === 'BEND IT LIKE BECKHAM').closes, '2016-03-05');
assert(!v.includes('23.09.07'), 'a wrapped date read as a title');
assert(!v.includes('THE DEVIL SPEAKS TRUE'), 'future-schedule row read as A-Z (section end missed)');

// BRO-6343: issue 163 prints the 2016 table on the right half of a two-page spread, and the page twice
const d = fx('issue-163-p69');
assert.strictEqual(d.format, 2016);
assert.strictEqual(d.asAt, '2016-04-12');
const w = d.entries.map(e => e.title);
for (const want of ['THE BOOK OF MORMON', 'KINKY BOOTS', 'NOTMOSES', 'THE PAINKILLER', 'WONDER.LAND']) assert(w.includes(want), `163 missing ${want}`);
assert.strictEqual(d.entries.find(e => e.title === 'KINKY BOOTS').venue, 'Adelphi');
assert.strictEqual(new Set(w).size, w.length, '163 duplicate titles (page printed twice)');
assert(!w.some(x => /HEDDA GABLER|DARK MIRROR/.test(x)), 'the other half of the spread or the schedule was read');
assert(!w.includes('2016'), '"Circusfest 2016" read as title "2016"');
// titles that are numbers stay titles
assert(t.includes('1984') && t.includes('946'), 'numeric titles dropped');

// synthetic 2016 rows: a stray wrapped word before a numeric title is skipped, a title word before digits is not
const L = (x, y, text, page = 1) => ({ issue: 't', page, x, y, x2: x + 200, text });
const head = [L(34, 17, 'A–Z of productions running in London'), L(398, 42, 'OPENED VOL/pp PRESS')];
const e = parseAzLines([...head, L(34, 100, 'a 1984 – New adaptation of Orwell'), L(330, 100, 'Playhouse'), L(400, 100, '28 Jun 16'),
  L(34, 120, 'Circusfest 2016 – Incl. Race Horse Co.'), L(330, 120, 'Roundhouse')]).entries.map(x => x.title);
assert(e.includes('1984'), 'stray word before 1984 not skipped');
assert(!e.includes('2016'), 'Circusfest 2016 read as 2016');

// 2015: a wrapped dd.mm.yy line is the current entry's text, never a new entry
const f2015 = parseAzLines([L(34, 40, 'A-Z of productions running in'), L(34, 61, 'London at 10 November 2015'),
  L(34, 100, 'EARLY SHOW New play by Someone; opened'), L(34, 107, '23.09.15; transfers 04.10.15')]).entries;
assert.deepStrictEqual(f2015.map(x => [x.title, x.opened]), [['EARLY SHOW', '2015-09-23']]);

// a carried shift does not crop a later standard-width page
const shifted = [L(160, 215, 'A-Z of productions running in'), L(160, 234, 'London at 16 February 2016'),
  L(160, 300, 'ANDY CAPP THE MUSICAL Revival of musical by Someone; opened 08.02.16'),
  L(34, 100, 'CATS Revival of musical by Andrew Lloyd Webber; opened 23.10.15', 2)];
const g = parseAzLines(shifted).entries.map(x => x.title);
assert(g.includes('ANDY CAPP THE MUSICAL') && g.includes('CATS'), `carried shift cropped a page: ${g}`);

// repeated positioned lines (overlapping dumps) count once
const dup = parseAzLines([...head, L(34, 100, 'KINKY BOOTS – New musical'), L(330, 100, 'Adelphi'), L(330, 100, 'Adelphi'), L(400, 100, '15 Sep 15')]).entries;
assert.strictEqual(dup.find(x => x.title === 'KINKY BOOTS').venue, 'Adelphi');

assert.strictEqual(dMonY('28 Jun 16'), '2016-06-28');
console.log('tr-az-parse ok', a.entries.length, b.entries.length, c.entries.length, d.entries.length);
