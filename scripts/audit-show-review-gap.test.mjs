import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

// Same incident class as the 2026-07-14 bsc-conductor bug and the
// autonomous-run.js/autonomous-probe.js/autonomous-merge.js --help fixes
// (tasks #260/#264): scripts/audit-show-review-gap.js spawns real `gh`
// subprocesses (workflow dispatch in dispatchGatherFor, repo-variable
// read/write in the self-proving auto-enable block) with no --help guard
// (task #266). Patch child_process.execFileSync to THROW before requiring
// the module under test, so this proves zero gh (or any execFileSync) calls
// happen for --help — not just that a guard exists somewhere in the source.
const childProcess = require('node:child_process');
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = () => {
  throw new Error('execFileSync must not be called for --help');
};
let main;
let USAGE;
let acceptSerpCensusResult;
try {
  ({ main, USAGE, acceptSerpCensusResult } = require('./audit-show-review-gap.js'));
} finally {
  childProcess.execFileSync = originalExecFileSync;
}

test('USAGE documents --show, --dispatch-gather, --ingest-missing, and --help', () => {
  assert.match(USAGE, /--show=ID/);
  assert.match(USAGE, /--dispatch-gather/);
  assert.match(USAGE, /--ingest-missing/);
  assert.match(USAGE, /--help, -h/);
});

test('--help / -h / combined-with-real-action-flags exit before any execFileSync call', async () => {
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    // main() is async — await the returned promise (not just doesNotThrow on
    // the synchronous call) so a future regression that moves the
    // hasHelpFlag check after an await would surface as a rejected promise
    // here too (the stubbed execFileSync throws synchronously).
    await assert.doesNotReject(main(['--help']));
    await assert.doesNotReject(main(['-h']));
    // The actual reported risk: --help combined with a real dispatch/ingest flag.
    await assert.doesNotReject(main(['--window=21', '--dispatch-gather', '--help']));
    await assert.doesNotReject(main(['--show=some-show-2026', '--ingest-missing', '--help']));
    await assert.doesNotReject(main(['--window=21', '--dispatch-gather', '--help=1']));
  } finally {
    console.log = origLog;
  }
  assert.equal(logged.length, 5);
  for (const line of logged) assert.match(line, /audit-show-review-gap\.js — show-centric review gap audit/);
});

