// Decides whether Supabase Auth will honour an OAuth redirect_to URL, using the
// same rule as GoTrue's IsRedirectURLValid:
//   1. a URL on the same hostname as site_url is always allowed;
//   2. otherwise it must match one comma-separated uri_allow_list entry, where
//      entries are globs compiled with '.' and '/' as separators ('*' and '?'
//      stop at a separator, '**' crosses them).
// A URL that fails both is silently replaced by site_url, so sign-in "works"
// but lands the user on the wrong domain.
//
// Replaces a substring check in scripts/test-ugc-roundtrip.mjs that reported
// broadwayscorecard.com as allowlisted whenever demo.broadwayscorecard.com was
// (BRO-4525).

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^./]*';
    else if (c === '?') re += '[^./]';
    else re += c.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

export function parseAllowList(allowList) {
  return String(allowList || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** @returns {{ allowed: boolean, via: 'site_url' | 'allow_list' | null, entry?: string }} */
export function checkRedirect(redirectUrl, { siteUrl, allowList }) {
  const host = hostnameOf(redirectUrl);
  if (host && host === hostnameOf(siteUrl)) return { allowed: true, via: 'site_url' };
  for (const entry of parseAllowList(allowList)) {
    if (globToRegExp(entry).test(redirectUrl)) return { allowed: true, via: 'allow_list', entry };
  }
  return { allowed: false, via: null };
}
