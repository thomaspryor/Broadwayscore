// Ground-truth scoring for recoupment-model changes (BRO-5002). require()s the
// real helpers (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { groundTruth, creditBasis, eitherBasis, basisLine, rangeError, category, summarize, worseGroups, truthTier, truthRows, newFalseRecouped, advisoryLine, formatMarkdown } = require('../../scripts/lib/recoupment-ground-truth');

const closed = { closingDate: '2020-01-01', openingDate: '2019-01-01', type: 'musical' };

// Checker 2026-10-10: only trade, producer, SEC or NYT/Deadline/Variety/
// Broadway Journal statements are truth; the strings are real source texts.
describe('truthClass', () => {
  const cls = (comm, show = closed) => groundTruth(comm, show).truthClass;
  const pct = (src) => ({ estimatedRecoupmentPct: [10, 20], estimatedRecoupmentSource: src });
  test('Reddit, deep research and our own arithmetic are inference', () => {
    for (const src of [
      "Section C: Reddit Grosses Analysis post states 'recoup=60-60%'",
      'Deep Research: 0% investor recovery per lawsuit filings',
      "GPT DR: 'Nearly total loss for investors (0-10% returned).'",
      'Low end: ~5% from operating profit alone ($6.97M gross over 15 weeks).',
      'Section C: Grosses Analysis Post confirms 10-20% recoupment estimate',
    ]) assert.equal(cls(pct(src)), 'inference', src);
  });
  test('a trade or producer statement is reported, even inside long notes', () => {
    assert.equal(cls(pct("Deadline: producers said the show lost 90% of its capitalization.")), 'reported');
    assert.equal(cls({ estimatedRecoupmentPct: [55, 65], notes: '$15M capitalization. Producer J.J. Powell confirmed $6M loss (~40% of cap). Lloyd likely recouped via royalties.' }), 'reported');
  });
  test('a range from a source that states no figure is our inference (BRO-5073)', () => {
    const t = groundTruth(pct("Deadline: 'among this season's largest investment losses.' Grossed below nut nearly every week."), closed);
    assert.deepEqual([t.kind, t.truthClass, t.truthClassFrom], ['reported-pct', 'inference', 'no-stated-figure']);
    assert.equal(cls({ estimatedRecoupmentPct: [10, 20], notes: "Weekly nut ~$500K. NYT: 'has not recouped those costs, but with the help of a New York state tax credit will get part way there.'" }), 'inference');
    assert.equal(cls(pct('Daily Mail (Aug 2025): producer JJ Powell said it lost $6 million.')), 'reported');
  });
  test('an admission that nobody announced it is inference wherever it sits', () => {
    assert.equal(cls({ recouped: true, recoupedSource: 'Disney does not announce recoupments. Grosses passed $561M (Broadway Journal).' }), 'inference');
    assert.equal(cls({ recouped: true, recoupedSource: 'No producer announcement. Broadway Journal (Aug 2023) projected recoupment by fall.' }), 'inference');
  });
  test('an estimated date beside a reported recoupment stays reported', () => {
    assert.equal(cls({ recouped: true, recoupedSource: 'New York Theatre Guide: earned back its cost "faster than any other musical in history." No public report gives the date; March 1997 is our estimate.' }), 'reported');
  });
  test('a failed row is reported only when a hard source states the loss', () => {
    const flop = (notes, types = ['trade', 'sec']) => ({ recouped: false, designation: 'Flop', notes, sources: types.map((type) => ({ type })) });
    assert.equal(cls(flop("NYT article explicitly stated show 'will not recoup its producers' $15 million investment'")), 'reported');
    assert.equal(cls(flop('Closed without recouping its $19.5M capitalization (Broadway Journal).')), 'reported');
    assert.equal(cls(flop('Forbes reported it among shows with major losses.')), 'reported');
    // A cited capitalization is not a cited outcome, whatever the source types.
    assert.equal(cls(flop('$25M capitalization per SEC filing. Closed after 3 months.')), 'inference');
    assert.equal(cls(flop('Closed without recouping (Reddit grosses analysis).')), 'inference');
    assert.equal(cls(flop('Likely lost most of its money.')), 'inference');
    assert.equal(cls(flop(undefined)), 'inference');
  });
  test('an explicit field on the record wins over the classifier', () => {
    const t = groundTruth({ ...pct('Reddit grosses analysis'), estimatedRecoupmentTruthClass: 'reported' }, closed);
    assert.deepEqual([t.truthClass, t.truthClassFrom], ['reported', 'field']);
    assert.equal(cls({ recouped: true, recoupedSource: 'Variety', recoupedTruthClass: 'inference' }), 'inference');
    assert.equal(cls({ recouped: false, designation: 'Flop', sources: [{ type: 'trade' }], designationTruthClass: 'inference' }), 'inference');
  });
});

