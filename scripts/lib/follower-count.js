// data/followers.json shape: { _meta, followers: { showId: [emails] } }.
// Object.values(data) sums the two top-level values (_meta, followers),
// neither an array, and always yields 0 — must reach into data.followers.
function countFollowers(data) {
  return Object.values((data && data.followers) || {})
    .reduce((sum, emails) => sum + (Array.isArray(emails) ? emails.length : 0), 0);
}

module.exports = { countFollowers };
