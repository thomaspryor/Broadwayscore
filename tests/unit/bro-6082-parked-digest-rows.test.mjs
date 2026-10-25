// BRO-6082: digest rows that parked as "kept failing" because no cloud session
// could close them. Covers the off-topic-section URL rule (discovery + write +
// silent-gap audit), the needs-manual-recovery split of the T1/T2 gap row, and
// the corpus-drift FYI line for monitor-only audits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { classifyReviewUrl, offTopicSectionReason } = require('../../scripts/lib/non-review-url-patterns.js');
const {
  classifySilentGap, classifyGapCardState, GAP_CARD_STATE,
  needsManualRecovery, manualRecoveryDigestLine, MANUAL_RECOVERY_CONDITION_KEY,
} = require('../../scripts/lib/t1-silent-gap.js');
const { silentGapBacklogResults } = require('../../scripts/health-check.js');
const { untrackedDriftLine, UNTRACKED_DRIFT_CONDITION_KEY } = require('../../scripts/check-corpus-drift.js');

// The two real wrong-article discoveries this card found.
const TIMES_FOOTBALL = 'https://www.thetimes.co.uk/sport/football/article/bayern-munich-arsenal-champions-league-table-result-score-6vmlkkd2n';
const INDY_OBIT = 'https://www.independent.co.uk/arts-entertainment/films/news/tom-skerritt-dead-top-gun-picket-fences-b3071792.html';

test('off-topic newspaper sections are not review URLs; real review paths still are', () => {
  for (const u of [TIMES_FOOTBALL, INDY_OBIT, 'https://www.theguardian.com/tv-and-radio/obituaries/2026/oct/01/someone', 'https://www.nytimes.com/2026/10/01/sports/score.html']) {
    assert.equal(classifyReviewUrl(u).ok, false, u);
    assert.equal(offTopicSectionReason(u), 'off-topic-section', u);
  }
  for (const u of [
    'https://www.vulture.com/article/theater-review-fences.html',
    'https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews/fences-review-b3071000.html',
    'https://msn.foxsports.com/nfl/story/Lombardi-on-Broadway-play-review-102110',
  ]) {
    assert.equal(offTopicSectionReason(u), null, u);
  }
  assert.equal(offTopicSectionReason('not a url'), null);
});

test('the writer refuses to create a review file at an off-topic section URL', () => {
  const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6082-writer-'));
  fs.mkdirSync(path.join(root, 'the-score-regional-2026'), { recursive: true });
  const r = createOrMergeReviewFile('the-score-regional-2026', {
    outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'Unknown',
    url: TIMES_FOOTBALL, source: 'outlet-listing-poller', fields: {},
  }, { reviewTextsDir: root });
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /^off-topic-section-url/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'the-score-regional-2026')), []);
  fs.rmSync(root, { recursive: true, force: true });
});

// The Times file as it sat in the corpus: empty, bot-blocked, no verdict.
const timesFile = () => ({
  showId: 'the-score-regional-2026', outletId: 'times-uk', criticName: 'Unknown',
  url: TIMES_FOOTBALL, source: 'outlet-listing-poller', contentTier: 'stub',
  contentTierReason: 'No text content', incompleteReason: 'bot_blocked', needsTextRetry: true,
});

test('an empty file at an off-topic URL is not a silent gap, and its card closes', () => {
  const args = { file: timesFile(), show: { id: 'the-score-regional-2026', title: 'The Score' }, tier: 2, outletScored: false, now: new Date() };
  assert.equal(classifySilentGap(args), null);
  assert.equal(classifyGapCardState(args), GAP_CARD_STATE.NO_REVIEW);
  // Same file at a plausible review URL is still a gap (the rule is URL-driven).
  const real = { ...args, file: { ...timesFile(), url: 'https://www.thetimes.co.uk/article/the-score-review-xyz' } };
  assert.equal(classifySilentGap(real)?.type, 'empty-body');
  // Other classifier rejections are NOT this rule: non-review-host also matches
  // real reviews (4columns.org), so an empty file there is still a gap.
  const fourColumns = { ...args, file: { ...timesFile(), url: 'https://4columns.org/cote-david/a-streetcar-named-desire-2025' } };
  assert.equal(classifyReviewUrl(fourColumns.file.url).ok, false, 'precondition: classifier rejects the host');
  assert.equal(classifySilentGap(fourColumns)?.type, 'empty-body');
  // A human clear of the URL exclusion restores the gap.
  const cleared = { ...args, file: { ...timesFile(), listingPageUrlManualClear: true } };
  assert.equal(classifySilentGap(cleared)?.type, 'empty-body');
});