describe('groundTruth', () => {
  // BRO-5264: Just in Time held a Reddit % and a Broadway News recoupment; the Reddit % won.
  test('a reported claim beats an earlier inference claim; with none reported the first stands', () => {
    const show = { closingDate: '2026-02-22', openingDate: '2025-04-01', type: 'musical' };
    const reddit = { estimatedRecoupmentPct: [60, 60], estimatedRecoupmentSource: 'Reddit Grosses Analysis post states recoup=60%' };
    const t = groundTruth({ ...reddit, recouped: true, recoupedSource: 'Broadway News (May 18, 2026): the show has officially recouped its $12.5 million capitalization' }, show);
    assert.equal(t.kind, 'recouped');
    assert.equal(t.truthClass, 'reported');
    const failed = groundTruth({ ...reddit, recouped: false, designation: 'Fizzle', notes: 'Variety reported the show closed without recouping.' }, show);
    assert.equal(failed.kind, 'failed');
    assert.equal(failed.truthClass, 'reported');
    // No reported claim: the Reddit % stays, as inference.
    const only = groundTruth({ ...reddit, recouped: false, designation: 'Fizzle', notes: 'Closed early.' }, show);
    assert.equal(only.kind, 'reported-pct');
    assert.equal(only.truthClass, 'inference');
  });
  test('recouped after closing with tour profits is not a test of the Broadway model (BRO-5073)', () => {
    const show = { closingDate: '2024-04-28' };
    const comm = { recouped: true, recoupedDate: '2026-04', recoupedSource: 'Playbill (Apr 23, 2026): "Both the Broadway production and the national tour have now recouped their investments"' };
    assert.equal(groundTruth(comm, show), null);
    // after closing with a tax credit, no tour: still a test
    assert.equal(groundTruth({ ...comm, recoupedDate: '2026-06', recoupedSource: 'Deadline (Jun 2026): recouped its $5.25M capitalization nine months after closing' }, show).kind, 'recouped');
    // a tour mentioned on a show that recouped while running: still a test
    assert.equal(groundTruth({ ...comm, recoupedDate: '2023-05' }, show).kind, 'recouped');
  });
  test('a reported range counts; our own inference does not', () => {
    assert.deepEqual(
      groundTruth({ estimatedRecoupmentPct: [20, 10], estimatedRecoupmentSource: 'NYT: returned about 15% of its investment' }, closed),
      { kind: 'reported-pct', lo: 10, hi: 20, source: 'NYT: returned about 15% of its investment', truthClass: 'reported', truthClassFrom: 'source-text', creditBasis: 'pre-credit' },
    );
    assert.equal(groundTruth({ estimatedRecoupmentPct: [30, 45], estimatedRecoupmentSource: 'Inferred: ~9 months run' }, {}), null);
    assert.equal(groundTruth({ estimatedRecoupmentPct: [30, 45], notes: 'Estimated: weekly profit x weeks' }, {}), null);
  });
  test('carries a dated report as asOf (for --as-of-report)', () => {
    const c = { estimatedRecoupmentPct: [10, 30], estimatedRecoupmentSource: 'Reddit grosses analysis' };
    assert.equal(groundTruth({ ...c, estimatedRecoupmentDate: '2026-02-18' }, closed).asOf, '2026-02-18');
    assert.equal('asOf' in groundTruth({ ...c, estimatedRecoupmentDate: 'Feb 2026' }, closed), false);
  });
  test('falls back to notes for the basis', () => {
    assert.equal(groundTruth({ estimatedRecoupmentPct: [10, 20], notes: 'Produced by X; NYT says part way' }, closed).kind, 'reported-pct');
  });
  test('cited recoupment is >= 100; an uncited one is not truth', () => {
    assert.deepEqual(groundTruth({ recouped: true, recoupedSource: 'Variety' }, {}).lo, 100);
    assert.equal(groundTruth({ recouped: true }, {}), null);
  });
  test('failed needs closed + not recouped + Fizzle/Flop', () => {
    assert.equal(groundTruth({ recouped: false, designation: 'Flop' }, closed).kind, 'failed');
    assert.equal(groundTruth({ recouped: false, designation: 'Flop' }, { closingDate: '2999-01-01' }), null);
    assert.equal(groundTruth({ recouped: false, designation: 'TBD' }, closed), null);
  });
});

