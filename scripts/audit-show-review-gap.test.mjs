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

// BRO-4540: "A Thousand Natural Shocks" (Headwall, LIC) census accepted a
// different play ("Natural Shocks") and novel pages because urlMatchesShow
// tolerates one missing token on 3+ token titles.
test('acceptSerpCensusResult rejects different works sharing most title tokens (BRO-4540)', () => {
  const show = { id: 'a-thousand-natural-shocks-off-broadway-2026', title: 'A Thousand Natural Shocks' };
  const info = { creativeNames: [] };
  const acc = (url, title = '') => acceptSerpCensusResult({ url, title, snippet: '' }, { show, showInfo: info });
  assert.equal(acc('https://exeuntnyc.com/reviews/review-natural-shocks-wp-theater/', 'Review: Natural Shocks'), null);
  assert.equal(acc('https://www.theaterscene.net/plays/solo-plays/natural-shocks/victor-gluck/'), null);
  assert.equal(acc('https://reactormag.com/book-review-a-thousand-natural-shocks-by-omar-hussain/'), null);
  assert.equal(acc('https://www.amazon.com/Thousand-Natural-Shocks-Omar-Hussain/dp/B0DJG1P9GY'), null);
  assert.ok(acc('https://www.example-theater-blog.com/review-a-thousand-natural-shocks-secret-theatre/'), 'real review still accepted');
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

// ---- BRO-4765: terminal "unextractable" state for 0-char aggregator URLs ----
const {
  MIN_STREAK_SPAN_MS, ZERO_CHAR_CAP, RETRY_AFTER_DAYS, isZeroCharFailure, partitionUnextractable, updateZeroCharCounts,
} = require('./lib/gap-unextractable.js');
const { censusVerdictFor: censusVerdictForUnx } = require('./lib/gap-audit-merge.js');

const ZERO_CHAR = { ok: false, noop: false, reason: 'Article extraction returned 0 chars — pattern may be missing for this outlet.' };
const NEWS_URL = 'https://www.theatermania.com/news/daniel-fish-will-return-to-st-anns-warehouse-with-kramer-fauci_1843069/';
const T0 = Date.parse('2026-10-05T12:00:00Z');
// Runs are 13h apart (the first and last of three span 26h), so the 24h floor is met by ZERO_CHAR_CAP runs.
const GAP_MS = 13 * 3600000;
const runs = (stored, n, res = ZERO_CHAR, url = NEWS_URL, start = T0) => {
  let s = stored;
  for (let i = 0; i < n; i++) s = updateZeroCharCounts(s, [{ url, ...res }], start + i * GAP_MS);
  return s;
};

test('isZeroCharFailure: only a plain 0-char extraction failure counts', () => {
  assert.equal(isZeroCharFailure(ZERO_CHAR), true);
  assert.equal(isZeroCharFailure({ ok: false, reason: 'Command failed: timeout' }), false);
  assert.equal(isZeroCharFailure({ ok: true, reason: null }), false);
  assert.equal(isZeroCharFailure({ ok: false, noop: true, reason: 'Article extraction returned 0 chars' }), false);
  assert.equal(isZeroCharFailure(null), false);
});

test('a URL turns terminal after exactly N consecutive 0-char results, not before', () => {
  const missing = [{ url: NEWS_URL, host: 'theatermania.com', knownOutletId: 'theatermania' }];
  for (let n = 0; n < ZERO_CHAR_CAP; n++) {
    const p = partitionUnextractable(missing, runs({}, n), T0 + 50 * 3600000);
    assert.equal(p.missing.length, 1, `${n} failures: still attempted`);
  }
  const p = partitionUnextractable(missing, runs({}, ZERO_CHAR_CAP), T0 + 50 * 3600000);
  assert.equal(p.missing.length, 0);
  assert.equal(p.unextractable.length, 1);
  assert.equal(p.unextractable[0].url, NEWS_URL);
  assert.equal(p.unextractable[0].zeroCharAttempts, ZERO_CHAR_CAP);
});

test('hourly runs cannot make a URL terminal inside 24h, however many fail', () => {
  let s = {};
  for (let i = 0; i < 10; i++) s = updateZeroCharCounts(s, [{ url: NEWS_URL, ...ZERO_CHAR }], T0 + i * 3600000);
  assert.equal(s[NEWS_URL].n, 10);
  assert.equal(partitionUnextractable([{ url: NEWS_URL }], s, T0 + 10 * 3600000).unextractable.length, 0, '10 failures in 10h: still retried');
  s = updateZeroCharCounts(s, [{ url: NEWS_URL, ...ZERO_CHAR }], T0 + MIN_STREAK_SPAN_MS + 1000);
  assert.equal(partitionUnextractable([{ url: NEWS_URL }], s, T0 + MIN_STREAK_SPAN_MS + 2000).unextractable.length, 1, 'a failure 24h after the first goes terminal');
});

test('the zeroChar flag from the child output counts even when the truncated reason lost the line', () => {
  const truncated = { ok: false, noop: false, zeroChar: true, reason: 'Command failed: node scripts/ingest-review-from-url.js ... [warn] provisional outlet "x" resolved from host (no regis' };
  assert.equal(isZeroCharFailure(truncated), true);
  assert.equal(isZeroCharFailure({ ...truncated, zeroChar: false }), false);
});

test('a different failure or a success resets the streak, so a flaky fetch never goes terminal', () => {
  let s = runs({}, ZERO_CHAR_CAP - 1);
  s = updateZeroCharCounts(s, [{ url: NEWS_URL, ok: false, reason: 'Command failed: timed out' }], T0 + 5 * GAP_MS);
  assert.equal(s[NEWS_URL], undefined);
  s = runs(s, ZERO_CHAR_CAP - 1, ZERO_CHAR, NEWS_URL, T0 + 6 * GAP_MS);
  assert.equal(partitionUnextractable([{ url: NEWS_URL }], s, T0 + 60 * GAP_MS).unextractable.length, 0);
});

test('URLs not attempted this run keep their streak; streaks are per URL', () => {
  const other = 'https://example.com/other';
  let s = runs({}, 2);
  s = updateZeroCharCounts(s, [{ url: other, ...ZERO_CHAR }], T0 + 5 * GAP_MS);
  assert.equal(s[NEWS_URL].n, 2);
  assert.equal(s[other].n, 1);
});

test('a terminal URL gets one retry after the window; a 0-char result sends it straight back to terminal', () => {
  const s = runs({}, ZERO_CHAR_CAP);
  const later = T0 + (RETRY_AFTER_DAYS + 3) * 86400000;
  assert.equal(partitionUnextractable([{ url: NEWS_URL }], s, later).missing.length, 1, 'retry window opens');
  const again = updateZeroCharCounts(s, [{ url: NEWS_URL, ...ZERO_CHAR }], later);
  assert.equal(partitionUnextractable([{ url: NEWS_URL }], again, later + 1000).unextractable.length, 1);
});

test('a show whose only blocker is an unextractable URL is no longer held incomplete, and is not read as covered', () => {
  const base = {
    showId: 'kramerfauci-st-anns-off-broadway-2026', title: 'Kramer Fauci', openingDate: '2026-09-01',
    aggregatorArticles: ['https://www.broadwayworld.com/article/Review-Roundup-Kramer-Fauci'],
    aggregatorListedUrls: [NEWS_URL, 'https://www.nytimes.com/2026/09/10/theater/kramer-fauci-review.html'],
    flaggedMisses: [], citedNoUrl: [],
  };
  const NOW = '2026-10-05T12:00:00.000Z';
  const held = censusVerdictForUnx({ ...base, missing: [{ url: NEWS_URL, host: 'theatermania.com', knownOutletId: 'theatermania' }] }, { now: NOW });
  assert.equal(held.verdict, 'incomplete');
  const released = censusVerdictForUnx({
    ...base, missing: [],
    unextractable: [{ url: NEWS_URL, host: 'theatermania.com', knownOutletId: 'theatermania', zeroCharAttempts: 3 }],
  }, { now: NOW });
  assert.notEqual(released.verdict, 'incomplete');
  assert.ok(!released.candidates.some((c) => c.url === NEWS_URL), 'dropped from the census');
  assert.ok(!released.candidates.some((c) => c.outletId === 'theatermania' && c.state === 'live'), 'never counted as a live/covered outlet');
  // Without the skip the URL would read as covered (listed, not missing): prove the unextractable list is what prevents it.
  const vacuous = censusVerdictForUnx({ ...base, missing: [] }, { now: NOW });
  assert.ok(vacuous.candidates.some((c) => c.url === NEWS_URL && c.state === 'live'), 'control: with no unextractable list the URL reads as covered');
});

// BRO-4190: the SERP census counted the 2024 Hampstead Theatre (London)
// reviews as "missing" for the 2026 Off-Broadway Invention of Love.
test('acceptSerpCensusResult drops another production named by a London house or Time Out edition', () => {
  const { otherProductionUrlSignal } = require('./audit-show-review-gap.js');
  const show = { id: 'the-invention-of-love-off-broadway-2026', title: 'The Invention of Love', category: 'off-broadway', venue: 'Theaterlab', openingDate: '2026-09-21' };
  const info = { title: show.title, cast: [], creativeNames: [] };
  const hampstead = { url: 'https://www.londontheatre.co.uk/reviews/the-invention-of-love-review-hampstead-theatre', title: 'The Invention of Love review' };
  const timeoutLondon = { url: 'https://www.timeout.com/london/theatre/the-invention-of-love-review', title: 'The Invention of Love review' };
  const titleOnly = { url: 'https://www.telegraph.co.uk/theatre/what-to-see/the-invention-of-love-review/', title: 'The Invention of Love, Hampstead Theatre review' };
  const nyc = { url: 'https://www.nytimes.com/2026/09/22/theater/the-invention-of-love-review.html', title: 'The Invention of Love review: Stoppard at Theaterlab' };
  assert.equal(acceptSerpCensusResult(hampstead, { show, showInfo: info }), null);
  assert.equal(acceptSerpCensusResult(timeoutLondon, { show, showInfo: info }), null);
  assert.equal(acceptSerpCensusResult(titleOnly, { show, showInfo: info }), null);
  assert.ok(acceptSerpCensusResult(nyc, { show, showInfo: info }));
  // A National Theatre or RSC production transferring to New York names the
  // company in its own reviews: not evidence of another production.
  const hamlet = { id: 'hamlet-off-broadway-2026', title: 'Hamlet', category: 'off-broadway', venue: 'BAM Harvey Theater', openingDate: '2026-05-01' };
  assert.equal(otherProductionUrlSignal('https://www.theatermania.com/news/review-ophelia-steals-the-show-in-the-national-theatres-out-of-joint-hamlet_1835514/', hamlet), null);
  // A New York review of a London transfer names the house it came from.
  const ferryman = { id: 'the-ferryman-2018', title: 'The Ferryman', category: 'broadway', venue: 'Bernard B. Jacobs Theatre', openingDate: '2018-10-21' };
  assert.equal(otherProductionUrlSignal('https://www.nytimes.com/2018/10/21/theater/the-ferryman-review.html', ferryman, 'Review: The Ferryman, the Royal Court hit, arrives on Broadway'), null);
  assert.equal(otherProductionUrlSignal('https://www.theatermania.com/news/review-the-ferryman-royal-court-transfer_1234/', ferryman), null);
  // A declared prior run (here in London) makes the house name expected.
  const withRun = { ...show, priorRuns: [{ venue: 'Hampstead Theatre', startDate: '2024-01-01', endDate: '2024-02-01' }] };
  assert.equal(otherProductionUrlSignal(hampstead.url, withRun), null);
  // West End shows are out of scope for the London-house signal.
  const we = { id: 'darkling-off-west-end-2026', title: 'Darkling', category: 'off-west-end', venue: 'Bush Theatre', openingDate: '2026-09-10' };
  assert.equal(otherProductionUrlSignal('https://lovelondonloveculture.com/2026/09/16/review-darkling-bush-theatre/', we), null);
});

// BRO-5132: Elf Lyons at SoHo Playhouse (an Edinburgh Fringe transfer) alerted on
// its August Fringe reviews and on the venue's own show page.
test('acceptSerpCensusResult drops Edinburgh Fringe reviews and the venue site on a NYC transfer (BRO-5132)', () => {
  const { otherProductionUrlSignal } = require('./audit-show-review-gap.js');
  const show = { id: 'elf-lyons-the-woman-on-the-edge-off-broadway-2026', title: 'Elf Lyons: The Woman on the Edge', category: 'off-broadway', venue: 'SoHo Playhouse', previewsStartDate: '2026-09-24', openingDate: '2026-09-27' };
  const info = { title: show.title, cast: [], creativeNames: [] };
  const title = 'Elf Lyons: The Woman on the Edge review';
  for (const url of [
    'https://www.bingefringe.com/2026/08/31/review-elf-lyons-is-the-woman-on-the-edge-mick-perrin-worldwide-pbj-management-edfringe-2026-%E2%98%85%E2%98%85%E2%98%85%E2%98%85%E2%98%85/',
    'https://fringereview.co.uk/review/edinburgh-fringe/2026/elf-lyons-is-the-woman-on-the-edge/',
    'https://theatreandtonic.co.uk/edinburgh-fringe/elf-lyons-is-the-woman-on-the-edge-at-pleasance-courtyard-review',
    'https://www.timeout.com/edinburgh/comedy/elf-lyons-is-the-woman-on-the-edge-review',
    'https://www.sohoplayhouse.com/shows/elf-lyons-the-woman-on-the-edge',
    'https://www.sohoplayhouse.com/see-a-show/elf-lyons-the-woman-on-the-edge',
    'https://sohoplayhouse.com/shows/elf-lyons-the-woman-on-the-edge',
    'https://www.sohoplayhouse.com/shows/elf-lyons-the-woman-on-the-edge.html',
    'https://example.com/review-elf-lyons-the-woman-on-the-edge-edfringe2026',
  ]) assert.equal(acceptSerpCensusResult({ url, title }, { show, showInfo: info }), null, url);
  // A New York review of the transfer stays, even when its headline names the Fringe.
  assert.ok(acceptSerpCensusResult({ url: 'https://www.nytimes.com/2026/09/28/theater/elf-lyons-the-woman-on-the-edge-review.html', title: 'Review: The Edinburgh Fringe hit The Woman on the Edge arrives' }, { show, showInfo: info }));
  assert.ok(acceptSerpCensusResult({ url: 'https://www.timeout.com/newyork/theater/elf-lyons-the-woman-on-the-edge-review', title }, { show, showInfo: info }));
  // A declared prior run or a West End show is not judged.
  const fringe = { url: 'https://fringereview.co.uk/review/edinburgh-fringe/2026/elf-lyons-is-the-woman-on-the-edge/', title };
  assert.ok(acceptSerpCensusResult(fringe, { show: { ...show, priorRuns: [{ venue: 'Pleasance Courtyard', openingDate: '2026-08-01' }] }, showInfo: info }));
  assert.ok(acceptSerpCensusResult(fringe, { show: { ...show, category: 'off-west-end', venue: 'Soho Theatre' }, showInfo: info }));
  // Census only: the Show Score path (otherProductionUrlSignal) never tags a Fringe slug prior-run.
  assert.equal(otherProductionUrlSignal(fringe.url, show), null);
  // Short venue names never match a host (The Tank -> "tank").
  const tank = { id: 'x-off-broadway-2026', title: 'Elf Lyons: The Woman on the Edge', category: 'off-broadway', venue: 'The Tank', openingDate: '2026-10-01' };
  assert.ok(acceptSerpCensusResult({ url: 'https://tank.com/elf-lyons-the-woman-on-the-edge-review', title }, { show: tank, showInfo: info }));
});

test('acceptSerpCensusResult drops a novel review whose slug spells "bookreview" (BRO-4540)', () => {
  const show = { id: 'a-thousand-natural-shocks-off-broadway-2026', title: 'A Thousand Natural Shocks', category: 'off-broadway', venue: 'The Tank', openingDate: '2026-10-01' };
  const info = { title: show.title, cast: [], creativeNames: [] };
  const sr = { url: 'https://whatsbetterthanbooks.com/bookreview-natural-shocks-ohussain/', title: 'A Thousand Natural Shocks by Omar Hussain' };
  assert.equal(acceptSerpCensusResult(sr, { show, showInfo: info }), null);
});

// BRO-4190 residuals: a BroadwayWorld city edition is that city's staging, a
// "collection of stories" is a book, both under a New York title.
test('acceptSerpCensusResult drops BWW city editions and story-collection book reviews on NYC shows', () => {
  const { otherProductionUrlSignal } = require('./audit-show-review-gap.js');
  const cosi = { id: 'cosi-fan-tutte-off-broadway-2026', title: 'Così fan tutte', category: 'off-broadway', venue: 'Metropolitan Opera House', openingDate: '2026-09-24' };
  const circus = { id: 'the-secret-circus-musical-off-broadway-2026', title: 'The Secret Circus', category: 'off-broadway', venue: 'SoHo Playhouse', openingDate: '2026-09-26' };
  assert.equal(otherProductionUrlSignal('https://www.broadwayworld.com/toronto/article/Review-COS-FAN-TUTTE-at-Four-Seasons-Centre-For-The-Performing-Arts-20261004', cosi).signal, 'bww-city-edition');
  assert.equal(otherProductionUrlSignal('https://www.broadwayworld.com/new-orleans/article/Review-THE-SECRET-CIRCUS-THE-MUSICAL-at-Mudlark-Theatre-20260504', circus).signal, 'bww-city-edition');
  // New York sections and genre desks stay.
  assert.equal(otherProductionUrlSignal('https://www.broadwayworld.com/bwwopera/article/Review-COSI-FAN-TUTTE-at-the-Met-20260925', cosi), null);
  assert.equal(otherProductionUrlSignal('https://www.broadwayworld.com/off-broadway/article/Review-THE-SECRET-CIRCUS-at-SoHo-Playhouse-20260927', circus), null);
  assert.equal(otherProductionUrlSignal('https://www.broadwayworld.com/article/Review-THE-SECRET-CIRCUS-at-SoHo-Playhouse-20260927', circus), null);
  // Parity with the write path's isLikelyTourReview on every BWW edition shape.
  const { isLikelyTourReview } = require('./lib/review-guards.js');
  for (const ed of ['toronto', 'chicago', 'cabaret', 'westend', 'bwwtv', 'bwwopera', 'off-broadway']) {
    const u = `https://www.broadwayworld.com/${ed}/article/Review-COSI-FAN-TUTTE-20261004`;
    assert.equal(!!otherProductionUrlSignal(u, cosi), isLikelyTourReview(u, cosi.id), ed);
  }
  // A London show is not judged by this rule (BWW /westend/ is its home edition).
  const we = { id: 'darkling-off-west-end-2026', title: 'Darkling', category: 'off-west-end', venue: 'Bush Theatre', openingDate: '2026-09-10' };
  assert.equal(otherProductionUrlSignal('https://www.broadwayworld.com/westend/article/Review-DARKLING-Bush-Theatre-20260911', we), null);

  const shocks = { id: 'a-thousand-natural-shocks-off-broadway-2026', title: 'A Thousand Natural Shocks', category: 'off-broadway', venue: 'The Tank', openingDate: '2026-10-01' };
  const info = { title: shocks.title, cast: [], creativeNames: [] };
  const book = { url: 'https://www.broadstreetreview.com/articles/a-thousand-natural-shocks-a-collection-of-stories-by-richard-burgin', title: 'A Thousand Natural Shocks' };
  assert.equal(acceptSerpCensusResult(book, { show: shocks, showInfo: info }), null);
  // "Stories by" alone is a play title (John Lithgow: Stories by Heart).
  const lithgow = { id: 'john-lithgow-stories-by-heart-2018', title: 'John Lithgow: Stories by Heart', category: 'broadway', venue: 'American Airlines Theatre', openingDate: '2018-01-11' };
  const real = { url: 'https://www.thewrap.com/john-lithgow-stories-by-heart-broadway-review/', title: 'John Lithgow: Stories by Heart review' };
  assert.ok(acceptSerpCensusResult(real, { show: lithgow, showInfo: { title: lithgow.title, cast: [], creativeNames: [] }, now: Date.parse('2018-01-20') }));
});

// BRO-4971: round-up-listed reviews excluded by an automated verdict are split
// from human exclusions and marked for re-check when a CURRENT-run round-up
// lists them. Real functions only (CLAUDE.md §15): the lib classifier, the real
// review-guards explainExclusion, and gap-audit-merge countsFor.
{
  const { classifyFlaggedMiss, shouldReverify, countAutomatedExcludedListed, hasHumanExclusionAssertion } = require('./lib/flagged-miss-basis.js');
  const { explainExclusion } = require('./lib/review-guards.js');
  const { countsFor } = require('./lib/gap-audit-merge.js');
  const show = { id: 'bro4971-fixture', title: 'Fixture Play', category: 'west-end', status: 'open', openingDate: '2026-09-01' };
  const explain = (d) => explainExclusion(d, show, null);
  const body = 'A considered review of the evening. '.repeat(80);
  const cvWrongProduction = {
    _file: 'outlet-a--critic.json', outletId: 'outlet-a', criticName: 'Critic A',
    url: 'https://www.outlet-a.co.uk/theatre/2026/09/a-night-out', publishDate: '2026-09-02',
    fullText: body, wrongProduction: true,
    wrongProductionNote: 'CV-promoted: content verifier says this covers a different production',
  };
  const showNotMentioned = {
    _file: 'outlet-b--critic.json', outletId: 'outlet-b', criticName: 'Critic B',
    url: 'https://www.outlet-b.co.uk/reviews/fixture', publishDate: '2026-09-02',
    fullText: body, showNotMentioned: true,
  };
  const humanLocked = { ...cvWrongProduction, _file: 'outlet-c--critic.json', wrongProductionManual: true };
  const humanProvenance = { ...cvWrongProduction, _file: 'outlet-d--critic.json', wrongProductionProvenance: 'manual' };

  test('BRO-4971: automated CV wrongProduction exclusion is automatedExcluded with basis wrongProduction', () => {
    const c = classifyFlaggedMiss([cvWrongProduction], explain);
    assert.equal(c.exclusion, 'automatedExcluded');
    assert.deepEqual(c.basis, ['wrongProduction']);
  });

  test('BRO-4971: showNotMentioned exclusion is automatedExcluded and names its detector', () => {
    const c = classifyFlaggedMiss([showNotMentioned], explain);
    assert.equal(c.exclusion, 'automatedExcluded');
    // explainExclusion does not mirror the rebuild-only showNotMentioned guard;
    // the raw detector field names it instead of 'unknown'.
    assert.equal(explain(showNotMentioned), null);
    assert.deepEqual(c.basis, ['showNotMentioned']);
  });

  test('BRO-4971: human breadcrumbs make the row humanExcluded', () => {
    assert.equal(hasHumanExclusionAssertion(cvWrongProduction), false);
    for (const d of [humanLocked, humanProvenance, { ...cvWrongProduction, _locked: true },
      { ...cvWrongProduction, rejectedBy: 'manual-triage-bro-71' }]) {
      assert.equal(classifyFlaggedMiss([d], explain).exclusion, 'humanExcluded', JSON.stringify(Object.keys(d)));
    }
    // A manual CLEAR is not a human exclusion assertion.
    assert.equal(hasHumanExclusionAssertion({ ...cvWrongProduction, wrongProductionManualClear: false }), false);
    // One human-asserted copy of the URL wins over an automated sibling slot.
    assert.equal(classifyFlaggedMiss([cvWrongProduction, humanLocked], explain).exclusion, 'humanExcluded');
  });

  test('BRO-4971: human vs automated are reported distinctly; priorRun-listed automated rows are not reverify', () => {
    const rows = [
      { url: 'u1', ...classifyFlaggedMiss([cvWrongProduction], explain) },
      { url: 'u2', ...classifyFlaggedMiss([showNotMentioned], explain) },
      { url: 'u3', ...classifyFlaggedMiss([humanLocked], explain) },
      { url: 'u4', ...classifyFlaggedMiss([cvWrongProduction], explain), priorRun: true },
    ];
    for (const m of rows) m.reverify = shouldReverify(m);
    assert.deepEqual(rows.map(m => m.reverify), [true, true, false, false]);
    assert.equal(countAutomatedExcludedListed(rows), 2);
    const counts = countsFor([{ showId: show.id, missing: [], citedNoUrl: [], flaggedMisses: rows }]);
    assert.equal(counts.humanExcluded, 1);
    assert.equal(counts.automatedExcluded, 2); // priorRun row excluded from current-run counts
    assert.equal(counts.automatedExcludedListed, 2);
    assert.equal(counts.totalFlaggedMisses, 3);
  });
}

test('gapUrlIdentity: WordPress /comment-page-N/ is the same article (BRO-5169)', () => {
  const { gapUrlIdentity } = require('./audit-show-review-gap.js');
  const bare = 'https://monstagigz.com/2026/09/24/theatre-review-the-standard-of-living/';
  assert.equal(gapUrlIdentity(bare + 'comment-page-1/'), gapUrlIdentity(bare));
  assert.equal(gapUrlIdentity('http://www.MonstaGigz.com/2026/09/24/theatre-review-the-standard-of-living'), gapUrlIdentity(bare));
  // Article-id query kept by normalizeReviewUrl: the suffix still strips.
  assert.equal(gapUrlIdentity('https://x.com/review/comment-page-2/?p=123'), gapUrlIdentity('https://x.com/review/?p=123'));
  // A slug that merely contains the words is untouched.
  assert.notEqual(gapUrlIdentity('https://x.com/comment-page-1-review/'), gapUrlIdentity('https://x.com/'));
});
