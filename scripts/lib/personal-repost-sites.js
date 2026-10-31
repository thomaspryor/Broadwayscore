/**
 * BRO-2403 — critic personal-repost sites.
 *
 * A critic's own site (showriz.com = Frank Rizzo) sometimes reposts their staff
 * review verbatim ("My Variety Review: ..."). Ingested as its own outlet that
 * double-counts one critic (paranormal-activity-2026: Variety + Showriz, 78).
 * Only posts that self-identify as a repost of the parent outlet's review are
 * excluded; the site's original takes ("My Own Take: ...") stay independent.
 */

const PERSONAL_REPOST_SITES = {
  'showriz.com': { criticName: 'Frank Rizzo', parentOutletId: 'variety', parentNames: ['variety'] },
};

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function siteFor(host) {
  if (!host) return null;
  for (const d of Object.keys(PERSONAL_REPOST_SITES)) {
    if (host === d || host.endsWith('.' + d)) return PERSONAL_REPOST_SITES[d];
  }
  return null;
}

/**
 * @param {object} data review file/record ({url, title?, fullText?})
 * @returns {string|null} parent outlet id when this is a personal-site repost of it
 */
function personalRepostParent(data) {
  if (!data) return null;
  const site = siteFor(hostOf(data.url));
  if (!site) return null;
  if (data.personalRepostCleared === true) return null;
  const head = `${data.title || ''}\n${String(data.fullText || '').slice(0, 300)}`;
  for (const name of site.parentNames) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\bmy\\s+${n}\\s+review\\b|\\bas\\s+(?:i\\s+)?(?:originally\\s+)?(?:published|ran)\\s+(?:in|on|at)\\s+${n}\\b|\\boriginally\\s+(?:published|appeared)\\s+(?:in|on|at)\\s+${n}\\b`, 'i');
    if (re.test(head)) return site.parentOutletId;
  }
  return null;
}

module.exports = { PERSONAL_REPOST_SITES, personalRepostParent };
