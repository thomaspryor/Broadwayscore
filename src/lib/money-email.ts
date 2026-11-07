/**
 * Profitability Scorecard email quality rules (BRO-6339). Dependency-free so the unit
 * test can require() it. The gate has no confirm-by-click step, so the first
 * sign-up was a@a1a.com: these rules keep fakes out without one.
 *
 * Three layers: sync rules (format, disposable domain, junk local part),
 * typo suggestions (offered, never forced), and a mail-server lookup over
 * DNS-over-HTTPS that fails OPEN. The sync rules are mirrored in the
 * money_scorecard_signup() function (supabase/migrations/20261026b_money_signup_reject_junk.sql);
 * tests/unit/money-gate.test.mjs asserts the two lists match.
 */

export const MONEY_EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Throwaway-inbox domains. A domain also matches as a parent of a subdomain. Keep sorted. */
export const DISPOSABLE_DOMAINS = [
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'discard.email',
  'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'getairmail.com',
  'getnada.com', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de',
  'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'grr.la',
  'harakirimail.com', 'inboxbear.com', 'mail.tm', 'maildrop.cc',
  'mailinator.com', 'mailinator.net', 'mailnesia.com', 'mailnull.com',
  'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email',
  'sharklasers.com', 'spam4.me', 'spamgourmet.com', 'temp-mail.io',
  'temp-mail.org', 'tempail.com', 'tempinbox.com', 'tempmail.com',
  'tempmail.net', 'tempmailo.com', 'throwawaymail.com', 'trashmail.com',
  'trashmail.de', 'trashmail.net', 'yopmail.com', 'yopmail.fr',
  'yopmail.net', 'zetmail.com',
] as const;

/** Local parts (before any +tag) that are placeholders, not people. */
export const JUNK_LOCAL_PARTS = [
  'abc', 'abc123', 'abcd', 'asd', 'asdf', 'asdfg', 'asdfgh', 'asdfghjkl',
  'email', 'example', 'fake', 'foo', 'foobar', 'noemail', 'none', 'noone',
  'nobody', 'qwe', 'qwer', 'qwerty', 'qwertyuiop', 'sample', 'test', 'test1',
  'test123', 'tester', 'testing', 'testtest', 'xxx', 'xyz', 'zzz',
  '123', '1234', '12345', '123456',
] as const;

/** One character, or one character repeated 3+ times (a@, aaa@; not aa@): mirrored in SQL as '^(.)(\1\1+)?$'. */
const REPEATED_CHAR = /^(.)(\1\1+)?$/;

export type MoneyEmailProblem = 'format' | 'disposable' | 'junk';

function splitEmail(email: string): { local: string; domain: string } {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  // One trailing dot is the same domain (mailinator.com.).
  return { local: e.slice(0, at), domain: e.slice(at + 1).replace(/\.$/, '') };
}

export function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return (DISPOSABLE_DOMAINS as readonly string[]).some((x) => d === x || d.endsWith(`.${x}`));
}

export function isJunkLocalPart(local: string): boolean {
  const base = local.toLowerCase().split('+')[0];
  return REPEATED_CHAR.test(base) || (JUNK_LOCAL_PARTS as readonly string[]).includes(base);
}

/** The first rule this address breaks, or null. */
export function moneyEmailProblem(email: string): MoneyEmailProblem | null {
  const e = email.trim();
  if (e.length > 254 || !MONEY_EMAIL_FORMAT.test(e)) return 'format';
  const { local, domain } = splitEmail(e);
  if (isDisposableDomain(domain)) return 'disposable';
  if (isJunkLocalPart(local)) return 'junk';
  return null;
}

export const MONEY_EMAIL_PROBLEM_MESSAGES: Record<MoneyEmailProblem | 'no_mail_server', string> = {
  format: 'Please enter a valid email address.',
  disposable: 'Please use a permanent email address, not a disposable inbox.',
  junk: 'That address looks like a placeholder. Please enter your real email.',
  no_mail_server: "That domain can't receive email. Please check the spelling or use another address.",
};

