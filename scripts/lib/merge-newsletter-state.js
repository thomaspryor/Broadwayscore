'use strict';
// Per-issue merge for data/newsletter-state.json (BRO-5509).
//
// Why this exists:
//   The weekly newsletter's anti-repeat ledger has several concurrent writers:
//   newsletter-draft.yml (one run per edition, now on per-edition concurrency
//   groups so the Sunday recovery stops evicting an edition), the
//   newsletter-draft-refresh.yml matrix (broadway + west-end jobs in parallel)
//   and newsletter-state-reconcile.yml. Each run reads the file, upserts its
//   own edition's issue for the week (scripts/newsletter/generate.mjs) and
//   pushes through push-with-retry.sh. Both editions append at the end of the
//   same `issues` array, so the rebase (-X theirs) or the generic conflict arm
//   kept one side whole and silently dropped the other edition's issue entry.
//   A dropped entry means next week's draft cannot suppress the shows that
//   issue already featured.
//
// Shape: { issues: [ { weekStart, edition, moverShowIds, announcedClosingShowIds,
//          featuredShowIds, awardMoverSnapshotDate? }, ... ] }
//
// Natural key: `${weekStart}|${edition}`, edition defaulting to 'broadway'
// exactly like generate.mjs's _issueEdition() (legacy entries have none).
//
// Merge rules (three-way per key when the base is available):
//   * both sides hold the key: ours wins, unless ours is unchanged from base
//     and remote changed it (e.g. verify-sent-vs-state.mjs self-healing the
//     featuredShowIds of an existing issue), then remote wins.
//   * only one side holds the key: kept, unless base held it and the holding
//     side left it unchanged (the other side deleted it: the writer's
//     slice(-MAX_ISSUES) prune or the reconciler dropping a phantom entry).
//   * no base (add/add conflict, unreadable base): plain union, ours wins.
//   * result sorted by weekStart (stable) and capped to the newest MAX_ISSUES,
//     the same cap the writer applies, so a union can never grow the ledger
//     past what generate.mjs would keep.
//   * other top-level fields: remote's, overlaid with ours.

// The writer's cap (generate.mjs: slice(-24), ~12 weeks x 2 editions).
const MAX_ISSUES = 24;

function keyOf(issue) {
  if (!issue || typeof issue !== 'object' || !issue.weekStart) return null;
  return `${issue.weekStart}|${issue.edition || 'broadway'}`;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function indexIssues(doc) {
  const map = new Map();
  const list = doc && typeof doc === 'object' && Array.isArray(doc.issues) ? doc.issues : [];
  for (const i of list) {
    const k = keyOf(i);
    if (k) map.set(k, i);
  }
  return { list, map };
}

function mergeNewsletterState(ours, remote, base) {
  const o = indexIssues(ours);
  const r = indexIssues(remote);
  const hasBase = !!(base && typeof base === 'object' && Array.isArray(base.issues));
  const b = indexIssues(hasBase ? base : null);

  const stats = { addedFromRemote: 0, takenFromRemote: 0, deletesHonored: 0, droppedOld: 0, baseAvailable: hasBase };
  const out = [];
  const seen = new Set();

  // Ours first, in our order; remote-only entries appended after.
  for (const issue of o.list) {
    const k = keyOf(issue);
    if (!k) { out.push(issue); continue; }
    if (seen.has(k)) continue;
    seen.add(k);
    if (r.map.has(k)) {
      const theirs = r.map.get(k);
      if (hasBase && b.map.has(k) && same(issue, b.map.get(k)) && !same(theirs, issue)) {
        out.push(theirs);
        stats.takenFromRemote++;
      } else {
        out.push(issue);
      }
    } else if (hasBase && b.map.has(k) && same(issue, b.map.get(k))) {
      stats.deletesHonored++; // remote deleted it, we did not touch it
    } else {
      out.push(issue);
    }
  }
  for (const issue of r.list) {
    const k = keyOf(issue);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (hasBase && b.map.has(k) && same(issue, b.map.get(k))) {
      stats.deletesHonored++; // we deleted it, remote did not touch it
      continue;
    }
    out.push(issue);
    stats.addedFromRemote++;
  }

  const ws = (i) => (i && typeof i.weekStart === 'string' ? i.weekStart : '');
  const sorted = out.map((i, idx) => [i, idx]).sort((x, y) => ws(x[0]).localeCompare(ws(y[0])) || x[1] - y[1]).map((p) => p[0]);
  const capped = sorted.length > MAX_ISSUES ? sorted.slice(-MAX_ISSUES) : sorted;
  stats.droppedOld = sorted.length - capped.length;
  stats.totalIssues = capped.length;

  const merged = {
    ...(remote && typeof remote === 'object' ? remote : {}),
    ...(ours && typeof ours === 'object' ? ours : {}),
    issues: capped,
  };
  return { merged, stats };
}

module.exports = { mergeNewsletterState, keyOf, MAX_ISSUES };
