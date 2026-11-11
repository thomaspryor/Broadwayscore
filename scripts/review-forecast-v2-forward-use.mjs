#!/usr/bin/env node
// BRO-7347: coverage of dated Show Score member reviews, and agreement between the dated
// pre-opening member mean and the live audience-buzz aggregate (score) on shows with both.
// Read-only over committed files. audience-buzz.json is a current aggregate (not dated), so
// agreement is an upper bound on how well a live preview aggregate would match.
import fs from 'fs';
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) || 'data/audit/review-forecast-v2-forward-use.json';
const members = JSON.parse(fs.readFileSync('data/audit/review-forecast-v2-showscore-members.json', 'utf8')).shows;
const shows = JSON.parse(fs.readFileSync('data/shows.json', 'utf8')); const arr = shows.shows || shows;
const open = Object.fromEntries(arr.map(s => [s.id, s.openingDate]));
const buzz = JSON.parse(fs.readFileSync('data/audience-buzz.json', 'utf8')); const A = buzz.shows || buzz;
const S = Object.keys(members).map(id => ({ id, ...members[id], open: open[id] }));
const mean = x => x.reduce((a, b) => a + b, 0) / x.length;
const era = s => { const y = +String(s.open || '0').slice(0, 4); return y >= 2024 ? '2024+' : y >= 2019 ? '2019-2023' : 'pre-2019'; };
const cover = {};
for (const s of S) { const k = era(s); cover[k] ??= { shows: 0, withMemberReviews: 0 }; cover[k].shows++; if (s.n > 0) cover[k].withMemberReviews++; }
const pairs = S.filter(s => s.n >= 5).map(s => [s.mean, A[s.id]?.sources?.showScore?.score]).filter(p => p[1] != null);
const X = pairs.map(p => p[0]), Y = pairs.map(p => p[1]); const cx = mean(X), cy = mean(Y);
let sxy = 0, sxx = 0, syy = 0; pairs.forEach(p => { sxy += (p[0] - cx) * (p[1] - cy); sxx += (p[0] - cx) ** 2; syy += (p[1] - cy) ** 2; });
const res = {
  card: 'BRO-7347', computed: new Date().toISOString().slice(0, 10),
  showsTried: S.length, withAnyDatedMemberReview: S.filter(s => s.n > 0).length, none: S.filter(s => !s.n).length,
  byEra: cover,
  earlierRunDrop: { showsTouched: S.filter(s => s.earlierRunN > 0).length, reviewsDropped: S.reduce((a, s) => a + (s.earlierRunN || 0), 0) },
  coverage: { capped12Pages: S.filter(s => s.capped).length, newestReviewMoreThan7DaysBeforeCutoff: S.filter(s => s.gapNewestToCutoffDays > 7).length, withReviewsWithin7DaysOfCutoff: S.filter(s => s.n > 0 && s.gapNewestToCutoffDays <= 7).length },
  agreementWithLiveAggregate: { shows: pairs.length, correlation: +(sxy / Math.sqrt(sxx * syy)).toFixed(2), meanMember: +cx.toFixed(1), meanAggregate: +cy.toFixed(1), meanAbsDiff: +mean(pairs.map(p => Math.abs(p[0] - p[1]))).toFixed(1), caveat: 'audience-buzz is the current aggregate (includes post-opening reviews); not a dated preview history' },
};
fs.writeFileSync(out, JSON.stringify(res, null, 2) + '\n'); console.log(JSON.stringify(res));
