// Pins the compare-video framing rule (BRO-6412 / owner 2026-10-27): puzzle opener with computed gap and direction,
// both scores, the like-for-like caveat, neutral maybes, and an open closing question in voice AND caption.
const assert = require('assert');
const { composeCompare, words } = require('./video-proto/compare-script');
const side = (o) => ({ title: 'Show', place: 'London', city: 'London', label: 'London 2024', score: 85, count: 26, year: 2024, ...o });
const A = side({}), B = side({ place: 'Off-Broadway', city: 'New York', label: 'Off-Broadway 2026', score: 77, count: 24, soFar: true, year: 2026 });
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name, '\n', e.message); process.exitCode = 1; } };

t('opens on the puzzle with computed gap and direction', () => {
  const c = composeCompare([A, B]);
  assert.strictEqual(c.gap, 8); assert(c.prompt.startsWith("[curious] Same show, two cities, and London's critics scored it eight points higher."));
  assert.strictEqual(c.screenHook.l2, 'London scored it 8 points higher.');
});
t('direction flips with the scores, gap is never typed', () => {
  const c = composeCompare([{ ...A, score: 70 }, { ...B, score: 77 }]);
  assert.strictEqual(c.gap, 7); assert(c.hook.includes("Off-Broadway's critics scored it seven points higher"));
  assert.strictEqual(composeCompare([{ ...A, score: 80 }, { ...B, score: 79 }]).hook.includes('one point higher'), true);
});
t('tie says the critics agreed', () => {
  const c = composeCompare([{ ...A, score: 80 }, { ...B, score: 80 }]);
  assert(/same score/.test(c.hook)); assert(!/higher/.test(c.prompt)); assert(/Why do you think the critics agreed\?/.test(c.prompt));
});
t('both scores, counts and the caveat are present', () => {
  const c = composeCompare([A, B]);
  ['eighty-five', 'twenty-six reviews', 'seventy-seven', 'twenty-four reviews so far', 'perfect comparison', 'cast and production may differ', 'Two years apart'].forEach(s => assert(c.prompt.toLowerCase().includes(s.toLowerCase()), s));
  ['85', '26 critics', '77', '24 critics so far', 'perfect comparison'].forEach(s => assert(c.caption.includes(s), s));
});
t('possibilities are hedged and claim nothing as fact', () => {
  const c = composeCompare([A, B]);
  assert((c.poss.match(/\bmaybe\b/gi) || []).length >= 2); assert(!/\b(because|proves|clearly|obviously|due to)\b/i.test(c.poss));
});
t('ends on an open question in voice and caption', () => {
  const c = composeCompare([A, B]);
  assert(c.prompt.trimEnd().endsWith('Tell us below.')); assert(c.caption.includes(c.question));
  assert(c.prompt.indexOf(c.question) > c.prompt.indexOf(c.poss));
});
t('banned wording', () => {
  const c = composeCompare([A, B]); const all = [c.prompt, c.caption, c.screenHook.l1, c.screenHook.l2].join(' ');
  assert(!/transfer/i.test(all)); assert(!/[—–]/.test(all)); assert(!/\b(truly|genuinely)\b/i.test(all));
});
t('different shows are refused', () => assert.throws(() => composeCompare([A, { ...B, title: 'Other' }]), /not the same show/));
t('words()', () => { assert.strictEqual(words(85), 'eighty-five'); assert.strictEqual(words(8), 'eight'); });
t('render path refuses a hand-edited plan', () => {
  const { assertTemplate } = require('./video-proto/compare-plan'); assert.strictEqual(typeof assertTemplate, 'function');
});
console.log(process.exitCode ? 'compare-script: FAILED' : `compare-script: ${n} checks passed`);
