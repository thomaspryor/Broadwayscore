/**
 * Tony season label repair (BRO-5667). awards.json carried tony.season labels
 * one season off for 18 Broadway shows (smash-2025 "2023-24" with ceremony
 * "78th"), and the fantasy scorer filters every award record by season, so a
 * mislabel scores a real nomination as 0. Three independent signals name a
 * show's Tony season: the stored label, the ceremony number, and the Tony
 * window its opening date falls in. When two agree and the third does not,
 * the two win. Opening date alone is not trusted: slave-play-2021 stores its
 * 2021 return engagement but was nominated at the 74th for 2019.
 */
function ceremonyToSeason(ceremony) {
  const n = parseInt(ceremony, 10);
  if (!Number.isFinite(n)) return null;
  // 74th = 2020 ceremony (held Sept 2021); 75th = 2022 (no 2021 ceremony).
  const year = n <= 74 ? n + 1946 : n + 1947;
  return `${year - 1}-${String(year).slice(2)}`;
}

function seasonToCeremony(season) {
  const year = Number(season.slice(0, 4)) + 1;
  if (year === 2021) return null; // 2020-21: no ceremony (the 74th, held 2021, was for 2019-20)
  const n = year <= 2020 ? year - 1946 : year - 1947;
  const sfx = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${sfx}`;
}

/** → { season, ceremony } to store, or null when the record is consistent or no two signals agree. */
function resolveTonySeason({ label, ceremony, windowLabel }) {
  const fromCeremony = ceremony ? ceremonyToSeason(ceremony) : null;
  const votes = [label, fromCeremony, windowLabel].filter(Boolean);
  const winner = votes.find(v => votes.filter(x => x === v).length >= 2);
  if (!winner) return null;
  const wantCeremony = ceremony ? (seasonToCeremony(winner) || ceremony) : undefined;
  if (label === winner && (!ceremony || ceremony === wantCeremony)) return null;
  return { season: winner, ceremony: wantCeremony };
}

// Broadway-season award records that share the Tony season label. Off-Broadway
// awards (lortel, obie, oba) are left alone: a show id can carry them from an
// earlier Off-Broadway run that really was a different season. UK awards run
// on their own calendars.
const US_SEASON_KEYS = ['dramadesk', 'outerCriticsCircle', 'dramaLeague', 'nyDramaCritics', 'pulitzer', 'pulitzerFinalist'];

/**
 * Apply resolveTonySeason across awards.json shows. Sibling US records that
 * carried the same wrong label move with it.
 * @param {object} awardsShows awards.json `shows`
 * @param {(id:string)=>string|null} windowLabelFor Tony window of the show's opening date
 * @returns {Array<{id, from, to}>} changes (awardsShows is mutated)
 */
function repairSeasonLabels(awardsShows, windowLabelFor) {
  const changes = [];
  for (const [id, rec] of Object.entries(awardsShows)) {
    const t = rec?.tony;
    if (!t || !t.season) continue;
    const fix = resolveTonySeason({ label: t.season, ceremony: t.ceremony, windowLabel: windowLabelFor(id) });
    if (!fix) continue;
    const from = { season: t.season, ceremony: t.ceremony };
    if (fix.season !== t.season) {
      for (const key of US_SEASON_KEYS) {
        if (rec[key] && typeof rec[key] === 'object' && rec[key].season === t.season) rec[key].season = fix.season;
      }
      t.season = fix.season;
    }
    if (fix.ceremony) t.ceremony = fix.ceremony;
    changes.push({ id, from, to: { season: t.season, ceremony: t.ceremony } });
  }
  return changes;
}

module.exports = { ceremonyToSeason, seasonToCeremony, resolveTonySeason, repairSeasonLabels, US_SEASON_KEYS };
