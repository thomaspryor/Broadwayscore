// Read-only Resend lookups for the subject writer (BRO-7168). GET only: never
// POST, PATCH or /send. Every function returns null / [] on any error so the
// newsletter build never depends on Resend being reachable.
const H = (key) => ({ Authorization: `Bearer ${key}` });
const getJson = async (url, key) => (await fetch(url, { headers: H(key), signal: AbortSignal.timeout(15000) })).json();

/** Subjects of the most recent weekly broadcasts (both editions), newest first, excluding names containing `skipWeek`. */
export async function recentWeeklySubjects(key, skipWeek, limit = 8) {
  if (!key) return [];
  try {
    const list = await getJson('https://api.resend.com/broadcasts?limit=40', key);
    const weekly = (list.data || []).filter(b => /Weekly/.test(b.name || '') && !(b.name || '').includes(skipWeek))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
    const out = [];
    for (const b of weekly) {
      const j = await getJson(`https://api.resend.com/broadcasts/${b.id}`, key);
      if (j && j.subject) out.push(j.subject);
    }
    return out;
  } catch { return []; }
}

/** The subject currently on the draft broadcast with this exact name, or null. */
export async function draftSubject(key, name) {
  if (!key) return null;
  try {
    const list = await getJson('https://api.resend.com/broadcasts?limit=40', key);
    const b = (list.data || []).find(x => x.name === name && x.status === 'draft');
    if (!b) return null;
    const j = await getJson(`https://api.resend.com/broadcasts/${b.id}`, key);
    return (j && j.subject) || null;
  } catch { return null; }
}