// Belt-and-suspenders: run the real CLI as a subprocess with `gh` stubbed on
// PATH to record any invocation and exit nonzero. If the --help guard were
// ever removed or moved after loadShows()/dispatchGatherFor, a combined
// `--dispatch-gather --help` invocation would reach the real gh call and the
// stub marker file would appear.
function withStubbedBins(names, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-show-review-gap-help-'));
  const marker = path.join(tmp, 'spawned.txt');
  for (const bin of names) {
    const binPath = path.join(tmp, bin);
    fs.writeFileSync(binPath, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 1\n`);
    fs.chmodSync(binPath, 0o755);
  }
  try {
    fn({ tmp, marker });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('node scripts/audit-show-review-gap.js --help never spawns gh (real process, PATH-stubbed)', () => {
  withStubbedBins(['gh'], ({ tmp, marker }) => {
    const script = new URL('./audit-show-review-gap.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script, '--help'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.equal(fs.existsSync(marker), false, 'gh stub must never be invoked for --help');
  });
});

test('node scripts/audit-show-review-gap.js --window=21 --dispatch-gather --help never spawns gh (real process)', () => {
  withStubbedBins(['gh'], ({ tmp, marker }) => {
    const script = new URL('./audit-show-review-gap.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [
      script, '--window=21', '--dispatch-gather', '--help',
    ], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.equal(fs.existsSync(marker), false, 'gh stub must never be invoked for --window=21 --dispatch-gather --help');
  });
});

// SERP review census (#371 — Soundsphere/JonathanBaz class): a manual
// "Trainspotting the Musical review" Google sweep surfaced 2 reviews neither
// aggregator cited. These fixtures mirror the real SERP hits that turned up —
// proving acceptSerpCensusResult would have surfaced both without depending on
// live BD/SB availability (which is a provider-outage concern, not a logic one).
const TRAINSPOTTING_SHOW = {
  id: 'trainspotting-the-musical-west-end-2026',
  title: 'Trainspotting the Musical',
  category: 'west-end',
  cast: [],
  creativeTeam: [],
};
const TRAINSPOTTING_SHOW_INFO = { title: 'Trainspotting the Musical', cast: [], creativeNames: [] };

test('acceptSerpCensusResult surfaces the Soundsphere + JonathanBaz reviews an aggregator sweep missed', () => {
  const soundsphere = {
    url: 'https://www.soundspheremag.com/reviews/live-reviews/trainspotting-the-musical-review/',
    title: 'Trainspotting the Musical review — Soundsphere Magazine',
    snippet: 'Ros Tibbs reviews Trainspotting the Musical at the Playground Theatre.',
  };
  const jonathanBaz = {
    url: 'https://jonathanbaz.com/2026/07/trainspotting-the-musical-review/',
    title: 'Trainspotting the Musical ★★★★ review',
    snippet: 'Jonathan Baz reviews the new stage adaptation of Trainspotting.',
  };
  const accepted1 = acceptSerpCensusResult(soundsphere, { show: TRAINSPOTTING_SHOW, showInfo: TRAINSPOTTING_SHOW_INFO });
  const accepted2 = acceptSerpCensusResult(jonathanBaz, { show: TRAINSPOTTING_SHOW, showInfo: TRAINSPOTTING_SHOW_INFO });
  assert.equal(accepted1, 'https://www.soundspheremag.com/reviews/live-reviews/trainspotting-the-musical-review/');
  assert.equal(accepted2, 'https://jonathanbaz.com/2026/07/trainspotting-the-musical-review/');
});

test('acceptSerpCensusResult rejects non-review and wrong-show noise from the same SERP page', () => {
  const ticketLink = {
    url: 'https://www.todaytix.com/london/shows/trainspotting-the-musical',
    title: 'Buy Trainspotting the Musical Tickets',
    snippet: 'Get tickets now.',
  };
  const wrongShow = {
    url: 'https://example.com/reviews/some-other-play-review/',
    title: 'Some Other Play review',
    snippet: 'A completely unrelated production.',
  };
  assert.equal(acceptSerpCensusResult(ticketLink, { show: TRAINSPOTTING_SHOW, showInfo: TRAINSPOTTING_SHOW_INFO }), null);
  assert.equal(acceptSerpCensusResult(wrongShow, { show: TRAINSPOTTING_SHOW, showInfo: TRAINSPOTTING_SHOW_INFO }), null);
});

test('acceptSerpCensusResult returns null for a missing/empty url', () => {
  assert.equal(acceptSerpCensusResult({ title: 'no url here' }, { show: TRAINSPOTTING_SHOW, showInfo: TRAINSPOTTING_SHOW_INFO }), null);
  assert.equal(acceptSerpCensusResult(null, { show: TRAINSPOTTING_SHOW, showInfo: TRAINSPOTTING_SHOW_INFO }), null);
});

// Ship-check 2026-07-24 (Codex adversarial review): isGenericShowTitle's raw
// word-count test misses titles that read as 2+ words but reduce to a SINGLE
// significant token via titleTokens (the token set urlMatchesShow actually
// matches on) — "Oh, Mary!" -> ['mary'], "Life of Pi" -> ['life']. Both are
// real, currently-live Broadway shows. Without the tokens.length<=1 gate,
// acceptSerpCensusResult would accept a wrong-show hit that merely mentions
// "mary"/"life" in a review URL, with no venue/cast disambiguation required.
test('acceptSerpCensusResult applies the disambiguation gate to single-token titles missed by isGenericShowTitle', () => {
  const ohMary = {
    id: 'oh-mary-2024',
    title: 'Oh, Mary!',
    category: 'broadway',
    cast: [{ name: 'Cole Escola' }],
    creativeTeam: [],
  };
  const ohMaryInfo = { title: 'Oh, Mary!', cast: [{ name: 'Cole Escola' }], creativeNames: [] };
  const wrongShowHit = {
    url: 'https://example.com/reviews/some-other-mary-play-review/',
    title: 'Some Other Mary Play review',
    snippet: 'A completely unrelated regional production about a different character.',
  };
  const realHit = {
    url: 'https://example.com/reviews/oh-mary-review/',
    title: 'Oh, Mary! starring Cole Escola review',
    snippet: 'Cole Escola is riotous in this new comedy.',
  };
  assert.equal(acceptSerpCensusResult(wrongShowHit, { show: ohMary, showInfo: ohMaryInfo }), null);
  assert.equal(acceptSerpCensusResult(realHit, { show: ohMary, showInfo: ohMaryInfo }), 'https://example.com/reviews/oh-mary-review/');
});

// ---- stale-production guard on the un-windowed naive census arm (#872) ----

const CAR_MAN_SHOW = {
  id: 'the-car-man-west-end-2026',
  title: 'The Car Man',
  category: 'off-west-end',
  previewsStartDate: '2026-07-28',
  openingDate: '2026-07-28',
  cast: [],
  creativeTeam: [],
};
const CAR_MAN_INFO = { title: 'The Car Man', cast: [], creativeNames: [] };

test('acceptSerpCensusResult rejects a prior-production URL whose path year predates this run', () => {
  const old2015 = {
    url: 'https://theidlewoman.net/2015/07/29/the-car-man-matthew-bourne/',
    title: 'The Car Man — Matthew Bourne',
    snippet: 'Sadler’s Wells, 2015.',
  };
  assert.equal(acceptSerpCensusResult(old2015, { show: CAR_MAN_SHOW, showInfo: CAR_MAN_INFO }), null);
});

test('acceptSerpCensusResult keeps a current-run URL and one with no year in the path', () => {
  const current = {
    url: 'https://jadar.uk/2026/07/31/review-matthew-bournes-the-car-man/',
    title: 'Review: Matthew Bourne’s The Car Man',
    snippet: 'Sadler’s Wells.',
  };
  const undated = {
    url: 'https://www.cheekylittlematinee.com/post/the-car-man-matthew-bourne-review',
    title: 'The Car Man review',
    snippet: 'Matthew Bourne at Sadler’s Wells.',
  };
  assert.ok(acceptSerpCensusResult(current, { show: CAR_MAN_SHOW, showInfo: CAR_MAN_INFO }));
  assert.ok(acceptSerpCensusResult(undated, { show: CAR_MAN_SHOW, showInfo: CAR_MAN_INFO }));
});

test('acceptSerpCensusResult keeps an older URL when priorRuns declares that year', () => {
  const withPrior = { ...CAR_MAN_SHOW, priorRuns: [{ openingDate: '2015-07-01', closingDate: '2015-08-09' }] };
  const old2015 = {
    url: 'https://theidlewoman.net/2015/07/29/the-car-man-matthew-bourne/',
    title: 'The Car Man — Matthew Bourne',
    snippet: 'Sadler’s Wells, 2015.',
  };
  assert.ok(acceptSerpCensusResult(old2015, { show: withPrior, showInfo: CAR_MAN_INFO }));
});

test('acceptSerpCensusResult drops the ticketing/listings layer the deep-page arm reaches', () => {
  for (const url of [
    'https://seatplan.com/london/the-car-man-tickets/',
    'https://www.lovetovisit.com/uk-attractions/sadlers-wells/the-car-man',
    'https://officiallondontheatre.com/show/the-car-man-111473280/',
    'https://en.wikipedia.org/wiki/The_Car_Man_(Bourne)',
  ]) {
    assert.equal(
      acceptSerpCensusResult({ url, title: 'The Car Man', snippet: '' }, { show: CAR_MAN_SHOW, showInfo: CAR_MAN_INFO }),
      null,
      `expected ${url} to be rejected`,
    );
  }
});

test('stale-year guard and the priorRuns readmission read the SAME year delimiters', () => {
  // Slug-style permalinks put the year between dashes, not slashes. If the
  // guard's regex is wider than isUrlYearInPriorRun's, a declared prior run's
  // dash-form reviews get dropped with no way back (ship-check 2026-08-02).
  const dashOld = { url: 'https://example.com/2015-the-car-man-review/', title: 'The Car Man review', snippet: '' };
  assert.equal(acceptSerpCensusResult(dashOld, { show: CAR_MAN_SHOW, showInfo: CAR_MAN_INFO }), null);

  const withPrior = { ...CAR_MAN_SHOW, priorRuns: [{ openingDate: '2015-07-01', closingDate: '2015-08-09' }] };
  assert.ok(acceptSerpCensusResult(dashOld, { show: withPrior, showInfo: CAR_MAN_INFO }));
});

// computeResidualCounts — the residual ::warning:: math (OWE opening audit
// 2026-08-06). Each invariant here maps to a live chronic-alarm incident;
// see the function's header comment.
test('computeResidualCounts: prior-run entries never count as residual', () => {
  const { computeResidualCounts } = require('./audit-show-review-gap.js');
  // Cats shape: 46 prior-run missing + 62 prior-run flagged + 3 real missing + 5 real flagged.
  const r = {
    missing: [...Array.from({ length: 46 }, () => ({ priorRun: true })), {}, {}, {}],
    flaggedMisses: [...Array.from({ length: 62 }, () => ({ priorRun: true })), {}, {}, {}, {}, {}],
    citedNoUrl: [],
  };
  const c = computeResidualCounts(r, false);
  assert.equal(c.uningested, 3);
  assert.equal(c.flaggedOut, 5);
  assert.equal(c.residual, 8);
});

test('computeResidualCounts: noop ingests are visible but never alarm', () => {
  const { computeResidualCounts } = require('./audit-show-review-gap.js');
  // A cross-show-owned URL no-ops on every hourly --ingest-missing run (the
  // 2016 WSJ Cats case). It must not keep the show in the residual warning.
  const r = {
    missing: [{}],
    flaggedMisses: [],
    citedNoUrl: [],
    ingestResults: [
      { ok: false, noop: true, reason: 'ingest no-op' },
      { ok: false, reason: 'fetch failed' },
      { ok: true },
    ],
  };
  const c = computeResidualCounts(r, true);
  assert.equal(c.noopIngest, 1);
  assert.equal(c.failedIngest, 1); // only the real failure
  assert.equal(c.uningested, 0);   // ingestMissing ran
  assert.equal(c.residual, 1);
});

test('computeResidualCounts: cited recoveries subtract from flaggedOut, uncited do not', () => {
  const { computeResidualCounts } = require('./audit-show-review-gap.js');
  const r = {
    missing: [],
    flaggedMisses: [{}, {}],
    citedNoUrl: [],
    recoveryResults: [{ recovered: true }, { recovered: true, uncited: true }],
  };
  const c = computeResidualCounts(r, false);
  assert.equal(c.recovered, 1);
  assert.equal(c.flaggedOut, 1);
});

// ── ship-check 2026-08-09, finding B ─────────────────────────────────────────
// An unrecognised skip reason was counted and then dropped on the floor:
// unclassifiedIngest never entered `residual`, and its warning printed only
// inside `if (residualShows.length > 0)`. A run whose ONLY problem was contract
// drift with review-file-writer.js therefore said nothing at all — the module
// built to stop silent skips had a silent skip in its own reporting.
test('computeResidualCounts: an unclassified skip reason IS residual — it can never be silent', () => {
  const { computeResidualCounts } = require('./audit-show-review-gap.js');
  const r = {
    missing: [],
    flaggedMisses: [],
    citedNoUrl: [],
    // Nothing else wrong: no failures, no uningested, no flagged. If
    // unclassified did not count, residual would be 0 and the run would print
    // nothing about a brand-new skip reason.
    ingestResults: [{ ok: false, noop: true, unclassified: true, unclassifiedReason: 'some-future-reason' }],
  };
  const c = computeResidualCounts(r, true);
  assert.equal(c.unclassifiedIngest, 1);
  assert.ok(c.residual >= 1, 'contract drift must make the run non-silent');
});

// ── ship-check 2026-08-09, finding C ─────────────────────────────────────────
// A cross-market refusal is correct and permanent. Counting it as a conflict
// re-armed the chronic hourly alarm the 2026-08-06 ship-check removed: every
// show with one legitimately-refused review would warn forever, with no action
// available to clear it.
test('computeResidualCounts: an expected rejection is counted but NOT residual', () => {
  const { computeResidualCounts } = require('./audit-show-review-gap.js');
  const r = {
    missing: [],
    flaggedMisses: [],
    citedNoUrl: [],
    ingestResults: [
      { ok: false, noop: true, expected: true, expectedReason: 'cross-market' },
      { ok: false, noop: true, expected: true, expectedReason: 'empty-unknown' },
    ],
  };
  const c = computeResidualCounts(r, true);
  assert.equal(c.expectedIngest, 2, 'still counted, so a spike is visible');
  assert.equal(c.residual, 0, 'a permanently-correct refusal must never read as an unresolved gap');
});

test('computeResidualCounts: a conflict IS residual — it stays loud until resolved', () => {
  const { computeResidualCounts } = require('./audit-show-review-gap.js');
  const r = {
    missing: [],
    flaggedMisses: [],
    citedNoUrl: [],
    ingestResults: [{ ok: false, noop: true, conflict: true, conflictReason: 'cross-show-url-owned' }],
  };
  const c = computeResidualCounts(r, true);
  assert.equal(c.conflictIngest, 1);
  assert.equal(c.residual, 1);
});
