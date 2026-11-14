#!/usr/bin/env node
/**
 * Dry run of the Broadway + notable Off-Broadway rule (BRO-7413) over the posting ledger:
 * which posts of the last --days days (default 21) would still go out, and which would get an
 * official-account tag. Uses today's numbers, which at the time of a post were smaller, so
 * "would post" can be generous for a show that was thin on its morning-after.
 *   node scripts/social-autopost/dry-run-notability.js [--days=21] [--json]
 */
const { loadContext } = require('./run');
const { targetSets } = require('./routing');
const { signalsFor } = require('./notable');
const { loadHandles, handleFor, NETWORKS } = require('./tags');
const { getScoreTierId } = require('../lib/score-tiers');
const C = require('./config');

function rows({ days = 21, now = Date.now() } = {}) {
  const ctx = loadContext();
  const byId = new Map(ctx.shows.map(s => [s.id, s]));
  const handles = loadHandles();
  const out = [];
  for (const p of ctx.ledger.posts) {
    if (!p.dueAt || p.skipped || now - Date.parse(p.dueAt) > days * 864e5) continue;
    const ids = [...new Set([p.showId, ...(p.showIds || [])].filter(Boolean))];
    const shows = ids.map(id => byId.get(id)).filter(Boolean);
    // A compare or brief posts on its NYC (newer) show's accounts; the first listed Broadway-set show decides.
    const gated = shows.map(s => ({ s, ok: targetSets(s, null, C.CHANNEL_SETS, ctx.shows, ctx.slim).includes('broadway') }));
    const main = p.type === 'london-compare' ? gated.filter(g => g.s.id === p.showId) : p.type === 'brief' ? gated.filter(g => (g.s.slug || g.s.id) === p.slug) : gated;
    let ok = main.length ? main.some(g => g.ok) : false;
    const kept = gated.filter(g => g.ok).map(g => g.s.id);
    if (p.type === 'weekly-roundup') ok = kept.length >= C.WEEKLY_ROUNDUP.minShows;
    const subject = shows.find(s => s.id === p.showId) || (p.type === 'brief' && shows.find(s => (s.slug || s.id) === p.slug)) || shows[0];
    const sig = subject ? signalsFor(subject, ctx.slim[subject.id]) : null;
    const score = Number.isFinite(p.score) ? p.score : subject && ctx.slim[subject.id] ? Math.round(ctx.slim[subject.id].cs) : null;
    const tagged = ok && subject && ['score', 'closing-soon', 'london-compare'].includes(p.type || 'score') && score !== null
      && ['must-see', 'recommended', 'worth-seeing'].includes(getScoreTierId(score, subject.category))
      ? NETWORKS.filter(n => handleFor(handles, subject.id, n)) : [];
    out.push({ date: p.dueAt.slice(0, 10), type: p.type || 'score', id: p.showId || p.id, category: subject && subject.category, ok,
      why: ok ? 'broadway or notable' : !subject ? 'show not found' : sig ? `not notable (${sig.t1Count} tier-1, ${sig.curatedAudience} audience${subject.category === 'off-broadway' ? `; Off-Broadway needs ${C.NOTABLE_ONLY.offBroadwayMinT1}+ tier-1 or ${C.NOTABLE_ONLY.offBroadwayMinAudience}+` : ''}; ${sig.reviewCount} reviews) or not a Broadway-account market` : 'no',
      kept: p.type === 'weekly-roundup' ? kept : undefined, tagged });
  }
  return out;
}

if (require.main === module) {
  const days = +((process.argv.find(a => a.startsWith('--days=')) || '').slice(7)) || 21;
  const r = rows({ days });
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const x of r.sort((a, b) => a.date.localeCompare(b.date))) console.log(`${x.ok ? 'POSTS  ' : 'DROPPED'} ${x.date} ${x.type.padEnd(14)} ${String(x.category || '?').padEnd(12)} ${x.id}${x.ok ? '' : `  [${x.why}]`}${x.kept ? `  kept: ${x.kept.join(', ') || 'none'}` : ''}${x.tagged.length ? `  tags: ${x.tagged.join('/')}` : ''}`);
    console.log(`\n${r.filter(x => x.ok).length} of ${r.length} posts in the last ${days} days would still post.`);
  }
}
module.exports = { rows };
