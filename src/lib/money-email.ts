/**
 * Email quality rules for the Money Scorecard gate (BRO-6339). No confirm-by-
 * click step, so the gate refuses what it can prove is fake: a malformed
 * address, a disposable-mail domain, a throwaway local part, or a domain with
 * no mail server (DNS-over-HTTPS, fails open). The format, disposable and junk
 * rules are mirrored in the money_scorecard_signup() function
 * (supabase/migrations/20261026b_money_signup_reject_fake_emails.sql); keep the
 * two in step (tests/unit/money-gate.test.mjs compares them).
 */

export type MoneyEmailProblem = 'format' | 'disposable' | 'junk';

/** Disposable / throwaway-inbox domains. Small and maintained by hand. */
export const DISPOSABLE_DOMAINS: readonly string[] = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz',
  'guerrillamail.de', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'spam4.me', 'pokemail.net',
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'tempmail.com', 'temp-mail.org',
  'temp-mail.io', 'tempmail.net', 'tempail.com', 'tempr.email', 'throwawaymail.com', 'trashmail.com',
  'trashmail.net', 'trashmail.me', 'yopmail.com', 'yopmail.net', 'yopmail.fr', 'getnada.com', 'nada.email',
  'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mailcatch.com', 'mintemail.com', 'mohmal.com',
  'fakeinbox.com', 'fakemail.net', 'emailondeck.com', 'moakt.com', 'burnermail.io', 'mytemp.email',
  'inboxkitten.com', 'mail.tm', 'mailsac.com', 'spamgourmet.com', 'discard.email', 'discardmail.com',
  'harakirimail.com', 'jetable.org', 'getairmail.com', 'anonbox.net', 'mailforspam.com', 'tmail.ws',
  'tmpmail.org', 'tmpmail.net', 'emailfake.com', 'fakemailgenerator.com', 'mailtemp.info', 'luxusmail.org',
  'byom.de', 'owlymail.com', 'mvrht.net', 'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu',
  'gustr.com', 'jourrapide.com', 'rhyta.com', 'superrito.com', 'teleworm.us', 'armyspy.com',
];

/** Local parts nobody real uses. Exact match after lowercasing. */
const JUNK_LOCALS: readonly string[] = [
  'test', 'tester', 'testing', 'test1', 'test123', 'asdf', 'asdfg', 'asdfgh', 'asdfghjkl', 'qwerty',
  'qwe', 'abc', 'abcd', 'abc123', 'xxx', 'xyz', 'none', 'noemail', 'no', 'nobody', 'fake', 'fakeemail',
  'email', 'user', 'name', 'me', 'foo', 'bar', 'foobar', 'sample', 'spam', 'junk', 'temp', 'null',
];

const FORMAT_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function parts(email: string): { local: string; domain: string } | null {
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !FORMAT_RE.test(e)) return null;
  const at = e.lastIndexOf('@');
  return { local: e.slice(0, at), domain: e.slice(at + 1) };
}

export function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return DISPOSABLE_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`));
}

/** A one-character name, a repeated single character (aaaa), or a known throwaway word. */
export function isJunkLocal(local: string): boolean {
  const l = local.toLowerCase();
  return l.length < 2 || /^(.)\1+$/.test(l) || JUNK_LOCALS.includes(l);
}

/** Why an address is refused without any network lookup, or null when it passes. */
export function moneyEmailProblem(email: string): MoneyEmailProblem | null {
  const p = parts(email);
  if (!p) return 'format';
  if (isDisposableDomain(p.domain)) return 'disposable';
  if (isJunkLocal(p.local)) return 'junk';
  return null;
}

export const MONEY_EMAIL_MESSAGES: Record<MoneyEmailProblem | 'no_mail_server', string> = {
  format: 'Please enter a valid email address.',
  disposable: 'Disposable email addresses cannot be used here. Please use your regular email.',
  junk: 'That address looks like a placeholder. Please enter your real email.',
  no_mail_server: "That email's domain does not appear to receive mail. Please check the spelling.",
};

const TYPO_DOMAINS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gnail.com': 'gmail.com',
  'gmail.om': 'gmail.com', 'gmal.com': 'gmail.com', 'gimail.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'yhoo.com': 'yahoo.com', 'yahou.com': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
  'hotmail.con': 'hotmail.com', 'hotnail.com': 'hotmail.com', 'hormail.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com',
  'iclould.com': 'icloud.com', 'icloud.co': 'icloud.com', 'icloud.con': 'icloud.com', 'icoud.com': 'icloud.com',
  'aol.co': 'aol.com', 'comcast.nte': 'comcast.net', 'verizon.nte': 'verizon.net',
};

/** A corrected full address for a common domain typo, or null. */
export function suggestMoneyEmail(email: string): string | null {
  const p = parts(email);
  if (!p) return null;
  const fixed = TYPO_DOMAINS[p.domain];
  return fixed ? `${p.local}@${fixed}` : null;
}

const MX_TIMEOUT_MS = 3000;

async function dohHasRecord(domain: string, type: 'MX' | 'A', signal: AbortSignal): Promise<boolean> {
  const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`, {
    signal,
    headers: { accept: 'application/dns-json' },
  });
  if (!res.ok) throw new Error(`doh ${res.status}`);
  const json = (await res.json()) as { Status?: number; Answer?: { type: number; data?: string }[] };
  if (json.Status === 3) return false; // NXDOMAIN: the domain does not exist
  if (json.Status !== 0) throw new Error(`doh status ${json.Status}`);
  const want = type === 'MX' ? 15 : 1;
  const answers = (json.Answer ?? []).filter((a) => a.type === want);
  // A null MX ("0 .", RFC 7505) says the domain accepts no mail.
  if (type === 'MX') return answers.some((a) => !/^\d+\s+\.?$/.test((a.data ?? '').trim()));
  return answers.length > 0;
}

/**
 * Whether the address's domain can receive mail: true when it has an MX
 * record (or, with none, an A record, the RFC 5321 fallback). Any lookup
 * error or timeout resolves true so a DNS hiccup never locks a real reader out.
 */
export async function domainAcceptsMail(email: string, timeoutMs = MX_TIMEOUT_MS): Promise<boolean> {
  const p = parts(email);
  if (!p) return true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    if (await dohHasRecord(p.domain, 'MX', ctl.signal)) return true;
    return await dohHasRecord(p.domain, 'A', ctl.signal);
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}
