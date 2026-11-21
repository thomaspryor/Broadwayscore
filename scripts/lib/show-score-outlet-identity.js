const { resolveOutletFromUrl, loadOutletRegistry } = require('./review-normalization');
const { provisionalOutletIdFromHost } = require('./outlet-canonicalize');

// Preserve provisional IDs without overriding a registry resolution that
// declined the host (for example, losangeles.timeout.com is not Time Out NY).
function fallbackOutletIdFromHost(hostname) {
  const id = provisionalOutletIdFromHost(hostname);
  const registry = loadOutletRegistry();
  // Use the exact key: isRegisteredOutlet also accepts fuzzy name matches.
  return id && !(registry && registry.outlets && registry.outlets[id]) ? id : 'unknown';
}

// BRO-5741: a domain identifies a source but does not supply its masthead.
// An empty display name lets the rebuild stage it for masthead resolution.
function resolveUnlabelledShowScoreOutlet(url) {
  const resolved = resolveOutletFromUrl(url);
  if (resolved) return { outletId: resolved.outletId, displayName: resolved.displayName };
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return { outletId: fallbackOutletIdFromHost(hostname), displayName: '' };
  } catch {
    return { outletId: 'unknown', displayName: '' };
  }
}

module.exports = { fallbackOutletIdFromHost, resolveUnlabelledShowScoreOutlet };
