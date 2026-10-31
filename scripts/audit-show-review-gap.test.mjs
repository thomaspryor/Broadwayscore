import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    snippet: 'Review of Matthew Bourne at Sadler’s Wells, 2015.',
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
  // A Fringe-named slug that also names New York or the venue is the transfer's review.
  assert.ok(acceptSerpCensusResult({ url: 'https://example.com/reviews/elf-lyons-the-woman-on-the-edge-edinburgh-fringe-hit-at-soho-playhouse/', title }, { show, showInfo: info }));
  assert.ok(acceptSerpCensusResult({ url: 'https://example.com/edfringe-hit-elf-lyons-the-woman-on-the-edge-off-broadway/', title }, { show, showInfo: info }));
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

// BRO-5512: Kramer/Fauci's February NYU Skirball run shares the calendar year with
// the October St. Ann's run, so year-only checks passed its reviews through.
test('acceptSerpCensusResult drops same-year prior-run and Philly Fringe reviews (BRO-5512)', () => {
  const { otherProductionUrlSignal } = require('./audit-show-review-gap.js');
  const show = { id: 'kramerfauci-st-anns-off-broadway-2026', title: 'Kramer/Fauci', category: 'off-broadway', venue: "St. Ann's Warehouse", previewsStartDate: '2026-09-27', openingDate: '2026-10-04', closingDate: '2026-10-24', priorRuns: [{ openingDate: '2026-02-11', closingDate: '2026-02-21', venue: 'NYU Skirball Center for the Performing Arts', inheritReviews: false }] };
  const info = { title: show.title, cast: [], creativeNames: [] };
  const title = 'Kramer/Fauci review';
  for (const url of [
    'https://www.theatlantic.com/culture/2026/02/kramer-fauci-theater-review-buckley-vidal-debate/686080/',
    'https://exeuntnyc.com/reviews/kramer-fauci-at-nyu-skirball/',
    'https://www.broadstreetreview.com/reviews/philly-fringe-2026-fringearts-presents-daniel-fishs-kramer-fauci',
  ]) assert.equal(acceptSerpCensusResult({ url, title }, { show, showInfo: info }), null, url);
  // Current-run reviews stay: October month, St. Ann's named, no venue/month signal.
  for (const url of [
    'https://www.nytimes.com/2026/10/05/theater/kramer-fauci-review.html',
    'https://www.vulture.com/article/kramer-fauci-daniel-fish-play-st-anns-nyc.html',
    'https://example.com/2026/10/kramer-fauci-from-nyu-skirball-to-st-anns-warehouse-review/',
  ]) assert.ok(acceptSerpCensusResult({ url, title }, { show, showInfo: info }), url);
  // No declared prior run: month/venue signals never fire.
  const { priorRuns, ...noRuns } = show;
  assert.equal(otherProductionUrlSignal('https://exeuntnyc.com/reviews/kramer-fauci-at-nyu-skirball/', noRuns), null);
  // A bare priorRuns entry (no inheritReviews:false) still readmits its own URLs.
  const bare = { ...show, priorRuns: [{ openingDate: '2026-02-11', closingDate: '2026-02-21', venue: 'NYU Skirball Center for the Performing Arts' }] };
  assert.equal(otherProductionUrlSignal('https://exeuntnyc.com/reviews/kramer-fauci-at-nyu-skirball/', bare), null);
  assert.equal(otherProductionUrlSignal('https://www.theatlantic.com/culture/2026/02/kramer-fauci-theater-review/1/', show).signal, 'prior-run-month');
  // Transfer reviews that shorten the venue, and one-word venues, stay.
  assert.ok(acceptSerpCensusResult({ url: 'https://example.com/reviews/kramer-fauci-from-nyu-skirball-to-st-anns.html', title }, { show, showInfo: info }));
  const pub = { ...show, priorRuns: [{ openingDate: '2026-02-11', closingDate: '2026-02-21', venue: 'The Public Theater', inheritReviews: false }] };
  assert.ok(acceptSerpCensusResult({ url: 'https://example.com/reviews/kramer-fauci-public-debate-review/', title }, { show: pub, showInfo: info }));
  // Show Score path: venue signal off (transfer reviews), month signal on.
  assert.equal(otherProductionUrlSignal('https://exeuntnyc.com/reviews/kramer-fauci-at-nyu-skirball/', show), null);
  // A Fringe slug naming New York is the transfer's review.
  assert.ok(acceptSerpCensusResult({ url: 'https://example.com/reviews/kramer-fauci-from-fringearts-to-new-york', title }, { show, showInfo: info }));
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

  test('BRO-5391: unanimous ensemble not_a_review (announcement) is confirmedNonReview', () => {
    const ens = { _file: 'e--u.json', outletId: 'e', url: 'https://e.example/announce', fullText: body,
      rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'not_a_review', rejectionAgreeCount: 3 };
    assert.equal(classifyFlaggedMiss([ens], explain).confirmedNonReview, true);
    assert.equal(classifyFlaggedMiss([{ ...ens, rejectionAgreeCount: 2 }], explain).confirmedNonReview, false);
  });

  // BRO-6689: an LLM-only not_a_review verdict that a review-shaped file contradicts is not 'confirmed'.
  test('BRO-6689: LLM-only not_a_review contradicted by a rating/aggregator excerpt is NOT confirmed', () => {
    const llmOnly = { _file: 'cs--t.json', outletId: 'cs', url: 'https://cs.example/data-review', fullText: '',
      wrongShow: true, wrongShowReason: 'CV-promoted: feature, not a review', isNonReview: true, rejectionReason: 'not_a_review',
      contentVerification: { isValid: false, confidence: 'high', articleType: 'feature', articleTypeConfidence: 'high' } };
    assert.equal(classifyFlaggedMiss([llmOnly], explain).confirmedNonReview, true, 'bare LLM verdict still confirmed');
    for (const extra of [{ originalScore: '4/5 stars' }, { showScoreExcerpt: 'A verdict quote.\n\nRead more' }]) {
      const c = classifyFlaggedMiss([{ ...llmOnly, ...extra }], explain);
      assert.equal(c.confirmedNonReview, false, JSON.stringify(extra));
      assert.equal(shouldReverify(c), true, 'surfaced for re-verify');
    }
    assert.equal(classifyFlaggedMiss([{ ...llmOnly, originalScore: null, showScoreExcerpt: 'null' }], explain).confirmedNonReview, true);
  });

  test('BRO-6689: deterministic anticipatory gate stays confirmed even with a rating on the page', () => {
    const gate = { _file: 'mg--u.json', outletId: 'mg', url: 'https://mg.example/preview', fullText: '',
      wrongProduction: true, wrongProductionReason: 'anticipatory_pre_opening_post', originalScore: '3/5',
      isNonReview: true, rejectionReason: 'not_a_review',
      contentVerification: { isValid: false, confidence: 'high', articleType: 'preview', articleTypeConfidence: 'high' } };
    assert.equal(classifyFlaggedMiss([gate], explain).confirmedNonReview, true);
  });

  test('BRO-6689: other rule-based reasons (wrongShowReason, prior-run-republish) stay confirmed; mixed list is a gap', () => {
    const base = { _file: 'x--u.json', outletId: 'x', url: 'https://x.example/a', fullText: '', originalScore: '4/5 stars',
      isNonReview: true, rejectionReason: 'not_a_review',
      contentVerification: { isValid: false, confidence: 'high', articleType: 'preview', articleTypeConfidence: 'high' } };
    assert.equal(classifyFlaggedMiss([{ ...base, wrongProduction: true, wrongProductionReason: 'prior-run-republish' }], explain).confirmedNonReview, true);
    assert.equal(classifyFlaggedMiss([{ ...base, wrongShow: true, wrongShowReason: 'dateless-revival' }], explain).confirmedNonReview, true);
    const llm = { ...base, wrongShow: true, wrongShowReason: 'CV-promoted: feature' };
    assert.equal(classifyFlaggedMiss([llm, { ...base, _file: 'y--u.json', wrongProduction: true, wrongProductionReason: 'prior-run-republish' }], explain).confirmedNonReview, false);
  });

  test('BRO-6689: LLM-written reasons and cleared-flag breadcrumbs are not deterministic; date-guard notes are', () => {
    const base = { _file: 'x--u.json', outletId: 'x', url: 'https://x.example/b', fullText: '', originalScore: '4/5 stars',
      isNonReview: true, rejectionReason: 'not_a_review',
      contentVerification: { isValid: false, confidence: 'high', articleType: 'feature', articleTypeConfidence: 'high' } };
    for (const r of ['LLM: feature', 'LLM (medium): feature', 'Retroactive LLM verify: feature']) {
      assert.equal(classifyFlaggedMiss([{ ...base, wrongShow: true, wrongShowReason: r }], explain).confirmedNonReview, false, r);
    }
    assert.equal(classifyFlaggedMiss([{ ...base, wrongProduction: false, wrongProductionReason: 'superseded: body replaced' }], explain).confirmedNonReview, false);
    assert.equal(classifyFlaggedMiss([{ ...base, wrongProduction: true, wrongProductionNote: 'Date guard: review is 200d after close' }], explain).confirmedNonReview, true);
  });

  test('BRO-5391: mixed list with one unconfirmed automated file stays a gap', () => {
    const ens = { _file: 'e--u.json', outletId: 'e', url: 'https://e.example/a', fullText: body,
      rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'not_a_review', rejectionAgreeCount: 3 };
    assert.equal(classifyFlaggedMiss([ens, cvWrongProduction], explain).confirmedNonReview, false);
  });

  test('BRO-5391: human isNotReview confirms non-review; other human assertions do not', () => {
    const hn = { ...cvWrongProduction, _file: 'h--c.json', isNotReview: true, isNonReview: true, rejectionReason: 'not_a_review', nonReviewMethod: 'manual-verified' };
    assert.equal(classifyFlaggedMiss([hn], explain).confirmedNonReview, true);
    assert.equal(classifyFlaggedMiss([humanLocked], explain).confirmedNonReview, false);
    assert.equal(classifyFlaggedMiss([cvWrongProduction], explain).confirmedNonReview, false);
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

test('currentRunUncollected: expected-rejection ingests (Time Out capsule) are not uncollected; conflicts still are (BRO-5134)', () => {
  const { currentRunUncollected } = require('./audit-show-review-gap.js');
  const cap = 'https://www.timeout.com/newyork/theater/midnight';
  const conf = 'https://example-outlet.com/review-y';
  const row = {
    showId: 'x',
    missing: [
      { url: cap, host: 'timeout.com' },
      { url: conf, host: 'example-outlet.com' },
      { url: 'https://example-outlet.com/review-z', host: 'example-outlet.com' },
    ],
    ingestResults: [
      { url: cap, ok: false, noop: true, expected: true },
      { url: conf, ok: false, noop: true, conflict: true },
    ],
  };
  assert.equal(currentRunUncollected(row, { blocklist: null }), 2);
});

test('the ingestResults entry carries the expected-rejection flag that currentRunUncollected reads (BRO-5134)', () => {
  const src = fs.readFileSync(new URL('./audit-show-review-gap.js', import.meta.url), 'utf8');
  const push = src.slice(src.indexOf('r.ingestResults.push({'));
  assert.match(push.slice(0, push.indexOf('});')), /expected: !!res\.expected/);
});

test('currentRunUncollected: serp-census-gate-off rows are report-only, not uncollected; other blocked rows still count (BRO-5252)', () => {
  const { currentRunUncollected } = require('./audit-show-review-gap.js');
  const census = 'https://a.example/review-1';
  const real = 'https://b.example/review-2';
  const row = {
    showId: 'x',
    missing: [{ url: census, host: 'a.example', serpCensus: true }, { url: real, host: 'b.example' }],
    weIngestBlocked: [{ url: census, host: 'a.example', priorRun: false, reason: 'serp-census-gate-off' }],
  };
  assert.equal(currentRunUncollected(row, { blocklist: null }), 1);
  assert.equal(currentRunUncollected({ ...row, weIngestBlocked: [] }, { blocklist: null }), 2);
});

test('currentRunUncollected: census-tagged row blocked as we-gate-off is report-only; non-census we-gate-off still counts (BRO-5513)', () => {
  const { currentRunUncollected } = require('./audit-show-review-gap.js');
  const census = 'https://a.example/review-1';
  const weRef = 'https://b.example/review-2';
  const row = {
    showId: 'x',
    missing: [{ url: census, host: 'a.example', serpCensus: true }, { url: weRef, host: 'b.example', weRef: true }],
    weIngestBlocked: [
      { url: census, host: 'a.example', priorRun: false, reason: 'we-gate-off' },
      { url: weRef, host: 'b.example', priorRun: false, reason: 'we-gate-off' },
    ],
  };
  assert.equal(currentRunUncollected(row, { blocklist: null }), 1);
  // census gate ON: the we-gate hold is a real pending gap
  const on = { ...row, weIngestBlocked: row.weIngestBlocked.map(x => ({ ...x, censusGateOn: true })) };
  assert.equal(currentRunUncollected(on, { blocklist: null }), 2);
});

test('serpCensus provenance is census-only: tagged from serpCensusOnlyUrls, never plain census membership (BRO-5252)', () => {
  const src = fs.readFileSync(new URL('./audit-show-review-gap.js', import.meta.url), 'utf8');
  assert.match(src, /serpCensusOnlyUrls = new Set\(\[\.\.\.serpCensusUrls\]\.filter\(u => !aggUrls\.has\(u\)\)\)/);
  assert.match(src, /if \(serpCensusOnlyUrls\.has\(m\.url\) && !m\.weRef\) m\.serpCensus = true;/);
  assert.doesNotMatch(src, /if \(serpCensusUrls\.has\(m\.url\)\) m\.serpCensus = true;/);
  assert.ok(src.indexOf('serpCensusOnlyUrls = new Set') < src.indexOf('for (const u of serpCensusUrls) aggUrls.add(u);'));
});

// BRO-5500: a high-confidence CV non-review (critic never saw the show) that a
// round-up merely links is the correct exclusion, not a residual gap. Fixture is
// the real anon-a-tempest frontmezzjunkies--ross.json shape.
test('flagged-miss-basis: CV-confirmed non-review is not residual; low-confidence / human rows still are', () => {
  const { classifyFlaggedMiss, shouldReverify } = require('./lib/flagged-miss-basis.js');
  const { computeResidualCounts } = require('./audit-show-review-gap.js');
  const confirmed = {
    wrongShow: true, isNonReview: true, rejectionReason: 'not_a_review',
    contentVerification: { isValid: false, confidence: 'high', articleType: 'preview', articleTypeConfidence: 'high' },
  };
  const c = classifyFlaggedMiss([confirmed]);
  assert.equal(c.confirmedNonReview, true);
  assert.equal(shouldReverify({ exclusion: c.exclusion, confirmedNonReview: true }), false);
  const weak = { ...confirmed, contentVerification: { ...confirmed.contentVerification, confidence: 'medium' } };
  assert.equal(classifyFlaggedMiss([weak]).confirmedNonReview, false);
  assert.equal(classifyFlaggedMiss([{ ...confirmed, isNotReview: true }]).confirmedNonReview, false);
  const row = (extra) => ({ url: 'https://x.test/a', exclusion: 'automatedExcluded', ...extra });
  assert.equal(computeResidualCounts({ flaggedMisses: [row({ confirmedNonReview: true })] }, false).flaggedOut, 0);
  assert.equal(computeResidualCounts({ flaggedMisses: [row({})] }, false).flaggedOut, 1);
});

// BRO-5514: Time Out listing capsule + held syndicated reprint are correct exclusions.
// Fixtures are the real what-the-animals-say-off-west-end-2026 timeout-london / viewfromthegods shapes.
test('flagged-miss-basis: Time Out capsule and held syndicated reprint are confirmed, unheld ones are not', () => {
  const { classifyFlaggedMiss } = require('./lib/flagged-miss-basis.js');
  const capsule = { contentTier: 'truncated', incompleteReason: 'url_content_mismatch', incompleteDetail: 'timeout_listing_capsule: Time Out unsigned listing capsule (91 words), not the review' };
  assert.equal(classifyFlaggedMiss([capsule]).confirmedNonReview, true);
  assert.equal(classifyFlaggedMiss([{ ...capsule, incompleteDetail: 'other' }]).confirmedNonReview, false);
  const dup = { isSyndicatedDuplicate: true, syndicatedPrimaryFile: 's/fringereview--x.json', syndicationSimilarity: 87 };
  assert.equal(classifyFlaggedMiss([dup], null, () => true).confirmedNonReview, true);
  assert.equal(classifyFlaggedMiss([dup], null, () => false).confirmedNonReview, false);
  assert.equal(classifyFlaggedMiss([dup]).confirmedNonReview, false);
  assert.equal(classifyFlaggedMiss([{ ...dup, syndicatedPrimaryFile: undefined }], null, () => true).confirmedNonReview, false);
  assert.equal(classifyFlaggedMiss([{ ...dup, syndicationSimilarity: 40 }], null, () => true).confirmedNonReview, false);
});

// BRO-5500: the audit pre-classifies ingest-refused URLs (exit 1 in the child, which the
// submission workflow relies on) as expected skips, and confirmed non-reviews drop out of
// every gap count, not just flaggedOut.
test('ingest-refused URL: classified expected without spawning; splitGapCounts ignores confirmedNonReview', () => {
  const { ingestRefusalReason } = require('./lib/non-review-url-patterns.js');
  const { splitGapCounts } = require('./lib/prior-production-citations.js');
  const { classifyIngestSkip } = require('./lib/ingest-skip-classify.js');
  assert.equal(ingestRefusalReason('https://www.nyc.com/events/sea_wall.443831802918871040/'), 'ticketing-listing');
  assert.equal(ingestRefusalReason('https://www.nytimes.com/2026/10/16/theater/x-review.html'), null);
  assert.equal(classifyIngestSkip('Skipped: named-non-review-url:ticketing-listing').kind, 'expected');
  assert.equal(splitGapCounts({ flaggedMisses: [{ url: 'a', confirmedNonReview: true }, { url: 'b' }] }).total, 1);
});

test('openingWindowClearedKeys: a show past its opening window with only census-tagged gaps is quiet; a non-census gap keeps it open (BRO-5252)', () => {
  const { openingWindowClearedKeys } = require('./audit-show-review-gap.js');
  const now = Date.parse('2026-10-18T00:00:00Z');
  // Real Alice in Wonderland shape: last audited 2026-09-30, census-tagged misses, no weIngestBlocked.
  const gapRow = (showId, openingDate) => ({
    showId, openingDate,
    missing: [{ url: `https://a.example/${showId}-review`, host: 'a.example', knownOutletId: null, serpCensus: true }],
  });
  const realGap = gapRow('real-gap-tour-2026', '2026-09-20');
  realGap.missing.push({ url: 'https://b.example/show-score-cited-review', host: 'b.example' });
  const keys = openingWindowClearedKeys([
    gapRow('alice-in-wonderland-off-broadway-2026', '2026-09-26'), // day 22, census-only: quiet
    gapRow('fresh-show-2026', '2026-10-10'),                       // day 8: still alerting
    realGap,                                                       // past window but a non-census gap: stays open
  ], now);
  assert.deepEqual(keys, ['review-gap:opening-window:alice-in-wonderland-off-broadway-2026']);
});

test('openingWindowClearedKeys: a row for a retired show id counts as cleared even with a live gap (BRO-5349)', () => {
  const { openingWindowClearedKeys } = require('./audit-show-review-gap.js');
  const now = Date.parse('2026-10-05T00:00:00Z');
  const gapRow = (showId) => ({
    showId, openingDate: '2026-10-01',
    missing: [{ url: `https://b.example/${showId}-review`, host: 'b.example' }],
  });
  // motherfucker-off-broadway-2026 was retired as a duplicate of the jena-friedman id;
  // its pre-retirement row is carried forward by mergeGapAudit.
  const rows = [gapRow('motherfucker-off-broadway-2026'), gapRow('jena-friedman-motherfucker-off-broadway-2026')];
  const liveShowIds = new Set(['jena-friedman-motherfucker-off-broadway-2026']);
  assert.deepEqual(openingWindowClearedKeys(rows, now, { liveShowIds }), ['review-gap:opening-window:motherfucker-off-broadway-2026']);
  // Without liveShowIds the old behaviour holds: both still gapped.
  assert.deepEqual(openingWindowClearedKeys(rows, now), []);
});

test('openingWindowClearedKeys: window and status come from shows.json, not the frozen row (BRO-5489)', () => {
  const { openingWindowClearedKeys } = require('./audit-show-review-gap.js');
  const now = Date.parse('2026-10-21T03:00:00Z');
  const censusRow = (showId, openingDate) => ({
    showId, openingDate,
    missing: [{ url: `https://a.example/${showId}-review`, host: 'a.example', knownOutletId: null, serpCensus: true }],
  });
  // Real shapes from show-review-gap.json on 2026-10-21.
  const rows = [
    censusRow('measure-for-measure-off-west-end-2026', '2026-10-02'),        // closed after 2 nights, census-only
    censusRow('magic-mike-live-new-york-off-broadway-2026', '2026-10-08'),   // rescheduled to 2027-01-28
    censusRow('kramerfauci-st-anns-off-broadway-2026', '2026-10-04'),        // open, in window: still alerting
  ];
  const closedReal = censusRow('fences-closed-2026', '2026-10-09');
  closedReal.missing.push({ url: 'https://b.example/cited-review', host: 'b.example' });
  rows.push(closedReal);                                                     // closed but a non-census gap: stays open
  const showById = new Map([
    ['measure-for-measure-off-west-end-2026', { id: 'measure-for-measure-off-west-end-2026', openingDate: '2026-10-02', status: 'closed' }],
    ['magic-mike-live-new-york-off-broadway-2026', { id: 'magic-mike-live-new-york-off-broadway-2026', openingDate: '2027-01-28', status: 'upcoming' }],
    ['kramerfauci-st-anns-off-broadway-2026', { id: 'kramerfauci-st-anns-off-broadway-2026', openingDate: '2026-10-04', status: 'open' }],
    ['fences-closed-2026', { id: 'fences-closed-2026', openingDate: '2026-10-09', status: 'closed' }],
  ]);
  assert.deepEqual(openingWindowClearedKeys(rows, now, { showById }), [
    'review-gap:opening-window:measure-for-measure-off-west-end-2026',
    'review-gap:opening-window:magic-mike-live-new-york-off-broadway-2026',
  ]);
  // Without shows.json the row's own date decides (old behaviour): all in window, none cleared.
  assert.deepEqual(openingWindowClearedKeys(rows, now), []);
});

test('plausibleLiveShowIds: a stub shows.json yields null so retired-id clearing never mass-resolves (BRO-5349)', () => {
  const { plausibleLiveShowIds, MIN_PLAUSIBLE_SHOWS } = require('./lib/live-show-ids.js');
  assert.equal(plausibleLiveShowIds(new Set()), null);
  assert.equal(plausibleLiveShowIds(null), null);
  const full = new Set(Array.from({ length: MIN_PLAUSIBLE_SHOWS }, (_, i) => `s${i}`));
  assert.equal(plausibleLiveShowIds(full), full);
});

// BRO-5655: reserved slots for the stalest gap rows. Real functions only.
const {
  reserveStalestSlots, gapRowTimestamps, oldestGapRow, STALE_RESERVE_EVERY,
} = require('./lib/gap-audit-freshness.js');

test('BRO-5655: stalest rows get reserved slots even when many fresh opening shows are due', () => {
  const NOW = Date.parse('2026-10-19T09:00:00Z');
  const opening = Array.from({ length: 40 }, (_, i) => ({ id: `opening-${i}` }));
  const stale = [{ id: 'antigone-exits' }, { id: 'stale-b' }, { id: 'stale-c' }];
  // Priority order puts every opening show ahead of the stale ones.
  const ordered = [...opening, ...stale];
  const gapFile = {
    results: [
      ...opening.map(s => ({ showId: s.id, computedAt: new Date(NOW - 2 * 3600e3).toISOString() })),
      { showId: 'stale-c', computedAt: new Date(NOW - 50 * 3600e3).toISOString() },
      { showId: 'antigone-exits', computedAt: '2026-10-14T22:55:22.804Z' },
      { showId: 'stale-b', computedAt: new Date(NOW - 80 * 3600e3).toISOString() },
    ],
  };
  const ts = gapRowTimestamps(gapFile);
  const { targets, reservedIds } = reserveStalestSlots(ordered, ts);
  // A run that only gets through 12 shows (budget hit) still refreshes all three, oldest first.
  const firstTwelve = targets.slice(0, 12).map(s => s.id);
  assert.equal(firstTwelve[1], 'antigone-exits');
  assert.equal(firstTwelve[1 + STALE_RESERVE_EVERY], 'stale-b');
  assert.equal(firstTwelve[1 + 2 * STALE_RESERVE_EVERY], 'stale-c');
  assert.deepEqual(reservedIds.slice(0, 3), ['antigone-exits', 'stale-b', 'stale-c']);
  // Non-reserved slots keep priority order.
  assert.deepEqual(firstTwelve.filter(id => id.startsWith('opening-')), opening.slice(0, 9).map(s => s.id));
  // Same shows out, no duplicates.
  assert.equal(targets.length, ordered.length);
  assert.equal(new Set(targets.map(s => s.id)).size, ordered.length);
  // About a quarter of slots are reserved.
  assert.ok(reservedIds.length >= Math.floor(ordered.length / STALE_RESERVE_EVERY));
});

test('BRO-5489: reserved slots go to rows the alert still reads before older back-catalogue rows', () => {
  const NOW = Date.parse('2026-10-21T00:49:00Z');
  const opening = Array.from({ length: 20 }, (_, i) => ({ id: `opening-${i}` }));
  const backCatalogue = [{ id: 'hate-radio' }, { id: 'pen-pals' }];
  const alerting = [{ id: 'what-the-animals-say' }, { id: 'kramerfauci' }];
  const ordered = [...opening, ...alerting, ...backCatalogue];
  const ts = new Map([
    ...opening.map(s => [s.id, NOW - 2 * 3600e3]),
    ['hate-radio', Date.parse('2026-09-05T17:16:12Z')],
    ['pen-pals', Date.parse('2026-09-08T00:00:00Z')],
    ['what-the-animals-say', Date.parse('2026-10-10T10:36:33Z')],
    ['kramerfauci', Date.parse('2026-10-14T19:12:18Z')],
  ]);
  const preferIds = new Set(alerting.map(s => s.id));
  const { targets, reservedIds } = reserveStalestSlots(ordered, ts, { preferIds });
  assert.deepEqual(reservedIds.slice(0, 4), ['what-the-animals-say', 'kramerfauci', 'hate-radio', 'pen-pals']);
  assert.equal(targets[1].id, 'what-the-animals-say');
  assert.equal(targets[1 + STALE_RESERVE_EVERY].id, 'kramerfauci');
  assert.equal(new Set(targets.map(s => s.id)).size, ordered.length);
  // No preferIds: oldest-first as before.
  assert.deepEqual(reserveStalestSlots(ordered, ts).reservedIds.slice(0, 2), ['hate-radio', 'pen-pals']);
});

test('BRO-5655: no-row, quarantined and unparseable rows are not reserved-slot candidates', () => {
  const ts = gapRowTimestamps({ results: [
    { showId: 'q', computedAt: '2026-09-01T00:00:00Z', quarantine: { nextState: 'x' } },
    { showId: 'bad', computedAt: 'not-a-date' },
    { showId: 'ok', computedAt: '2026-10-18T00:00:00Z' },
  ] });
  assert.deepEqual([...ts.keys()], ['ok']);
  const ordered = ['a', 'b', 'q', 'bad', 'norow', 'ok'].map(id => ({ id }));
  const { targets, reservedIds } = reserveStalestSlots(ordered, ts);
  assert.deepEqual(reservedIds, ['ok']);
  assert.deepEqual(targets.map(s => s.id), ['a', 'ok', 'b', 'q', 'bad', 'norow']);
  // Empty map → order unchanged.
  assert.deepEqual(reserveStalestSlots(ordered, new Map()).targets.map(s => s.id), ordered.map(s => s.id));
});

// BRO-4061: back-catalogue lane. Never-audited shows have no gap row, so the
// stale lane cannot reach them; this lane must, even under a full tier 0.
const { CATALOGUE_RESERVE_EVERY, CATALOGUE_RESERVE_AT } = require('./lib/gap-audit-freshness.js');

test('BRO-4061: never-audited back-catalogue shows get slots while opening shows fill the queue', () => {
  const opening = Array.from({ length: 40 }, (_, i) => ({ id: `opening-${i}` }));
  const neverAudited = [{ id: 'inala-west-end-2026' }, { id: 'menopause-the-musical-tour-2026' }];
  const staleRow = [{ id: 'hate-radio' }, { id: 'pen-pals' }, { id: 'stale-c' }];
  const ordered = [...opening, ...neverAudited, ...staleRow];
  const ts = new Map([...opening.map(s => [s.id, 2e12]), ['hate-radio', 1e12], ['pen-pals', 1.1e12], ['stale-c', 1.2e12]]);
  const catalogueIds = new Set(neverAudited.map(s => s.id));
  // Before: a 12-show run never reaches a never-audited show.
  assert.ok(!reserveStalestSlots(ordered, ts).targets.slice(0, 12).some(s => s.id === 'inala-west-end-2026'));
  const { targets, reservedIds, catalogueReservedIds } = reserveStalestSlots(ordered, ts, { catalogueIds });
  const firstTwelve = targets.slice(0, 12).map(s => s.id);
  // The lane must sit on a stale-lane slot, or it takes slots from opening-week shows.
  assert.equal(CATALOGUE_RESERVE_AT % STALE_RESERVE_EVERY, 1);
  assert.equal(firstTwelve[CATALOGUE_RESERVE_AT], 'inala-west-end-2026');
  assert.equal(targets[CATALOGUE_RESERVE_AT + CATALOGUE_RESERVE_EVERY].id, 'menopause-the-musical-tour-2026');
  // The catalogue slot is taken from the stale lane, which keeps the rest.
  assert.equal(firstTwelve[1], 'hate-radio');
  assert.equal(firstTwelve[9], 'pen-pals');
  assert.deepEqual(reservedIds.slice(0, 2), ['hate-radio', 'pen-pals']);
  assert.deepEqual(catalogueReservedIds, ['inala-west-end-2026', 'menopause-the-musical-tour-2026']);
  // Opening shows keep exactly the slots they had without the lane (stale lane saturated).
  const without = reserveStalestSlots(ordered, ts).targets.slice(0, 12).map(s => s.id);
  assert.deepEqual(firstTwelve.filter(id => id.startsWith('opening-')), without.filter(id => id.startsWith('opening-')));
  assert.deepEqual(firstTwelve.filter(id => id.startsWith('opening-')), opening.slice(0, 9).map(s => s.id));
  assert.equal(new Set(targets.map(s => s.id)).size, ordered.length);
  assert.equal(targets.length, ordered.length);
});

test('BRO-4061: catalogue lane works with no gap file and leaves the stale lane unchanged without it', () => {
  const ordered = ['o1', 'o2', 'o3', 'o4', 'o5', 'cat-a', 'cat-b'].map(id => ({ id }));
  const catalogueIds = new Set(['cat-a', 'cat-b']);
  const noRows = reserveStalestSlots(ordered, new Map(), { catalogueIds });
  assert.deepEqual(noRows.targets.map(s => s.id), ['o1', 'o2', 'o3', 'o4', 'o5', 'cat-a', 'cat-b']);
  assert.deepEqual(noRows.catalogueReservedIds, ['cat-a']);
  assert.deepEqual(noRows.reservedIds, []);
  // No catalogueIds → byte-for-byte the old behaviour, with an empty catalogue list.
  const ts = new Map([['cat-b', 1]]);
  const plain = reserveStalestSlots(ordered, ts);
  assert.deepEqual(plain.targets.map(s => s.id), ['o1', 'cat-b', 'o2', 'o3', 'o4', 'o5', 'cat-a']);
  assert.deepEqual(plain.catalogueReservedIds, []);
  // A show both stale and catalogue is placed once.
  const both = reserveStalestSlots(ordered, ts, { catalogueIds });
  assert.deepEqual(both.targets.map(s => s.id), ['o1', 'cat-b', 'o2', 'o3', 'o4', 'cat-a', 'o5']);
  assert.deepEqual(both.reservedIds, ['cat-b']);
  assert.deepEqual(both.catalogueReservedIds, ['cat-a']);
  // Empty catalogue queue: the slot falls back to the stale lane.
  const ts2 = new Map([['o5', 1], ['cat-b', 2]]);
  const fallback = reserveStalestSlots(ordered, ts2, { catalogueIds: new Set(['nope']) });
  assert.deepEqual(fallback.reservedIds, ['o5', 'cat-b']);
  assert.equal(fallback.targets[5].id, 'cat-b');
});

test('BRO-5655: oldest gap row age is reported for the given ids', () => {
  const NOW = Date.parse('2026-10-19T09:00:00Z');
  const ts = new Map([
    ['antigone-exits', Date.parse('2026-10-14T22:55:22.804Z')],
    ['fresh', NOW - 3600e3],
  ]);
  assert.deepEqual(oldestGapRow(ts, ['fresh', 'antigone-exits', 'missing'], NOW), {
    showId: 'antigone-exits', computedAt: '2026-10-14T22:55:22.804Z', ageHours: 106.1,
  });
  assert.equal(oldestGapRow(ts, ['fresh'], NOW).ageHours, 1);
  assert.equal(oldestGapRow(ts, [], NOW), null);
});

test('BRO-5655: reserveStalestSlots survives duplicate ids without throwing', async () => {
  const { reserveStalestSlots } = await import('./lib/gap-audit-freshness.js');
  const list = [{ id: 'a' }, { id: 'a' }, { id: 'b' }];
  const out = reserveStalestSlots(list, new Map([['b', 1]]));
  assert.ok(out.targets.length >= 2);
});

// BRO-5732: the census fails closed on unregistered hosts. 24-ore.com's
// photo-release post (BRO-5134) was dropped by a one-off URL pattern; a new
// non-review shape on a new host must not need another pattern.
test('acceptSerpCensusResult requires review evidence from an unregistered host', () => {
  const show = { id: 'midnight-off-broadway-2026', title: 'Midnight', category: 'off-broadway' };
  const info = { title: 'Midnight', cast: [], creativeNames: [] };
  const news = {
    url: 'https://unknown-news-site.example/en/todrick-halls-midnight-opens-after-one-week-delay/',
    title: "Todrick Hall's Midnight opens after one week delay",
    snippet: 'The off-Broadway musical Midnight announced new opening dates.',
  };
  assert.equal(acceptSerpCensusResult(news, { show, showInfo: info }), null);
  const review = { ...news, title: "Midnight review: Todrick Hall's musical", url: 'https://unknown-news-site.example/en/midnight-review/' };
  assert.ok(acceptSerpCensusResult(review, { show, showInfo: info }));
});

test('hasReviewEvidence reads url, title and snippet', () => {
  const { hasReviewEvidence } = require('./lib/serp-review-evidence.js');
  assert.equal(hasReviewEvidence({ url: 'https://x.example/trainspotting-the-musical-review/' }), true);
  assert.equal(hasReviewEvidence({ url: 'https://x.example/a', title: 'Great show ★★★★' }), true);
  assert.equal(hasReviewEvidence({ url: 'https://x.example/first-photos-released', title: 'First photos released', snippet: 'See them' }), false);
});

test('BRO-5732: a prior-census URL is not re-judged on a bare URL; multilingual review words count', () => {
  const { hasReviewEvidence } = require('./lib/serp-review-evidence.js');
  const show = { id: 'midnight-off-broadway-2026', title: 'Midnight', category: 'off-broadway' };
  const url = 'https://unknown-news-site.example/en/midnight-at-the-lyric-a-triumph/';
  assert.equal(acceptSerpCensusResult({ url }, { show, showInfo: {} }), null);
  assert.ok(acceptSerpCensusResult({ url }, { show, showInfo: {}, priorVetted: true }));
  assert.equal(hasReviewEvidence({ url: 'https://x.example/a', title: 'Midnight: la recensione' }), true);
  assert.equal(hasReviewEvidence({ url: 'https://x.example/a', title: 'Midnight Kritik' }), true);
});

// ── BRO-5902: the --ingest-missing path must not write phantom reviews ──────
// The gap audit's auto-ingest execs scripts/ingest-review-from-url.js, which
// writes through createOrMergeReviewFile with source 'submit-review-form'.
// Two 2026-08 incidents: a DTLI show hub (didtheylikeit.com/shows/<slug>/)
// stored as dtli--unknown.json, and one people.com URL stored twice
// (people--dave-quinn.json + people--unknown.json). These pin the gates that
// now stop both, on the exact write call the ingest path makes.
{
  const { createOrMergeReviewFile } = require('./lib/review-file-writer.js');
  const SHOW = 'paranormal-activity-2026';
  const prose = (n) => Array.from({ length: n }, (_, i) =>
    `Paranormal Activity on Broadway is a chilling, inventive evening of theatre, beat ${i}; the cast is superb and the staging terrifies.`).join(' ');
  const freshDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5902-'));
    fs.mkdirSync(path.join(dir, SHOW));
    return dir;
  };
  const write = (dir, input) => createOrMergeReviewFile(SHOW, { source: 'submit-review-form', ...input },
    { reviewTextsDir: dir, knownShowIds: new Set([SHOW]) });

  test('BRO-5902: a DTLI show hub submitted as a review is refused, nothing written', () => {
    const dir = freshDir();
    const r = write(dir, {
      outletId: 'dtli', outlet: 'Did They Like It', criticName: 'Unknown',
      url: 'https://didtheylikeit.com/shows/paranormal-activity/',
      fields: { fullText: `The New York Times Jesse Green: ${prose(3)} Variety Frank Rizzo: ${prose(3)}`, operatorTrust: false },
    });
    assert.notEqual(r.action, 'created');
    assert.match(String(r.reason), /show-hub/);
    assert.deepEqual(fs.readdirSync(path.join(dir, SHOW)), []);
  });

  for (const [label, first, second] of [
    ['byline then Unknown', 'Dave Quinn', 'Unknown'],
    ['Unknown then byline', 'Unknown', 'Dave Quinn'],
  ]) {
    test(`BRO-5902: one URL written twice (${label}) leaves one file`, () => {
      const dir = freshDir();
      const url = 'https://people.com/paranormal-activity-broadway-review-12067912';
      write(dir, { outletId: 'people', outlet: 'People', criticName: first, url, fields: { fullText: prose(20), operatorTrust: false } });
      write(dir, { outletId: 'people', outlet: 'People', criticName: second, url: `${url}?utm_source=x`, fields: { fullText: prose(20), operatorTrust: false } });
      assert.equal(fs.readdirSync(path.join(dir, SHOW)).length, 1);
    });
  }

  test('BRO-5902: the ingest path keeps its gates (static)', () => {
    const ingest = fs.readFileSync(new URL('./ingest-review-from-url.js', import.meta.url), 'utf8');
    const audit = fs.readFileSync(new URL('./audit-show-review-gap.js', import.meta.url), 'utf8');
    // The ingester refuses blocked (ticket/booking/social) hosts before it fetches...
    const blockedAt = ingest.search(/\bisBlockedReviewUrl\(/);
    assert.ok(blockedAt > 0, 'ingest-review-from-url.js must check isBlockedReviewUrl');
    assert.ok(blockedAt < ingest.search(/await\s+fetchPage\(/), 'blocked-host check must run before the fetch');
    // ...and writes review files only through the guarded writer.
    assert.match(ingest, /createOrMergeReviewFile\(/);
    assert.doesNotMatch(ingest, /writeFileSync\([^)]*review-texts/);
    // The gap audit never writes review files itself; it hands URLs to the ingester.
    assert.doesNotMatch(audit, /createOrMergeReviewFile\(/);
    assert.match(audit, /'scripts\/ingest-review-from-url\.js'/);
  });

  test('BRO-5902: only ingest-review-from-url.js tags writes as submit-review-form', () => {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.(c|m)?js$/.test(e.name) || /\.test\./.test(e.name)) continue;
        if (/\bsource:\s*['"]submit-review-form['"]/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(scriptsDir, p));
      }
    };
    walk(scriptsDir);
    assert.deepEqual(offenders, ['ingest-review-from-url.js']);
  });
}

test('BRO-6629: short or numeric titles keep a token set, so roundup sidebars for other shows are refused', () => {
  const { titleTokens: tt, urlMatchesShow: ums } = require('./audit-show-review-gap.js');
  assert.deepStrictEqual(tt('44'), ['44']);
  assert.deepStrictEqual(tt('Oz'), ['oz']);
  assert.ok(tt('The Play').length > 0);
  assert.deepStrictEqual(tt('Staff Meal'), ['staff', 'meal'], 'normal titles are unchanged');
  assert.equal(ums('https://www.broadwayworld.com/off-broadway/article/Review-MERRILY-WE-ROLL-ALONG-20231010', tt('44')), false);
  assert.equal(ums('https://www.theatermania.com/news/44-the-musical-review_1234', tt('44')), true);
});
