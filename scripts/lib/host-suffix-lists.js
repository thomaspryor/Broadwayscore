/**
 * Single source of truth for the two host-suffix classifications that decide
 * WHICH dot-label of a hostname carries an outlet's identity.
 *
 * WHY THIS MODULE EXISTS (task #1188 residue). Two modules independently
 * forked these lists and then drifted apart:
 *   - outlet-canonicalize.js  (provisionalOutletIdFromHost) — mints the
 *     outletId a never-before-seen host gets registered under.
 *   - silent-exclusion-detectors.js (normalizeHostSlug) — decides whether an
 *     unregistered host is the SAME outlet as a registered one (domain move).
 * By 2026-08-11 the forks disagreed in both directions: canonicalize knew
 * tumblr.com and the detector did not; the detector knew co.id and
 * canonicalize did not. Two functions that must agree on "what is the
 * identity label of this host" cannot each keep their own list — a host
 * classified one way at registration and the other way at detection is
 * exactly the silent-exclusion shape the #1147 tracker exists to kill.
 *
 * Consumers MUST call platformSuffixOf()/multipartSuffixOf() rather than
 * re-deriving suffixes, and must not declare their own literal list — the
 * colocated test asserts both source files stay free of forked literals.
 *
 * NOTE: the two consumers legitimately differ in what they do AFTER the
 * suffix is identified (canonicalize takes the first label, the detector
 * takes the last remaining one). This module only answers "which suffix
 * applies", which is the part that must never diverge.
 */

// Blog/newsletter platforms whose own domain carries no outlet identity — the
// publication lives in the subdomain (jerryportwood.substack.com is Jerry
// Portwood's newsletter, not "substack").
const PLATFORM_HOST_SUFFIXES = Object.freeze([
  'blogspot.com',
  'ghost.io',
  'medium.com',
  'squarespace.com',
  'substack.com',
  'tumblr.com',
  'wixsite.com',
  'wordpress.com',
]);

// Multi-part public suffixes where the registrable label sits one level deeper,
// so a naive single-label strip collapses the host to "co"/"com"/"org".
// This is not hypothetical: the live registry still carries a junk tier-3
// outlet literally named "Co" (domain stagedoorjoe.co.uk) minted before this
// list existed, and one real Avenue Q (West End) review is filed under it.
const MULTIPART_PUBLIC_SUFFIXES = Object.freeze([
  'ac.uk',
  'co.id',
  'co.nz',
  'co.uk',
  'co.za',
  'com.au',
  'com.br',
  'gov.uk',
  'me.uk',
  'net.au',
  'org.au',
  'org.uk',
]);

/**
 * Normalize for suffix testing: lowercase, trimmed, no leading www.
 *
 * Leading dots are stripped and a trailing root dot (the FQDN form
 * 'example.com.') is dropped, so a malformed host cannot slice down to an
 * empty identity: '.blogspot.co.id' used to normalize to '' rather than to
 * the publication label (ship-check 2026-08-11).
 */
function cleanHost(host) {
  if (!host || typeof host !== 'string') return '';
  return host
    .toLowerCase()
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/^www\./, '');
}

// Mirror/format subdomains that are never a distinct outlet — a publisher's AMP
// or mobile host is the same outlet as its bare domain.
const MIRROR_SUBDOMAIN_PREFIX = /^(amp|m|mobile)\./;

/**
 * Is this host nothing BUT a suffix — no identity label left?
 * Used to stop prefix-stripping before it eats the publication label.
 */
function isBareSuffix(host) {
  const h = cleanHost(host);
  if (!h) return true;
  if (PLATFORM_HOST_SUFFIXES.includes(h)) return true;
  if (MULTIPART_PUBLIC_SUFFIXES.includes(h)) return true;
  return /^blogspot\.[a-z.]{2,}$/.test(h);
}

/**
 * Strip www. and any amp./m./mobile. mirror prefixes — the cosmetic labels that
 * never carry outlet identity.
 *
 * ship-check finding (2026-08-11, confirmed by direct execution): the three
 * consumers disagreed on this step, which reintroduced the very garbage-slug
 * class the shared lists close. provisionalOutletIdFromHost stripped only www.,
 * so 'm.someblog.substack.com' minted the outletId 'm' while normalizeHostSlug
 * and registrableHost both resolved 'someblog'. Meanwhile registrableHost
 * stripped mirror prefixes UNCONDITIONALLY, so a Blogger mirror whose
 * publication label happens to be 'm' ('m.blogspot.co.id') lost that label and
 * collapsed to the platform's own name.
 *
 * Hence the isBareSuffix guard: a prefix is only cosmetic if something is left
 * underneath it. If stripping would leave nothing but a public/platform suffix,
 * the label we were about to remove WAS the publication.
 *
 * @param {string} host
 * @returns {string}
 */
function stripCosmeticPrefixes(host) {
  let h = cleanHost(host);
  if (!h) return '';
  while (MIRROR_SUBDOMAIN_PREFIX.test(h)) {
    const candidate = h.replace(MIRROR_SUBDOMAIN_PREFIX, '');
    if (isBareSuffix(candidate)) break;
    h = candidate;
  }
  return h;
}

/**
 * The hosting-platform suffix this host sits on, or null.
 *
 * Blogger serves the same blogs from country mirrors (blogspot.co.id,
 * blogspot.co.uk, ...), so ANY `blogspot.<public-suffix>` counts. Without
 * this, showshowdown.blogspot.co.id fell through to the multipart branch and
 * yielded the platform's own name ("blogspot") as the outlet identity —
 * garbage that every other blog on the same mirror would collide with.
 *
 * @param {string} host
 * @returns {string|null} the matched suffix (e.g. 'substack.com'), or null
 */
function platformSuffixOf(host) {
  const h = cleanHost(host);
  if (!h) return null;
  const listed = PLATFORM_HOST_SUFFIXES.find((p) => h.endsWith('.' + p));
  if (listed) return listed;
  // Blogger country mirrors: <pub>.blogspot.<anything>
  const mirror = h.match(/\.(blogspot\.[a-z.]{2,})$/);
  return mirror ? mirror[1] : null;
}

/**
 * The multi-part public suffix this host sits on, or null. Callers should
 * test platformSuffixOf() FIRST — a platform match wins, because
 * `<pub>.blogspot.co.uk` is a platform host, not a plain .co.uk host.
 *
 * @param {string} host
 * @returns {string|null}
 */
function multipartSuffixOf(host) {
  const h = cleanHost(host);
  if (!h) return null;
  return MULTIPART_PUBLIC_SUFFIXES.find((s) => h.endsWith('.' + s)) || null;
}

module.exports = {
  PLATFORM_HOST_SUFFIXES,
  MULTIPART_PUBLIC_SUFFIXES,
  platformSuffixOf,
  multipartSuffixOf,
  stripCosmeticPrefixes,
  isBareSuffix,
};
