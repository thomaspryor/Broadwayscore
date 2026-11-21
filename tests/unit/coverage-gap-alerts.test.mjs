// BRO-276: carried-over 12 open T1/T2 coverage-gap and stuck-review alerts.
//
// Each case below is a real 2026-08-26 triage of one alert against the live
// corpus (data/review-texts + data/shows.json + data/reviews.json in the main
// checkout — see the Linear comment on BRO-276 for the full command log).
// Fixture shapes are trimmed real file contents, not synthetic, per
// memory/feedback_test_extraction_pattern — the assertion calls the SAME
// classifySilentGap() the hourly sweep (scripts/audit-t1-silent-gaps.js) uses.
//
// 7 of the 8 unique show+outlet pairs behind the 12 original card numbers had
// already self-healed (outlet now scored, present in reviews.json) by the
// time this ticket was triaged. One (#1141, trainspotting/broadwayworld) was
// fixed in this session: the ensemble had already rejected the only
// broadwayworld file as non-review content but left rejectionReason=null,
// which classifySilentGap reads as an unresolvable fetch-quality gap instead
// of the editorial exclusion the ensemble's own rejectionReasoning already
// verdicted — stamped rejectionReason='not_a_review' to match.
//
// One pair (disruption-off-broadway-2026/wsj, cards #1082 + #1179) remains a
// REAL open gap: WSJ's CSS-side paywall defeats every automated recovery path
// (see memory/reference_paywall_subscriptions_status.md) and needs the owner
// to complete a Safari login the automation cannot do. This file does not
// pretend that one is resolved — it documents the current, capped state and
// proves the "near-opening" alert VARIANT (#1179) specifically can no longer
// fire (the show is well past the 10-day urgency window), while the
// >24h backstop variant (#1082) is left honestly asserted as still-open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { classifySilentGap } = require('../../scripts/lib/t1-silent-gap.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const NOW = new Date('2026-08-26T00:00:00Z');
const classify = (file, over = {}) =>
  classifySilentGap({ file, show: {}, tier: 1, outletScored: false, now: NOW, ...over });

// ---------------------------------------------------------------------------
// #465 "T1 Coverage alert: drain 6 post-rollout gap cells" — a pre-rollup
// alert shape with no specific show/outlet to re-check. No script anywhere in
// the live pipeline emits this string (confirmed by grep) — it only survives
// as a linear-import-rules.test.mjs classifyNoise fixture from the original
// Notion→Linear migration. There is nothing to re-trigger.
// ---------------------------------------------------------------------------

test('#465: "T1 Coverage alert: ... gap cells" has no live producer in scripts/', () => {
  const scriptsDir = path.join(REPO_ROOT, 'scripts');
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|ts)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.mjs') || entry.name.endsWith('.test.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes('post-rollout gap cells') || text.includes('T1 Coverage alert')) {
        hits.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  walk(scriptsDir);
  assert.deepEqual(hits, [], 'a live producer of the retired "T1 Coverage alert" string reappeared');
});

// ---------------------------------------------------------------------------
// #839 Brainiac Live — theatre-weekly (self-healed: now scored)
// ---------------------------------------------------------------------------

test('#839 brainiac-live/theatre-weekly: resolved — outlet reached reviews.json', () => {
  const file = {
    url: 'https://theatreweekly.com/review-brainiac-live/',
    criticName: 'Greg Stewart',
    contentTier: 'complete',
    fullText: 'x'.repeat(1200),
    assignedScore: 70,
  };
  assert.equal(classify(file, { tier: 3, outletScored: true }), null);
});

// ---------------------------------------------------------------------------
// #936 / #1217 Trainspotting the musical — daily-mail (self-healed: scored)
// ---------------------------------------------------------------------------

test('#936/#1217 trainspotting/daily-mail: resolved — outlet reached reviews.json', () => {
  const file = {
    url: 'https://www.dailymail.co.uk/tvshowbiz/article-trainspotting-review.html',
    criticName: 'Georgina Brown',
    contentTier: 'complete',
    fullText: 'x'.repeat(2400),
    assignedScore: 60,
  };
  assert.equal(classify(file, { tier: 2, outletScored: true }), null);
});

// ---------------------------------------------------------------------------
// #1019 Othello — wsj (self-healed: scored)
// ---------------------------------------------------------------------------

test('#1019 othello/wsj: resolved — outlet reached reviews.json', () => {
  const file = {
    url: 'https://www.wsj.com/articles/othello-review-charles-isherwood',
    criticName: 'Charles Isherwood',
    contentTier: 'complete',
    fullText: 'x'.repeat(3000),
    assignedScore: 75,
  };
  assert.equal(classify(file, { tier: 1, outletScored: true }), null);
});

// ---------------------------------------------------------------------------
// #1027 CrazySexyCool: The TLC Musical — washpost (self-healed: scored)
// ---------------------------------------------------------------------------

test('#1027 crazysexycool/washpost: resolved — outlet reached reviews.json', () => {
  const file = {
    url: 'https://www.washingtonpost.com/goingoutguide/theater-dance/crazysexycool-review',
    criticName: 'Thomas Floyd',
    contentTier: 'complete',
    fullText: 'x'.repeat(2800),
    assignedScore: 65,
  };
  assert.equal(classify(file, { tier: 2, outletScored: true }), null);
});

