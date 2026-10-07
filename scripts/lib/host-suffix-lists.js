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
  // Fewer than two labels cannot be "identity + suffix" — it IS the suffix.
  // Without this, stripping a mirror prefix off a two-label host ate the
  // identity: 'amp.com' normalized to 'com' and 'm.com' minted null, which
  // ingest-review-from-url.js turns into a dropped review (ship-check
  // 2026-08-12, confirmed by direct execution).
  if (h.split('.').filter(Boolean).length < 2) return true;
  if (PLATFORM_HOST_SUFFIXES.includes(h)) return true;
  if (MULTIPART_PUBLIC_SUFFIXES.includes(h)) return true;
  return isBloggerMirror(h);
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
/**
 * Is this host exactly a Blogger country mirror (`blogspot.<public-suffix>`)?
 *
 * The tail must be a REAL public suffix — a single-label TLD, or a member of
 * MULTIPART_PUBLIC_SUFFIXES. An earlier `/^blogspot\.[a-z.]{2,}$/` accepted any
 * tail, so 'foo.blogspot.example.com' was treated as a platform host and
 * registrableHost returned the whole host instead of 'example.com', giving
 * every `<x>.blogspot.example.com` its own outlet identity (ship-check
 * 2026-08-12, confirmed by direct execution).
 */
function isBloggerMirror(host) {
  const h = cleanHost(host);
  if (!h.startsWith('blogspot.')) return false;
  const tail = h.slice('blogspot.'.length);
  if (!tail) return false;
  const labels = tail.split('.');
  // One label = a plain TLD ('blogspot.com').
  if (labels.length === 1) return /^[a-z]{2,}$/.test(labels[0]);
  // Two labels = a country mirror, IF the last is a 2-letter ccTLD:
  // blogspot.com.es / .co.il / .com.ar / .com.tr ... Blogger runs ~14 of
  // these beyond MULTIPART_PUBLIC_SUFFIXES' 12 entries, so enumerating was
  // WORSE than the unanchored regex it replaced — 'foo.blogspot.com.es'
  // minted the outletId 'com' (ship-check round 2, 2026-08-12). The ccTLD
  // shape is what separates a real mirror from 'blogspot.example.com',
  // whose last label 'com' is 3 chars and is correctly rejected.
  if (labels.length === 2) return /^[a-z]{2,4}$/.test(labels[0]) && /^[a-z]{2}$/.test(labels[1]);
  return false;
}

function platformSuffixOf(host) {
  const h = cleanHost(host);
  if (!h) return null;
  const listed = PLATFORM_HOST_SUFFIXES.find((p) => h.endsWith('.' + p));
  if (listed) return listed;
  // Blogger country mirrors: <pub>.blogspot.<public-suffix>. lastIndexOf, not
  // indexOf — on 'a.blogspot.b.blogspot.co.uk' the FIRST occurrence resolves
  // against the wrong tail and the whole host falls through to a 'blogspot'
  // identity (ship-check round 2, 2026-08-12).
  const dot = h.lastIndexOf('.blogspot.');
  if (dot === -1) return null;
  const tail = h.slice(dot + 1);
  return isBloggerMirror(tail) ? tail : null;
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
