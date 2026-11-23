// British Theatre's translated post URLs can return the wrong page to collectors.
function canonicalBritishTheatreUrl(url) {
  if (typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    if (!/^(?:www\.)?britishtheatre\.com$/i.test(parsed.hostname) || !/^https?:$/.test(parsed.protocol)) return url;
    return url.replace(/^(https?:\/\/(?:www\.)?britishtheatre\.com)\/(?:ar|ko|fr|es|de|ja|zh|pt|it)(?=\/posts\/)/i, '$1');
  } catch {
    return url;
  }
}

module.exports = { canonicalBritishTheatreUrl };