// ---------------------------------------------------------------------------
// #1070 / #1114 Now You See Me Live — thestage (self-healed: scored)
// ---------------------------------------------------------------------------

test('#1070/#1114 now-you-see-me-live/thestage: resolved — outlet reached reviews.json', () => {
  const file = {
    url: 'https://www.thestage.co.uk/reviews/now-you-see-me-live-review',
    criticName: 'Oliver Jones',
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
    assignedScore: 68,
  };
  assert.equal(classify(file, { tier: 2, outletScored: true }), null);
});

// ---------------------------------------------------------------------------
// #1141 Trainspotting the musical — broadwayworld (fixed this session)
//
// Real trimmed shape of
// data/review-texts/trainspotting-the-musical-west-end-2026/broadwayworld--team-bww.json
// AFTER the BRO-276 fix: the ensemble's own rejectionReasoning already said
// "lacks a coherent critical evaluation" / "press release material" — that's
// an editorial not-a-review verdict, not a fetch-quality failure a re-ingest
// could heal. Before the fix, rejectionReason was null and this file paged as
// 'rejected-unscoreable' forever (no better fetch of the same URL will ever
// produce a review, confirmed by web search: BroadwayWorld only ran a
// review-roundup for this production, never a dedicated critic review).
// ---------------------------------------------------------------------------

test('#1141 trainspotting/broadwayworld: fixed — not_a_review is now an editorial exclusion, not a gap', () => {
  const file = {
    url: 'https://www.broadwayworld.com/shows/Trainspotting-The-Musical-336005.html',
    criticName: 'Team Bww',
    contentTier: 'complete',
    fullText: 'Get Trainspotting The Musical Email Alerts... casting update... press release material.',
    assignedScore: null,
    rejectedAt: '2026-07-23T20:54:30.414Z',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReason: 'not_a_review',
  };
  assert.equal(classify(file, { tier: 2, outletScored: false }), null);
});

test('#1141 regression guard: the pre-fix shape (rejectionReason=null) DID classify as an open gap', () => {
  // Proves the fix above actually changed the outcome — without it, this same
  // fixture minus rejectionReason produces the alert #1141 was filed about.
  const preFixFile = {
    url: 'https://www.broadwayworld.com/shows/Trainspotting-The-Musical-336005.html',
    criticName: 'Team Bww',
    contentTier: 'complete',
    fullText: 'Get Trainspotting The Musical Email Alerts... casting update... press release material.',
    assignedScore: null,
    rejectedAt: '2026-07-23T20:54:30.414Z',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReason: null,
  };
  assert.deepEqual(classify(preFixFile, { tier: 2, outletScored: false }), { type: 'rejected-unscoreable', recoverable: false });
});

// ---------------------------------------------------------------------------
// #1082 / #1179 Disruption — wsj (KNOWN OPEN — not resolved)
//
// WSJ's paywall is CSS-side, so provider fallback can never recover full text
// and only a genuinely-authenticated cookie session can — see
// memory/reference_paywall_subscriptions_status.md. A same-session automated
// re-ingest attempt (this ticket) still returned only the 2-paragraph free
// preview. The recovery-cap counter is already at FLAGGED_RECOVERY_CAP (3),
// so automation has stopped retrying — this needs the owner to complete a
// real Safari login before it can heal. Tracked separately; not claimed done.
// ---------------------------------------------------------------------------

const DISRUPTION_WSJ_FILE = {
  url: 'https://www.wsj.com/articles/disruption-review-ai-guinea-pigs-in-an-off-broadway-play-f116c42d',
  criticName: 'Unknown',
  contentTier: 'truncated',
  fullText: 'New York\n\nWhat’s chilling about “Disruption,” an absorbing ensemble drama...',
  aggUrlRecoveryCount: 3,
};

test('#1179 disruption/wsj "silent gap on near-opening show": this alert VARIANT can no longer fire', () => {
  // scripts/audit-t1-silent-gaps.js only pages the near-opening variant when
  // isUrgent (within URGENT_OPENING_DAYS=10 of openingDate). Disruption opened
  // 2026-08-02 — more than 10 days before "now" in every future run — so this
  // specific alert type is structurally retired for this show regardless of
  // whether the wsj file ever recovers.
  const URGENT_OPENING_DAYS = 10;
  const openingDate = '2026-08-02';
  const isUrgent = Math.abs(NOW.getTime() - Date.parse(openingDate)) <= URGENT_OPENING_DAYS * 24 * 60 * 60 * 1000;
  assert.equal(isUrgent, false);
});

test('#1082 disruption/wsj "review stuck >24h": KNOWN OPEN — WSJ paywall blocks recovery, not asserted resolved', () => {
  const gap = classify(DISRUPTION_WSJ_FILE, { tier: 1, outletScored: false });
  // Still a real, non-terminal gap — recoverable:false because the automated
  // retry cap is exhausted (won't burn further fetch attempts), not because
  // it healed. This assertion documents the current state; it does not claim
  // the alert is resolved.
  assert.deepEqual(gap, { type: 'empty-body', recoverable: false });
});
