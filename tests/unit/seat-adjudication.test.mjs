/**
 * BRO-8018: the deterministic half of seating re-verification. A model can claim anything;
 * these functions decide what survives, so they are tested against the real module (§15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../../scripts/lib/seat-adjudication.js');

const PAGE = 'Gershwin Theatre seating chart. The best seats are in the Orchestra Center, rows F to L, where you can see facial expressions. The Front Mezzanine Row A overhangs Orchestra Row O. Rear Mezzanine seats are far away but cheap.';
const OTHER = 'Majestic Theatre seating. The best seats are in the Orchestra Center, rows F to L, where you can see facial expressions.';
const sources = [
  { url: 'https://a.example/g', text: PAGE, namesTheater: A.pageNamesTheater(PAGE, 'Gershwin Theatre') },
  { url: 'https://b.example/m', text: OTHER, namesTheater: A.pageNamesTheater(OTHER, 'Gershwin Theatre') },
];
const section = { name: 'Orchestra Center', rowRange: 'F-L', bestRow: 'Row H', verdict: 'sweet-spot', verdictLabel: 'Best', priceTier: 'premium', rationale: 'old', evidenceUrls: ['https://a.example/g', 'https://b.example/m'] };

describe('theater matching', () => {
  test('page naming the theater (either spelling) counts; another theater does not', () => {
    assert.strictEqual(sources[0].namesTheater, true);
    assert.strictEqual(sources[1].namesTheater, false);
    assert.strictEqual(A.pageNamesTheater('Seats at the Gershwin Theater are huge', 'Gershwin Theatre'), true);
  });
  test('former names count for renamed houses', () => {
    assert.strictEqual(A.pageNamesTheater('the Cort Theatre balcony', 'James Earl Jones Theatre'), true);
    assert.strictEqual(A.pageNamesTheater('the Brooks Atkinson mezzanine', 'Lena Horne Theatre'), true);
  });
});

describe('verbatim quote check', () => {
  test('exact quote passes, ignoring case, punctuation and curly quotes', () => {
    assert.ok(A.quoteInText('Orchestra Center, rows F to L', PAGE));
    assert.ok(A.quoteInText('the front mezzanine row a OVERHANGS orchestra row o', PAGE));
  });
  test('paraphrase fails', () => {
    assert.ok(!A.quoteInText('rows F through L are the best', PAGE));
  });
  test('too-short quotes fail (cannot prove anything)', () => {
    assert.ok(!A.quoteInText('rows', PAGE));
  });
  test('groundEvidence drops quotes from pages that do not name the theater, bad indexes, and invented quotes', () => {
    const ev = A.groundEvidence([
      { src: 1, quote: 'Orchestra Center, rows F to L' },
      { src: 2, quote: 'Orchestra Center, rows F to L' },
      { src: 9, quote: 'Orchestra Center, rows F to L' },
      { src: 1, quote: 'best legroom on Broadway' },
    ], sources);
    assert.deepStrictEqual(ev.map((e) => e.src), [1]);
  });
});

describe('copy rules', () => {
  test('em dashes, quotation marks and non-tenant show names are problems', () => {
    assert.ok(A.copyProblems('Great view — close').includes('em dash'));
    assert.ok(A.copyProblems('Called "the best"').includes('quotation marks'));
    assert.ok(A.copyProblems('Good for Jersey Boys fans', { forbiddenTitles: ['Jersey Boys'] }).length);
    assert.deepStrictEqual(A.copyProblems("Close to the stage, with the theater's best rake."), []);
    assert.ok(A.copyProblems('Rows F to L are identified as the best.').length);
    assert.ok(A.copyProblems('The source recommends these seats.').length);
  });
});

describe('groundRewrite + decideSection', () => {
  const reply = {
    name: { keep: true, evidence: [{ src: 1, quote: 'Orchestra Center, rows F to L' }] },
    verdict: { supported: true, evidence: [{ src: 1, quote: 'The best seats are in the Orchestra Center' }] },
    rowRange: { keep: true, evidence: [{ src: 1, quote: 'Orchestra Center, rows F to L' }] },
    bestRow: { keep: true, evidence: [{ src: 1, quote: 'Row H is perfect' }] },
    priceTier: { keep: false, evidence: [] },
    rationale: [
      { text: 'Rows F to L put you close enough to see faces.', evidence: [{ src: 1, quote: 'where you can see facial expressions' }] },
      { text: 'A critic called it — the best.', evidence: [{ src: 1, quote: 'where you can see facial expressions' }] },
      { text: 'Made-up claim.', evidence: [{ src: 1, quote: 'nothing like this on the page' }] },
    ],
  };
  const { claims } = A.groundRewrite(section, reply, sources);
  test('only grounded, rule-clean claims reach the verifier', () => {
    assert.deepStrictEqual(claims.map((c) => c.kind), ['name', 'verdict', 'rowRange', 'rationale']);
  });
  test('kept section carries only accepted fields; ungrounded bestRow and priceTier removed', () => {
    const acc = new Map(claims.map((c, i) => [i + 1, true]));
    const { section: out } = A.decideSection(section, claims, acc);
    assert.strictEqual(out.rowRange, 'F-L');
    assert.strictEqual(out.bestRow, undefined);
    assert.strictEqual(out.priceTier, undefined);
    assert.strictEqual(out.rationale, 'Rows F to L put you close enough to see faces.');
    assert.deepStrictEqual(out.evidenceUrls, ['https://a.example/g']);
  });
  test('verifier rejecting the section name drops the section (audit: unsupported qualifiers)', () => {
    const acc = new Map(claims.map((c, i) => [i + 1, c.kind !== 'name']));
    assert.strictEqual(A.decideSection(section, claims, acc).dropped, 'section name not supported');
  });
  test('rewriter can strip unsupported qualifiers from the name; verifier checks the cleaned name', () => {
    const rep = { ...reply, name: { text: 'Orchestra Center — Sweet Spot', keep: true, evidence: [{ src: 1, quote: 'Orchestra Center, rows F to L' }] } };
    const g = A.groundRewrite({ ...section, name: 'Center Orchestra Sweet Spot (Rows B-D)' }, rep, sources);
    const nc = g.claims.find((c) => c.kind === 'name');
    assert.match(nc.text, /"Orchestra Center, Sweet Spot"/);
    const { section: out } = A.decideSection(section, g.claims, new Map(g.claims.map((c, i) => [i + 1, true])));
    assert.strictEqual(out.name, 'Orchestra Center, Sweet Spot');
  });
  test('verifier sees the paragraph around each quote', () => {
    const v = A.buildVerifyPrompt({ theaterName: 'Gershwin Theatre', sectionName: 'Orchestra Center', claims });
    assert.match(v, /SURROUNDING TEXT: \.\.\.gershwin theatre seating chart/);
  });
  test('verifier rejecting the verdict drops the section', () => {
    const acc = new Map(claims.map((c, i) => [i + 1, c.kind !== 'verdict']));
    assert.strictEqual(A.decideSection(section, claims, acc).dropped, 'verdict not supported');
  });
  test('no accepted rationale and no accepted hazard drops the section', () => {
    const acc = new Map(claims.map((c, i) => [i + 1, c.kind !== 'rationale']));
    assert.strictEqual(A.decideSection(section, claims, acc).dropped, 'no supported rationale');
  });
  test('a verified hazard note stands in for a missing rationale', () => {
    const page = 'Gershwin Theatre: the extreme corner seats miss some of the stage. Avoid the extreme corner seats.';
    const src = [{ url: 'https://c.example', text: page, namesTheater: true }];
    const sec = { name: 'Corners', verdict: 'skip', verdictLabel: 'Skip', hazards: [{ type: 'side-angle', note: 'x' }] };
    const rep = {
      name: { keep: true, evidence: [{ src: 1, quote: 'Avoid the extreme corner seats' }] },
      verdict: { supported: true, evidence: [{ src: 1, quote: 'Avoid the extreme corner seats' }] },
      hazards: [{ i: 0, keep: true, note: 'Corner seats miss some of the stage', evidence: [{ src: 1, quote: 'the extreme corner seats miss some of the stage' }] }],
    };
    const g = A.groundRewrite(sec, rep, src);
    const { section: out } = A.decideSection(sec, g.claims, new Map(g.claims.map((c, i) => [i + 1, true])));
    assert.strictEqual(out.rationale, 'Corner seats miss some of the stage.');
  });
  test('off-list April hazard types are mapped or dropped, never shipped', () => {
    assert.strictEqual(A.hazardType('distance'), 'distant');
    assert.strictEqual(A.hazardType('price'), null);
    assert.strictEqual(A.hazardType('pillar'), 'pillar');
  });
});

describe('model reply parsing fails closed', () => {
  test('missing claim index throws instead of reading as unsupported', () => {
    assert.throws(() => A.parseVerifyReply('{"results":[{"i":1,"supported":true}]}', 2), /missing claim 2/);
  });
  test('non-JSON throws', () => {
    assert.throws(() => A.parseJsonReply('sorry, I cannot help'), /no JSON/);
  });
});

describe('theater keep rule', () => {
  const s = (v, vp) => ({ verdict: v, isValuePick: vp });
  test('needs 3+ sections and a highlight', () => {
    assert.deepStrictEqual(A.theaterKeepProblems([s('sweet-spot'), s('solid'), s('skip')]), []);
    assert.ok(A.theaterKeepProblems([s('sweet-spot'), s('solid')]).length);
    assert.ok(A.theaterKeepProblems([s('solid'), s('solid'), s('skip')]).length);
    assert.deepStrictEqual(A.theaterKeepProblems([s('solid', true), s('solid'), s('skip')]), []);
  });
});

describe('passage selection', () => {
  test('short pages are returned whole; long pages keep the section-relevant window', () => {
    assert.strictEqual(A.selectPassages(PAGE, 'Gershwin Theatre', section), PAGE);
    const long = `${'Lorem ipsum dolor sit amet. '.repeat(800)}${PAGE}${' Footer links.'.repeat(800)}`;
    const p = A.selectPassages(long, 'Gershwin Theatre', section, 2000);
    assert.ok(p.length <= 2400);
    assert.ok(p.includes('rows F to L'));
  });
});

describe('quarterly tips prompt carries the verified sections (BRO-8018)', () => {
  test('buildPrompt includes section verdicts so bestSeats/avoidSeats cannot contradict them', () => {
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-dummy';
    const { buildPrompt } = require('../../scripts/generate-theater-tips.js');
    const p = buildPrompt('Gershwin Theatre', { structuredTips: { seating: { sections: [{ name: 'Orchestra Center', rowRange: 'F-L', verdict: 'sweet-spot', rationale: 'Best views.' }] } } }, {});
    assert.match(p, /Verified seating sections/);
    assert.match(p, /Orchestra Center \(rows F-L\): sweet-spot\. Best views\./);
    assert.doesNotMatch(buildPrompt('X Theatre', {}, {}), /Verified seating sections/);
  });
});

describe('prompt text is always well-formed UTF-16 (BRO-8018 Marquis failure)', () => {
  test('a window that splits an emoji does not leave a lone surrogate', () => {
    const bad = `Marquis Theatre ${'\uD83C'} orchestra`;
    assert.ok(!/[\uD800-\uDFFF]/.test(A.wellFormed(bad)));
    assert.strictEqual(A.wellFormed('ok 🎭 ok'), 'ok 🎭 ok');
    const long = `${'x'.repeat(599)}🎭 Marquis Theatre orchestra center best view `.repeat(40);
    const p = A.selectPassages(long, 'Marquis Theatre', { name: 'Orchestra Center' }, 3000);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify({ p })));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p));
  });
});

describe('section names lose em dashes', () => {
  test('cleanName', () => {
    assert.strictEqual(A.cleanName('Center Orchestra (front — rows C-E)'), 'Center Orchestra (front, rows C-E)');
    assert.strictEqual(A.cleanName('Box Seats — Sides'), 'Box Seats, Sides');
    assert.strictEqual(A.cleanName('Rear Mezzanine'), 'Rear Mezzanine');
  });
});

describe('rows and seat numbers in section names (BRO-8018 audit 3)', () => {
  test('seat numbers are stripped from names', () => {
    assert.strictEqual(A.stripSeatNumbers('Side Sections (100s & 200s)'), 'Side Sections');
    assert.strictEqual(A.stripSeatNumbers('Center Orchestra (Rows C-G)'), 'Center Orchestra (Rows C-G)');
  });
  test('rows in a name become a claim the verifier must accept for every row', () => {
    assert.strictEqual(A.nameRows('Center Orchestra (Rows C-S)'), 'C-S');
    assert.strictEqual(A.nameRows('Rear Mezzanine'), null);
    assert.strictEqual(A.nameRows('Side Orchestra partial-view (above Row G)'), null);
    assert.strictEqual(A.nameRows('Rear Orchestra behind Row R'), null);
    assert.match(A.nameRowsClaimText('Center Orchestra (Rows C-S)', 'sweet-spot'), /every one of rows C-S are among the best/);
    assert.strictEqual(A.nameRowsClaimText('Orchestra Center (Rows F-L)', 'sweet-spot', 'F-L'), null);
  });
  test('a rejected rows-in-name claim drops the section (Walter Kerr C-S)', () => {
    const page = 'Gershwin Theatre: rows C and D of the Center Orchestra are unparalleled. Rows E to L are very good.';
    const src = [{ url: 'https://w.example', text: page, namesTheater: true }];
    const sec = { name: 'Center Orchestra', verdict: 'sweet-spot', verdictLabel: 'Top pick' };
    const q = [{ src: 1, quote: 'rows C and D of the Center Orchestra are unparalleled' }];
    const rep = { name: { text: 'Center Orchestra (Rows C-S)', keep: true, evidence: q }, verdict: { supported: true, evidence: q }, rationale: [{ text: 'Rows C and D are the best.', evidence: q }] };
    const g = A.groundRewrite(sec, rep, src);
    const i = g.claims.findIndex((c) => c.kind === 'nameRows');
    assert.ok(i >= 0);
    const acc = new Map(g.claims.map((c, k) => [k + 1, k !== i]));
    assert.strictEqual(A.decideSection(sec, g.claims, acc).dropped, 'rows in name not supported');
    assert.ok(!A.decideSection(sec, g.claims, new Map(g.claims.map((c, k) => [k + 1, true]))).dropped);
  });
});
