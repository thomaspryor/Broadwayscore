/**
 * Profitability Scorecard sign-up round-trip (BRO-6289), run daily by
 * test-ugc-roundtrip.mjs. The money gate unlocks a reader whether or not the
 * save worked, so a broken money_scorecard_signup() would lose every address
 * without anyone seeing an error. This calls the function exactly as the
 * browser does (anon key), reads the row back with the service key, checks
 * the anon role cannot read the list, then deletes the probe row.
 *
 * A failed save is urgent: real readers' emails are being dropped.
 */

export async function runMoneySignupChecks({ rest, check, anonKey, serviceKey }) {
  const email = `money-roundtrip-${Date.now()}@example.com`;
  try {
    const save = await rest('POST', 'rpc/money_scorecard_signup', anonKey,
      { p_email: email, p_role: 'investor', p_page: 'roundtrip:/biz' }, null);
    check('money gate: sign-up saves through the browser path (anon)', save.ok, `HTTP ${save.status}`);

    const row = await rest('GET', `money_scorecard_signups?email=eq.${encodeURIComponent(email)}&select=email,role,first_page`, serviceKey);
    const found = save.ok && Array.isArray(row.json) && row.json.length === 1
      && row.json[0].role === 'investor' && row.json[0].first_page === 'roundtrip:/biz';
    check('money gate: saved sign-up is in the list with its role and page', found, row.ok ? '' : `HTTP ${row.status}`);

    // RLS with no policies: the browser key must never read the list.
    const leak = await rest('GET', 'money_scorecard_signups?select=email&limit=1', anonKey);
    check('money gate: the list is not readable with the public key',
      !leak.ok || (Array.isArray(leak.json) && leak.json.length === 0), `HTTP ${leak.status}`);

    const bad = await rest('POST', 'rpc/money_scorecard_signup', anonKey,
      { p_email: 'not-an-email', p_role: null, p_page: 'roundtrip:/biz' }, null);
    check('money gate: a malformed address is refused (the browser shows an error)', bad.status === 400 && bad.text.includes('invalid email'),
      `HTTP ${bad.status}`, { urgent: false });

    // BRO-6339: the function itself refuses disposable domains and placeholder
    // local parts, so a direct API call cannot store them.
    for (const junk of ['roundtrip@mailinator.com', 'a@example.com', 'test@example.com']) {
      const r = await rest('POST', 'rpc/money_scorecard_signup', anonKey,
        { p_email: junk, p_role: null, p_page: 'roundtrip:/biz' }, null);
      check(`money gate: ${junk} is refused by the function (BRO-6339)`, r.status === 400 && r.text.includes('invalid email'),
        `HTTP ${r.status}`, { urgent: false });
    }
  } finally {
    await rest('DELETE', `money_scorecard_signups?email=eq.${encodeURIComponent(email)}`, serviceKey, null, 'return=minimal').catch(() => {});
  }
}
