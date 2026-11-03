'use strict';
/**
 * Grade an opening-night lane shadow report against the live site (BRO-6872).
 *
 * Input: the report lib/opening-night-lane-shadow.js buildShadowReport writes (shadow-report.json): one entry per
 * review with side 'both' | 'lane-only' | 'site-only' | 'lane-unscored', lane and site scores, lane scored time.
 * Output: the numbers the 2026-10 replays were graded on by hand, with a pass/fail per check:
 *   recall          lane-scored reviews the site also has / reviews the site has
 *   falsePositives  lane-scored reviews the site does not have (a non-review, a roundup, a duplicate URL, or a real
 *                   review the regular pipeline missed: listed so a person can tell which)
 *   duplicates      lane-scored reviews that are one review twice: same outlet and the same critic, the same article
 *                   path on another host, or no critic name to tell them apart
 *   scoreGaps       shared reviews whose lane and site scores differ by GAP_PTS or more, with the lane's text length
 *   timeToScore     minutes from the night's embargo (replay) or the shadow's start to each lane score
 *   publish         errors from the publish merge, and how many rows the sandbox merge accepted
 * Pure: no I/O except writeGrade. The thresholds are the gate; a replay that misses one fails.
 */
const fs = require('fs');
const path = require('path');

const GAP_PTS = 8;
const DEFAULT_THRESHOLDS = Object.freeze({ minRecall: 0.85, maxFalsePositives: 2, maxDuplicates: 0, maxPublishErrors: 0, maxMeanAbsDiff: 6 });

function outletKey(r) {
  try {
    const o = require('./review-normalization').resolveOutletFromUrl(r.url);
    if (o && o.outletId) return o.outletId;
  } catch { /* fall through */ }
  return String(r.outlet || '').toLowerCase().trim() || null;
}
const criticKey = (c) => String(c || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
const ms = (t) => { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : null; };
const round1 = (x) => Math.round(x * 10) / 10;

function pct(values, p) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

/**
 * @param {object} rep  shadow report
 * @param {object} [opts] { replayAnchorAt (ISO), sandbox ([{url,row,liveAt}] from createReplaySitePorts.live()), thresholds }
 */
function gradeShadowReport(rep, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const reviews = Array.isArray(rep && rep.reviews) ? rep.reviews : [];
  const scored = reviews.filter((r) => r.side === 'both' || r.side === 'lane-only');
  const both = reviews.filter((r) => r.side === 'both');
  const siteLive = reviews.filter((r) => r.side === 'both' || r.side === 'site-only');
  const brief = (r) => ({ url: r.url, outlet: r.outlet || null, critic: r.critic || null, laneScore: r.laneScore ?? null, siteScore: r.siteScore ?? null });

  // Two lane rows are one review when they share an outlet and either the same critic or the same article path (one
  // review on two hosts: independent.co.uk and the-independent.com). A missing byline alone is not enough: an outlet
  // with two critics (NYSR) where one row lacks a byline would otherwise fail every replay.
  const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '').toLowerCase(); } catch { return null; } };
  const same = (a, b) => {
    const ca = criticKey(a.critic); const cb = criticKey(b.critic);
    return (ca && cb && ca === cb) || Boolean(pathOf(a.url) && pathOf(a.url) === pathOf(b.url));
  };
  const byOutlet = new Map();
  for (const r of scored) { const o = outletKey(r); if (!o) continue; if (!byOutlet.has(o)) byOutlet.set(o, []); byOutlet.get(o).push(r); }
  const duplicates = [];
  for (const rs of byOutlet.values()) {
    const used = new Set();
    for (let i = 0; i < rs.length; i++) {
      if (used.has(i)) continue;
      const g = [rs[i]];
      for (let j = i + 1; j < rs.length; j++) if (!used.has(j) && g.some((x) => same(x, rs[j]))) { g.push(rs[j]); used.add(j); }
      if (g.length > 1) duplicates.push(g.map(brief));
    }
  }

  const diffs = both.filter((r) => r.laneScore != null && r.siteScore != null).map((r) => ({ ...brief(r), delta: r.laneScore - r.siteScore, laneTextChars: r.laneTextChars ?? null, laneContentTier: r.laneContentTier || null }));
  const meanAbsDiff = diffs.length ? round1(diffs.reduce((a, d) => a + Math.abs(d.delta), 0) / diffs.length) : null;
  const scoreGaps = diffs.filter((d) => Math.abs(d.delta) >= GAP_PTS).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const t0 = ms(opts.replayAnchorAt) ?? ms(rep && rep.startedAt);
  const tts = t0 == null ? [] : scored.map((r) => ms(r.laneScoredAt)).filter((t) => t != null).map((t) => Math.round((t - t0) / 60000));

  const publishErrors = ((rep && rep.laneErrorsByAdapter && rep.laneErrorsByAdapter.publish) || {}).count || 0;
  const sandboxPublished = Array.isArray(opts.sandbox) ? opts.sandbox.length : null;
  const recall = siteLive.length ? Math.round((both.length / siteLive.length) * 1000) / 1000 : null;
  const falsePositives = reviews.filter((r) => r.side === 'lane-only').map(brief);

  const checks = [
    { name: 'recall', value: recall, threshold: `>= ${th.minRecall}`, pass: recall != null && recall >= th.minRecall },
    { name: 'falsePositives', value: falsePositives.length, threshold: `<= ${th.maxFalsePositives}`, pass: falsePositives.length <= th.maxFalsePositives },
    { name: 'duplicates', value: duplicates.length, threshold: `<= ${th.maxDuplicates}`, pass: duplicates.length <= th.maxDuplicates },
    { name: 'publishErrors', value: publishErrors, threshold: `<= ${th.maxPublishErrors}`, pass: publishErrors <= th.maxPublishErrors },
    { name: 'meanAbsScoreDiff', value: meanAbsDiff, threshold: `<= ${th.maxMeanAbsDiff}`, pass: meanAbsDiff == null || meanAbsDiff <= th.maxMeanAbsDiff },
  ];
  if (sandboxPublished != null) checks.push({ name: 'sandboxPublished', value: sandboxPublished, threshold: '> 0 when anything scored', pass: !scored.length || sandboxPublished > 0 });

  return {
    show: rep && rep.show, night: rep && rep.night, replayAnchorAt: opts.replayAnchorAt || null,
    pass: checks.every((c) => c.pass), checks,
    counts: { laneScored: scored.length, siteLive: siteLive.length, both: both.length, laneOnly: falsePositives.length, siteOnly: reviews.filter((r) => r.side === 'site-only').length, laneUnscored: reviews.filter((r) => r.side === 'lane-unscored').length },
    recall, meanAbsScoreDiff: meanAbsDiff,
    falsePositives, missed: reviews.filter((r) => r.side === 'site-only').map(brief), duplicates, scoreGaps,
    timeToScoreMin: { median: pct(tts, 50), p90: pct(tts, 90), max: tts.length ? Math.max(...tts) : null, from: opts.replayAnchorAt ? 'embargo' : 'shadow start' },
    publish: { errors: publishErrors, sandboxPublished },
  };
}