const NOW = new Date('2026-10-23T20:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const gap = (o) => ({ showId: 's', file: 'f.json', outletId: 'daily-mail', tier: 1, title: 'Golden Boy', ...o });

test('needsManualRecovery needs no automated path AND both clocks', () => {
  const base = { type: 'rejected-unscoreable', recoverable: false, firstSeen: daysAgo(31), gapSeenAt: daysAgo(2) };
  assert.equal(needsManualRecovery(gap(base), NOW), true);
  assert.equal(needsManualRecovery(gap({ ...base, recoverable: true }), NOW), false, 'hourly recovery still has tries');
  assert.equal(needsManualRecovery(gap({ ...base, firstSeen: daysAgo(3) }), NOW), false, 'file too new');
  assert.equal(needsManualRecovery(gap({ ...base, gapSeenAt: daysAgo(0.5) }), NOW), false, 'old file, gap only just opened');
  assert.equal(needsManualRecovery(gap({ ...base, gapSeenAt: undefined }), NOW), false, 'unstamped fails toward dispatch');
  assert.equal(needsManualRecovery(gap({ ...base, type: 'unscored', dispatchable: true }), NOW), false, 'scoring dispatch can still run');
  assert.equal(needsManualRecovery(gap({ ...base, type: 'unscored', dispatchable: false }), NOW), true);
  assert.equal(needsManualRecovery(null, NOW), false);
  // Talkin' Broadway forum stub: recoverable reads false between the daily slow
  // tries; the remaining budget keeps it with automation until it is spent.
  const forum = { ...base, type: 'empty-body', url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2654721' };
  assert.equal(needsManualRecovery(gap({ ...forum, forumLinkRecoveryCount: 7 }), NOW), false);
  assert.equal(needsManualRecovery(gap({ ...forum, forumLinkRecoveryCount: 10 }), NOW), true);
});

test('manual-recovery gaps leave the dispatched row and become one FYI line', () => {
  const manual = gap({ type: 'rejected-unscoreable', recoverable: false, firstSeen: daysAgo(31), gapSeenAt: daysAgo(2), needsManualRecovery: true });
  const active = gap({ showId: 's2', file: 'g.json', outletId: 'independent', title: 'Fences', type: 'empty-body', recoverable: true, firstSeen: daysAgo(3), gapSeenAt: daysAgo(2), needsManualRecovery: false });
  assert.deepEqual(silentGapBacklogResults({ gaps: [manual] }, NOW), [], 'manual-only report has no dispatched row');
  const rows = silentGapBacklogResults({ gaps: [manual, active] }, NOW);
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /^1 discovered review/);
  assert.doesNotMatch(rows[0].message, /in flight/, 'manual gaps are not miscounted as in flight');

  assert.equal(manualRecoveryDigestLine([active], NOW), null);
  const line = manualRecoveryDigestLine([manual, { ...manual, file: 'dup.json' }, active], NOW);
  assert.equal(line.conditionKey, MANUAL_RECOVERY_CONDITION_KEY);
  assert.equal(line.info, true);
  assert.match(line.title, /: 1 \(Golden Boy \(daily-mail\)\)/, 'deduped per show+outlet, named in the title');
});

test('monitor-only drift becomes one FYI line; carded audits are left to their own cards', () => {
  const audits = [
    { name: 'regex-fp', ok: false, crashed: false, channel: 'fyi' },
    { name: 'duplicate-shows', ok: false, crashed: false, channel: 'card' },
    { name: 'text-quality', ok: true, crashed: false, channel: 'fyi' },
    { name: 'broken', ok: false, crashed: true, channel: 'fyi' },
  ];
  const line = untrackedDriftLine(audits, '2026-10-23T17:32:20.381Z');
  assert.equal(line.conditionKey, UNTRACKED_DRIFT_CONDITION_KEY);
  assert.equal(line.info, true);
  assert.match(line.title, /: 1 \(regex-fp\)\. Checked 2026-10-23\./);
  assert.equal(untrackedDriftLine(audits.filter((a) => a.channel === 'card'), 'x'), null);
});
