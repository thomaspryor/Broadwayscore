/**
 * Cast lists arrive alphabetical, so a title role can sit between ensemble
 * names (Galileo: Raúl Esparza was third, after an ensemble member; BRO-7426).
 * Named roles go first, then ensemble, swings, understudies and standbys.
 * Stable: order inside each group is kept.
 */
const SUPPORTING_ROLE = /^(ensemble|swings?|understud(y|ies)|standbys?|alternates?|dance captain|u\/s)\b/i;

/**
 * Supporting when every part of the role ("Dance Captain / Swing") leads with a
 * supporting term. "Sayu / Ensemble" keeps its named part; "Girl on a Swing"
 * is a character, not a swing.
 */
export function isSupportingRole(role: string | null | undefined): boolean {
  if (!role || !role.trim()) return true;
  return role.split(/\s*[/,;&]\s*/).filter(Boolean).every(part => SUPPORTING_ROLE.test(part.trim()));
}

type Member = { role?: string | null; flags?: string[] | null };

/** An alternate or standby for a named role carries the role plus a flag. */
function isSupporting(m: Member): boolean {
  return isSupportingRole(m.role) || (m.flags ?? []).some(f => SUPPORTING_ROLE.test(f));
}

export function principalsFirst<T extends Member>(cast: T[]): T[] {
  return [...cast.filter(m => !isSupporting(m)), ...cast.filter(m => isSupporting(m))];
}
