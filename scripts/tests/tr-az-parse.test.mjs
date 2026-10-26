import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const { parseAzEntries, azSection } = require('../lib/tr-az-parse.js');

const sample = `masthead text
A-Z of productions running in London at 13 October 2015
BEAUTIFUL- THE CAROLE KING MUSICAL New musical with songs by Goffin/King; opened 24.02.15 (p168)
HAMLET Revival of play by Shakespeare; season 25.08-31.10.15 (p813)
THE COMMITMENTS New musical with book by Roddy Doyle; opened 08.10.13 (p936); closes 01.11.15
KINKY BOOTS New musical by Harvey Fierstein; opened 15.09.15 (p1)`;

assert.strictEqual(azSection('nothing here'), '');
const rows = parseAzEntries(sample);
const by = Object.fromEntries(rows.map(r => [r.title, r]));
assert.strictEqual(by['BEAUTIFUL- THE CAROLE KING MUSICAL'].opened, '24.02.15');
assert.strictEqual(by['HAMLET'].seasonFrom, '25.08');
assert.strictEqual(by['HAMLET'].seasonTo, '31.10.15');
assert.strictEqual(by['THE COMMITMENTS'].closes, '01.11.15');
assert.strictEqual(by['KINKY BOOTS'].opened, '15.09.15');
assert.strictEqual(rows.length, 4);
console.log('tr-az-parse ok', rows.length);
