'use strict';

// Limits apply per account and New York calendar day, including other post types.
const day = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));

function limitDailyNetworks(channels, ledger, dueAt, limits, retryEntry = null) {
  const wantedDay = day(dueAt);
  const posts = ledger.posts || [];
  const retryIndex = posts.indexOf(retryEntry);
  return channels.filter(ch => {
    const max = limits[ch.service];
    if (max == null) return true;
    const count = posts.filter((p, index) => {
      if (p === retryEntry || p.skipped) return false;
      const sent = p.channels && p.channels[ch.key];
      const scheduled = sent && sent.postId && !['error', 'missing', 'cancelled'].includes(sent.result);
      // An earlier reservation wins when two old retries compete for the same day.
      const pending = p.pending && p.pending[ch.key] && (retryIndex < 0 || index < retryIndex);
      const at = scheduled ? (sent.dueAt || p.dueAt) : pending ? p.dueAt : null;
      return at && Number.isFinite(Date.parse(at)) && day(at) === wantedDay;
    }).length;
    return count < max;
  });
}
module.exports = { limitDailyNetworks };
