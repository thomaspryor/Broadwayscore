// BRO-5874: raw-HTML URL of an EXISTING Wayback snapshot (the id_ flavor serves the stored
// bytes without the archive toolbar). Only an explicit 14-digit snapshot timestamp is accepted,
// so a caller can recover from a snapshot that exists but can never ask the archive to capture.
function archiveSnapshotFetchUrl(originalUrl, timestamp) {
  if (!/^\d{14}$/.test(String(timestamp || ''))) return null;
  let u;
  try { u = new URL(originalUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `https://web.archive.org/web/${timestamp}id_/${u.href}`;
}
// The original page url inside a pinned snapshot url; any other url comes back unchanged.
function unwrapArchiveSnapshotUrl(url) {
  const m = /^https:\/\/web\.archive\.org\/web\/\d{14}id_\/(https?:\/\/.+)$/.exec(String(url || ''));
  return m ? m[1] : url;
}
module.exports = { archiveSnapshotFetchUrl, unwrapArchiveSnapshotUrl };
