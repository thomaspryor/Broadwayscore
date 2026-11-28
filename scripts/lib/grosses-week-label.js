/**
 * "M/D/YYYY" label for a Broadway grosses week, shown as the Sunday the week
 * ends (how BWW/Playbill label it). grosses-history.json keys weeks by that
 * Sunday (BRO-4988); older data keyed the following Monday. The newsletter
 * always subtracted a day, so once keys became Sundays it printed the
 * Saturday ("Week of 10/17/2026" for the week ending 10/18).
 *
 * @param {string|null} key  YYYY-MM-DD history key (Sunday, or legacy Monday)
 * @param {string} [fallback]  label to use when there is no key
 * @returns {string}
 */
function grossesWeekLabel(key, fallback) {
  if (!key) return fallback;
  const t = Date.parse(key + 'T00:00:00Z');
  if (Number.isNaN(t)) return fallback;
  const back = new Date(t).getUTCDay(); // days since the Sunday on or before the key
  const d = new Date(t - back * 864e5);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

module.exports = { grossesWeekLabel };