/** Common mistyped domains and what they were meant to be. */
export const DOMAIN_TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com',
  'gmil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmaill.com': 'gmail.com',
  'gamil.com': 'gmail.com', 'gmail.om': 'gmail.com', 'gmail.comm': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com',
  'yahoo.con': 'yahoo.com', 'yhoo.com': 'yahoo.com', 'yahoo.cm': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
  'hotmail.con': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'homail.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com',
  'iclould.com': 'icloud.com', 'icloud.co': 'icloud.com', 'icloud.con': 'icloud.com',
  'aol.co': 'aol.com', 'aol.con': 'aol.com', 'comcast.nt': 'comcast.net',
  'comcast.con': 'comcast.net', 'verizon.nt': 'verizon.net', 'att.nt': 'att.net',
};

/** A corrected address when the domain is a known typo, else null. */
export function suggestMoneyEmail(email: string): string | null {
  const e = email.trim();
  if (!MONEY_EMAIL_FORMAT.test(e)) return null;
  const at = e.lastIndexOf('@');
  const fixed = DOMAIN_TYPOS[e.slice(at + 1).toLowerCase()];
  return fixed ? `${e.slice(0, at)}@${fixed}` : null;
}

export const DOH_URL = 'https://dns.google/resolve';
export const DOH_TIMEOUT_MS = 3000;
const DNS_NOERROR = 0;
const DNS_NXDOMAIN = 3;
const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_MX = 15;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface DohAnswer { Status?: number; Answer?: Array<{ type: number; data?: string }> }

async function doh(fetchImpl: FetchLike, domain: string, type: 'MX' | 'A' | 'AAAA', timeoutMs: number): Promise<DohAnswer | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Raced as well as aborted: a fetch that ignores the signal still times out.
    const timeout = new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new Error('timeout'))));
    const lookup = (async () => {
      const res = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=${type}`, { signal: ctl.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as DohAnswer;
      return body && typeof body === 'object' ? body : null;
    })();
    lookup.catch(() => {});
    return await Promise.race([lookup, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 'no_mail_server' only when DNS positively says the domain cannot take mail:
 * NXDOMAIN, or no MX (and no A fallback), or a null MX ("0 ."). A timeout,
 * network error, blocked request or any other DNS status is 'ok' (fail open:
 * a real reader is never locked out by our lookup).
 */
export async function checkMailServer(
  email: string,
  fetchImpl: FetchLike | undefined = typeof fetch === 'function' ? (fetch as unknown as FetchLike) : undefined,
  timeoutMs = DOH_TIMEOUT_MS,
): Promise<'ok' | 'no_mail_server'> {
  if (!fetchImpl) return 'ok';
  const { domain } = splitEmail(email);
  const mx = await doh(fetchImpl, domain, 'MX', timeoutMs);
  if (!mx) return 'ok';
  if (mx.Status === DNS_NXDOMAIN) return 'no_mail_server';
  if (mx.Status !== DNS_NOERROR) return 'ok';
  const records = (mx.Answer ?? []).filter((a) => a.type === TYPE_MX);
  if (records.length) {
    const allNull = records.every((a) => /^\s*0\s+\.?\s*$/.test(a.data ?? ''));
    return allNull ? 'no_mail_server' : 'ok';
  }
  const a = await doh(fetchImpl, domain, 'A', timeoutMs);
  if (!a) return 'ok';
  if (a.Status === DNS_NXDOMAIN) return 'no_mail_server';
  if (a.Status !== DNS_NOERROR) return 'ok';
  if ((a.Answer ?? []).some((r) => r.type === TYPE_A)) return 'ok';
  // IPv6-only hosts are still hosts: refuse only when AAAA is empty too.
  const v6 = await doh(fetchImpl, domain, 'AAAA', timeoutMs);
  if (!v6 || v6.Status !== DNS_NOERROR) return v6 && v6.Status === DNS_NXDOMAIN ? 'no_mail_server' : 'ok';
  return (v6.Answer ?? []).some((r) => r.type === TYPE_AAAA) ? 'ok' : 'no_mail_server';
}