function gradeMarkdown(g) {
  const row = (r) => `${r.outlet || r.url}${r.critic ? ` (${r.critic})` : ''}`;
  const lines = [
    `## Lane replay grade: ${g.show} (${g.night}): ${g.pass ? 'PASS' : 'FAIL'}`,
    '',
    ...g.checks.map((c) => `- ${c.pass ? 'ok' : 'FAIL'} ${c.name}: ${c.value == null ? 'n/a' : c.value} (${c.threshold})`),
    `- Lane scored ${g.counts.laneScored}, site has ${g.counts.siteLive}, both ${g.counts.both}, lane only ${g.counts.laneOnly}, site only ${g.counts.siteOnly}, lane unscored ${g.counts.laneUnscored}.`,
    `- Time to score (min from ${g.timeToScoreMin.from}): median ${g.timeToScoreMin.median ?? 'n/a'}, p90 ${g.timeToScoreMin.p90 ?? 'n/a'}, max ${g.timeToScoreMin.max ?? 'n/a'}.`,
    ...(g.falsePositives.length ? ['', 'Lane only:', ...g.falsePositives.map((r) => `- ${row(r)} ${r.laneScore} ${r.url}`)] : []),
    ...(g.missed.length ? ['', 'Site only (missed):', ...g.missed.map((r) => `- ${row(r)} ${r.siteScore} ${r.url}`)] : []),
    ...(g.duplicates.length ? ['', 'Duplicates:', ...g.duplicates.map((d) => `- ${d.map((r) => r.url).join(' | ')}`)] : []),
    ...(g.scoreGaps.length ? ['', `Score gaps of ${GAP_PTS}+ (lane / site, lane text chars, tier):`, ...g.scoreGaps.map((d) => `- ${row(d)} ${d.laneScore} / ${d.siteScore} (${d.delta > 0 ? '+' : ''}${d.delta}), ${d.laneTextChars ?? '?'} chars, ${d.laneContentTier || '?'}`)] : []),
  ];
  return `${lines.join('\n')}\n`;
}

function writeGrade(outDir, g) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'shadow-grade.json'), `${JSON.stringify(g, null, 2)}\n`);
  const md = gradeMarkdown(g);
  fs.writeFileSync(path.join(outDir, 'shadow-grade.md'), md);
  return md;
}

module.exports = { GAP_PTS, DEFAULT_THRESHOLDS, gradeShadowReport, gradeMarkdown, writeGrade };
