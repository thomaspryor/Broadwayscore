/** Read-only confirmation of auth-auto posts accepted by the subscriber form. */
async function getFormspreeAuthJoins({
  days = 7,
  nowMs = Date.now(),
  formId = process.env.FORMSPREE_SUBSCRIBER_FORM_ID,
  token = process.env.FORMSPREE_SUBSCRIBER_API_KEY || process.env.FORMSPREE_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!formId || !token) {
    return { formspreeAuthJoins: null, formspreeAuthJoinsStatus: 'unconfigured' };
  }

  const sinceMs = nowMs - days * 86400000;
  const limit = 100;
  let count = 0;
  try {
    // Same submissions endpoint, since filter and offset pagination as sync-followers.js.
    // Never use a partial fetch as confirmation that posts succeeded or stopped.
    for (let offset = 0; ; offset += limit) {
      const url = new URL(`https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions`);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('since', new Date(sinceMs).toISOString());
      const res = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error('Formspree API unavailable');
      const body = await res.json();
      const items = Array.isArray(body) ? body : body?.submissions;
      if (!Array.isArray(items)) throw new Error('Invalid Formspree response');
      for (const sub of items) {
        if (sub?.source !== 'auth-auto' || (sub.action && sub.action !== 'subscribe')) continue;
        const rawDate = sub._date || sub.date || sub.submitted_at || sub.created_at;
        const dateMs = rawDate ? Date.parse(rawDate) : NaN;
        if (!Number.isFinite(dateMs)) throw new Error('Missing submission date');
        // Check locally too, so an ignored server-side filter cannot count old posts.
        if (dateMs > sinceMs && dateMs <= nowMs) count++;
      }
      if (items.length < limit) break;
    }
    return { formspreeAuthJoins: count, formspreeAuthJoinsStatus: 'ok' };
  } catch {
    // API bodies/errors can contain private subscriber fields. Emit only status.
    return { formspreeAuthJoins: null, formspreeAuthJoinsStatus: 'unavailable' };
  }
}

module.exports = { getFormspreeAuthJoins };