describe('scoring', () => {
  test('rangeError is 0 inside, distance outside', () => {
    const t = { lo: 10, hi: 20 };
    assert.equal(rangeError(15, t), 0);
    assert.equal(rangeError(-5, t), 15);
    assert.equal(rangeError(30, t), 10);
    assert.equal(rangeError(250, { lo: 100, hi: Infinity }), 0);
    assert.equal(rangeError(null, t), null);
  });
  test('category splits type and era', () => {
    assert.deepEqual(category({ type: 'play', openingDate: '2019-05-01' }), { type: 'play', era: 'pre-2020' });
    assert.deepEqual(category({ type: 'musical', openingDate: '2024-05-01' }), { type: 'musical', era: '2020+' });
  });
  test('summarize and worseGroups flag fewer-inside even when mean error improves', () => {
    const rows = [
      { kind: 'failed', type: 'play', era: 'pre-2020', oldErr: 0, newErr: 2 },
      { kind: 'reported-pct', type: 'musical', era: '2020+', oldErr: 30, newErr: 10 },
      { kind: 'reported-pct', type: 'musical', era: '2020+', oldErr: 0, newErr: 0 },
    ];
    const s = summarize(rows);
    assert.equal(s.all.n, 3);
    assert.equal(s.all.oldMae, 10);
    assert.equal(s.all.newMae, 4);
    assert.equal(s['kind:reported-pct'].newMedian, 5);
    // all: mean 10 -> 4 but inside 2 -> 1, so it counts as worse too.
    assert.deepEqual(worseGroups(s).sort(), ['all', 'era:pre-2020', 'kind:failed', 'type:play']);
    // minN: one-row groups are not gated.
    assert.deepEqual(worseGroups(s, { minN: 2 }).sort(), ['all']);
  });
  // BRO-5311: the inference % a reported claim displaced is still scored, as advisory.
  test('truthRows adds the displaced inference % as an advisory row, under --truth=reported and all', () => {
    const show = { closingDate: '2026-02-22', openingDate: '2025-04-01', type: 'musical' };
    const comm = { estimatedRecoupmentPct: [10, 20], estimatedRecoupmentSource: 'Reddit Grosses Analysis post states recoup=10-20%', recouped: false, designation: 'Fizzle', notes: 'Variety reported the show closed without recouping.' };
    const rows = truthRows(comm, show, 'reported');
    assert.deepEqual(rows.map((r) => [r.truth.kind, r.tier, !!r.superseded]), [['failed', 'gate', false], ['reported-pct', 'advisory', true]]);
    assert.deepEqual(rows[1].truth.lo, 10);
    assert.deepEqual(truthRows(comm, show, 'all').map((r) => [r.truth.kind, r.tier, !!r.superseded]), [['failed', 'gate', false], ['reported-pct', 'advisory', true]]);
    // An inference-only record: one advisory row, nothing extra.
    assert.deepEqual(truthRows({ ...comm, notes: 'Closed early.' }, show, 'reported').map((r) => [r.truth.kind, r.tier]), [['reported-pct', 'advisory']]);
    assert.deepEqual(truthRows(null, show, 'reported'), []);
  });
  // Checker 2026-10-10: inference truth never reaches the gating rows under the default.
  test('truthTier keeps inference rows off the gate unless --truth=all', () => {
    assert.equal(truthTier(null, 'reported'), null);
    assert.equal(truthTier({ truthClass: 'reported' }, 'reported'), 'gate');
    for (const truthClass of ['inference']) {
      assert.equal(truthTier({ truthClass }, 'reported'), 'advisory', truthClass);
      assert.equal(truthTier({ truthClass }, 'all'), 'gate', truthClass);
    }
  });
  test('newFalseRecouped counts only rows the new side newly puts at 100%+ against a never-recouped truth', () => {
    const rows = [
      { truth: [0, 60], oldPct: 40, newPct: 120 },
      { truth: [0, 60], oldPct: 110, newPct: 120 },
      { truth: [100, 100], oldPct: 40, newPct: 120 },
      { truth: [0, 60], oldPct: 40, newPct: 99 },
    ];
    assert.deepEqual(newFalseRecouped(rows), [rows[0]]);
  });
  // Owner 2026-10-13: Reddit/AI rows get their own line, labeled as not counted.
  test('advisoryLine reports the inference tier with its own worse groups and false recouped', () => {
    assert.match(advisoryLine([]), /not counted toward pass or fail\): none scored$/);
    const rows = [
      { kind: 'failed', type: 'musical', era: '2020+', truth: [0, 60], oldPct: 40, newPct: 120, oldErr: 0, newErr: 60 },
      { kind: 'reported-pct', type: 'musical', era: '2020+', truth: [80, 90], oldPct: 85, newPct: 85, oldErr: 0, newErr: 0 },
      // Already at 100%+ on the old side: not a new false recouped.
      { kind: 'failed', type: 'play', era: 'pre-2020', truth: [0, 50], oldPct: 110, newPct: 115, oldErr: 60, newErr: 65 },
    ];
    const line = advisoryLine(rows);
    assert.match(line, /^Advisory, inference truth rows: .*\(not counted toward pass or fail\): 3 rows/);
    assert.match(line, /inside 2 -> 1/);
    assert.match(line, /new false recouped 1$/);
    assert.match(line, /worse in all, kind:failed/);
    // minN keeps one-row groups out of the worse list, as on the reported tier.
    assert.doesNotMatch(advisoryLine(rows, { minN: 2 }), /type:play/);
  });
});

