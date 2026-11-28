/**
 * Which IBDB cast members are principals: the {name, role} list that
 * scripts/enrich-cast-from-files.js writes into shows.json `cast`.
 * Extracted from that script (BRO-5848) so the rules are tested against the
 * real functions (CLAUDE.md §15).
 */
'use strict';

const { cleanRole } = require('./cast-role');

// Roles that indicate non-principal cast (regex on full role string)
const NON_PRINCIPAL_ROLE_RE = /^(ensemble|performer|dancer|singer|chorus|swing)$/i;
const NON_PRINCIPAL_ROLE_CONTAINS_RE = /\b(ensemble|swing|standby|understudy|chorus)\b/i;

// Flags that indicate non-principal or excluded cast
const EXCLUDED_FLAGS = new Set([
  'Alternate',
  'Recorded voice only',
  'Movie Cast',
  'Was replaced in previews',
  'Role was cut during previews',
  'Movie Cast/Hollywood Cast',
  'Appeared in film sequence only',
]);
const EXCLUDED_FLAG_PARTIAL = ['at some performances'];

/**
 * IBDB flags stars who alternated a role as "Alternate", plus "Played <role>
 * on opening night" for whoever opened it. That person is the lead, not a
 * cover: The Little Foxes (2017) lost Laura Linney and Cynthia Nixon to the
 * Alternate filter.
 */
function playedOnOpeningNight(member) {
  return (member.flags || []).some(f => /^played .+ on opening night$/i.test(String(f).trim()));
}

function normRole(m) {
  return (m.role || '').trim().toLowerCase();
}

/**
 * @param member       IBDB cast row
 * @param totalSourceSize  size of the cast list it came from
 * @param genericRoleCount how many rows in that list share this member's
 *   exact role. A generic label held by ONE person is that show's performer,
 *   not an ensemble: The Picture of Dorian Gray (2025) lists Sarah Snook as
 *   the lone "Performer" beside five camera operators, and the old rule
 *   dropped her and kept the camera crew.
 */
function isPrincipalCast(member, totalSourceSize, genericRoleCount = 2) {
  const role = (member.role || '').trim();

  // For small casts (≤5 members), skip the exact-match generic role filter.
  // IBDB uses "Ensemble" or "Performer" as actual roles for solo shows (e.g.,
  // Every Brilliant Thing) and comedy specials (e.g., All Out). In big casts,
  // these labels genuinely mean non-principal ensemble.
  const isSmallCast = totalSourceSize <= 5;

  // For solo shows (1 cast member), replace generic roles with "Narrator"
  // One-person shows shouldn't display "Ensemble" — it's misleading
  if (totalSourceSize === 1 && /^(Ensemble|Performer|Cast)$/i.test(role)) {
    member.role = 'Narrator';
  }

  // Exact match on generic non-principal roles (skip for small casts, and for
  // the lone "Performer"/"Singer" of a show; a lone "Ensemble" credit is
  // still an ensemble member, e.g. Dracula, the Musical 2004)
  const loneGeneric = genericRoleCount === 1 && /^(performer|singer)$/i.test(role);
  if (!isSmallCast && !loneGeneric && NON_PRINCIPAL_ROLE_RE.test(role)) return false;

  // Contains swing/standby/understudy/chorus as a word
  // For small casts, only filter on these clearly non-principal keywords
  // (not "ensemble"/"performer" which may be the actual role label)
  if (isSmallCast || loneGeneric) {
    if (/\b(swing|standby|understudy|chorus)\b/i.test(role)) return false;
  } else {
    if (NON_PRINCIPAL_ROLE_CONTAINS_RE.test(role)) return false;
  }

  // Check flags
  const flags = member.flags || [];
  const openedTheRole = playedOnOpeningNight(member);
  for (const flag of flags) {
    if (flag === 'Alternate' && openedTheRole) continue;
    if (EXCLUDED_FLAGS.has(flag)) return false;
    for (const partial of EXCLUDED_FLAG_PARTIAL) {
      if (flag.toLowerCase().includes(partial)) return false;
    }
  }

  return true;
}

/**
 * Principals of one show, as {name, role}, capped at maxMembers. Open shows
 * use currentCast when IBDB has one; closed shows use the opening-night cast.
 * Returns null when there is no usable cast.
 */
function extractCast(castData, showStatus, maxMembers) {
  const isOpen = showStatus === 'open' || showStatus === 'previews';

  let source;
  if (isOpen && castData.currentCast && castData.currentCast.length > 0) {
    source = castData.currentCast;
  } else if (castData.openingNightCast && castData.openingNightCast.length > 0) {
    source = castData.openingNightCast;
  } else {
    return null; // No usable cast data
  }

  // Revue/ensemble detection: if ALL source members share the same generic role
  // (e.g. "Performer" for Celebrity Autobiography), IBDB is using the label as
  // the actual role name — treat all as principals instead of filtering out.
  const roles = new Set(source.map(normRole));
  const isUniformGenericRole = roles.size === 1 && NON_PRINCIPAL_ROLE_RE.test([...roles][0]);

  const roleCounts = new Map();
  for (const m of source) roleCounts.set(normRole(m), (roleCounts.get(normRole(m)) || 0) + 1);

  // A one-person cast is always "uniform", so run it through isPrincipalCast
  // too: that is where a solo "Performer" becomes "Narrator".
  const principals = isUniformGenericRole && source.length > 1
    ? source
    : source.filter(m => isPrincipalCast(m, source.length, roleCounts.get(normRole(m))));
  if (principals.length === 0) return null;

  // Deduplicate by name (alternates/replacements may share a role)
  const seen = new Set();
  const deduped = principals.filter(m => {
    const key = m.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, maxMembers).map(m => {
    const entry = { name: m.name };
    const role = cleanRole(m.role);
    if (role) entry.role = role;
    return entry;
  });
}

module.exports = { isPrincipalCast, extractCast, playedOnOpeningNight, NON_PRINCIPAL_ROLE_RE, EXCLUDED_FLAGS };
