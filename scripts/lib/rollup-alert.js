'use strict';
/**
 * Fold N per-item findings from one audit run into ONE owner alert with a
 * stable key (BRO-5493 / BRO-5496). Per-item conditionKeys make the alert
 * router file one near-identical Linear card per item; one rollup key keeps a
 * single card that the next run updates.
 *
 * routeAlert never edits an open card (a re-fire only touches the ledger row),
 * so items that appear AFTER the card was filed would be invisible. syncRollup
 * comments them on the existing card and remembers the members it has already
 * reported in the ledger row field `rollupMembers`.
 */

function buildRollupAlert({ key, items, itemId, itemBlock, title, intro, footer, hint, severity = 'warning', disposition = 'auto', cooldownHours = 12 }) {
  if (!Array.isArray(items) || !items.length) return null;
  const opts = {
    conditionKey: key,
    title: typeof title === 'function' ? title(items) : title,
    description: `${intro(items)}\n\n${items.map(itemBlock).join('\n')}${footer ? `\n\n${footer}` : ''}`,
    severity,
    disposition,
    cooldownHours,
  };
  if (hint) opts.hint = typeof hint === 'function' ? hint(items) : hint;
  return opts;
}

/**
 * Members already reported on the open card. MUST be read BEFORE routeAlert:
 * a cooldown-expired re-fire rewrites the ledger row and drops this field, so
 * reading afterwards would re-comment every member each cooldown. Falls back to
 * the BRO-5493 field name (rollupShows) so the rename loses nothing.
 */
function snapshotRollupMembers(key, deps = {}) {
  const router = deps.router || require('./owner-alert-router');
  const row = router.loadLedger().conditions[key] || {};
  return [...(row.rollupMembers || row.rollupShows || [])];
}

async function syncRollup({ key, items, itemId, itemBlock, header, priorMembers }, result, deps = {}) {
  if (!result || !Array.isArray(items) || !items.length) return { commented: 0 };
  const filedNow = result.action && result.action !== 'silent';
  if (!filedNow && !result.linearIdentifier) return { commented: 0 };
  const router = deps.router || require('./owner-alert-router');
  const ids = items.map(itemId);
  const known = new Set(priorMembers || snapshotRollupMembers(key, { router }));
  const added = filedNow ? [] : items.filter((it) => !known.has(itemId(it)));
  if (added.length) {
    const client = deps.linearClient || require('./linear-client');
    const issue = await client.getIssue(result.linearIdentifier);
    if (!issue || !issue.id) throw new Error(`rollup tracker ${result.linearIdentifier} not found`);
    await client.createComment(issue.id, `${header(added)}\n\n${added.map(itemBlock).join('\n')}`);
  }
  router.patchCondition(key, { rollupMembers: filedNow ? ids : [...new Set([...known, ...ids])] });
  return { commented: added.length };
}

module.exports = { buildRollupAlert, syncRollup, snapshotRollupMembers };