describe('formatMarkdown', () => {
  const row = (slug, oldErr, newErr) => ({ slug, kind: 'recouped', type: 'musical', era: '2020+', truth: [100, Infinity], oldPct: 100 - oldErr, newPct: 100 - newErr, oldErr, newErr });
  test('group table, moved rows by size of change, worse line', () => {
    const rows = [row('a', 10, 2), row('b', 5, 5), row('c', 0, 30)];
    const md = formatMarkdown({ title: 'T', summary: summarize(rows), rows, worse: ['all'] });
    assert.match(md, /^### T/);
    assert.match(md, /\| all \| 3 \| 5 \| 12\.3 \|/);
    assert.match(md, /Error changed on 2:/);
    assert.ok(md.indexOf('| c |') < md.indexOf('| a |'), 'biggest move first');
    assert.ok(!md.includes('| b |'), 'unmoved row not listed');
    assert.match(md, /\| c \| recouped \| 100\.\.\+inf \| 100 \| 70 \| 0 \| 30 \|/);
    assert.match(md, /\*\*Worse in:\*\* all/);
  });
  test('nothing moved', () => {
    const rows = [row('b', 5, 5)];
    const md = formatMarkdown({ title: 'T', summary: summarize(rows), rows, worse: [] });
    assert.match(md, /No row moved\./);
    assert.match(md, /No group got worse\./);
  });
});

test('creditBasis: post-credit only for a credit already in the figure (BRO-5073)', () => {
  assert.equal(creditBasis({}, 'Playbill: recouped months after closing, from operating profit plus the NY State Broadway tax credit'), 'post-credit');
  assert.equal(creditBasis({}, 'Eligible for $3M tax credit (would reduce net loss to ~$3M)'), 'pre-credit');
  assert.equal(creditBasis({}, 'High end: ~65% if NY State tax credit is received'), 'pre-credit');
  assert.equal(creditBasis({}, 'Broadway News: recouped its $6.75M capitalization'), 'pre-credit');
  assert.equal(creditBasis({ taxCreditBasis: 'post-credit' }, 'no mention'), 'post-credit');
  // Decimal amounts stay inside the clause; negations and future credits are pre.
  assert.equal(creditBasis({}, 'recouped from profit plus a $2.5M NY State tax credit'), 'post-credit');
  assert.equal(creditBasis({}, 'returned 60% including the $1.75M tax credit'), 'post-credit');
  assert.equal(creditBasis({}, 'recouped, not including the tax credit'), 'pre-credit');
  assert.equal(creditBasis({}, 'Recouped after a strong holiday season, the NY tax credit to follow'), 'pre-credit');
  // A recoupment that does not say is unstated; an amount returned stays pre-credit.
  assert.equal(groundTruth({ recouped: true, recoupedSource: 'Deadline: recouped' }, {}).creditBasis, 'unstated');
  assert.equal(creditBasis({}, 'Broadway News: recouped its $6.75M capitalization', 'recouped'), 'unstated');
  assert.equal(creditBasis({}, 'Playbill: recouped from operating profit plus the NY State tax credit', 'recouped'), 'post-credit');
});

test('eitherBasis scores an unstated row on the side that fits (BRO-5073)', () => {
  assert.deepEqual(eitherBasis({ v: 55, err: 30 }, { v: 99, err: 0 }), { v: 99, err: 0, usedPost: true });
  assert.deepEqual(eitherBasis({ v: 90, err: 0 }, { v: 120, err: 5 }), { v: 90, err: 0, usedPost: false });
  assert.equal(eitherBasis({ err: 0 }, { err: 0 }).usedPost, false, 'pre on a tie');
  assert.equal(basisLine([{ creditBasis: 'pre-credit' }, { creditBasis: 'unstated', usedPost: true }, { creditBasis: 'unstated', usedPost: false }]),
    'Credit basis: 1 pre-credit, 0 post-credit, 2 unstated (1 scored on the post-credit side)');
});
