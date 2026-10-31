/**
 * Profitability Scorecard email gate (BRO-6210).
 *
 * The /biz section and each show page's Profitability Scorecard section are their own
 * sub-site: show-level detail unlocks with a one-step email sign-up, stored on
 * a list separate from every other capture on the site (owner, 2026-10-25).
 * Sign-ups go to Supabase's money_scorecard_signups table through the
 * money_scorecard_signup() function (supabase/migrations/20261025_money_scorecard_signups.sql),
 * never to Formspree, Resend or the account system.
 *
 * Unlock state lives in the browser: localStorage with a cookie fallback, and
 * a `data-money-unlocked` attribute on <html> that CSS reads (globals.css
 * `.money-gate`). The attribute is set by MONEY_GATE_BOOT_SCRIPT before the
 * gated markup paints, so a returning reader never sees the lock flash.
 *
 * Existing readers skip the gate (BRO-6248): a browser holding a signed-in
 * session, or one already on the newsletter / opening-night list, is unlocked
 * on sight. That unlock is derived on every load and never written to the
 * money list or the unlock key: they did not sign up for Money emails.
 */

import { SUBSCRIBED_KEY, SUBSCRIBED_KEY_PREFIX } from '../hooks/useFormspreeSubscribed';
import { SUPABASE_STORAGE_KEY } from './supabase';
import { checkMailServer, moneyEmailProblem } from './money-email';

export const MONEY_UNLOCK_KEY = 'bsc_money_unlocked';
export const MONEY_UNLOCK_COOKIE = 'bsc_money';
export const MONEY_UNLOCKED_EVENT = 'bsc_money_unlocked';
export const MONEY_UNLOCK_ATTR = 'data-money-unlocked';

/** What the gate tells readers their email is used for. Owner-editable. */
export const MONEY_EMAIL_USE =
  'Occasional Profitability Scorecard emails: new recoupments, closings and big estimate changes. Unsubscribe anytime. Separate from our newsletter.';

/**
 * localStorage keys that mark an existing reader: the main list's subscribed
 * flags (useFormspreeSubscribed.ts) and the stored Supabase session.
 * Subscribed flags count only as 'true'; the session counts when present.
 */
export const EXISTING_SUBSCRIBER_KEYS = [
  SUBSCRIBED_KEY,
  `${SUBSCRIBED_KEY_PREFIX}broadway`,
  `${SUBSCRIBED_KEY_PREFIX}west-end`,
] as const;
export const EXISTING_SESSION_KEY = SUPABASE_STORAGE_KEY;

/** Why a reader sees the money data without the gate (money_gate_bypassed). */
export type MoneyBypassReason = 'account' | 'subscriber' | 'unlocked';

/** 'account' or 'subscriber' when this browser belongs to an existing reader. */
export function existingAccessReason(getItem: (key: string) => string | null): MoneyBypassReason | null {
  try {
    if (getItem(EXISTING_SESSION_KEY) !== null) return 'account';
    return EXISTING_SUBSCRIBER_KEYS.some((k) => getItem(k) === 'true') ? 'subscriber' : null;
  } catch {
    return null;
  }
}

/** True when this browser already belongs to a subscriber or account holder. */
export function hasExistingAccess(getItem: (key: string) => string | null): boolean {
  return existingAccessReason(getItem) !== null;
}

export const MONEY_ROLES = [
  { value: 'producer', label: 'Producer' },
  { value: 'investor', label: 'Investor' },
  { value: 'industry', label: 'Industry' },
  { value: 'press', label: 'Press' },
  { value: 'fan', label: 'Fan' },
] as const;

export type MoneyRole = (typeof MONEY_ROLES)[number]['value'];

/** Inline, runs during HTML parse. Must stay dependency-free and never throw. */
export const MONEY_GATE_BOOT_SCRIPT =
  `try{var d=document.documentElement;if(!d.hasAttribute('${MONEY_UNLOCK_ATTR}')){var u=false;` +
  `try{var g=function(k){return localStorage.getItem(k)};u=g('${MONEY_UNLOCK_KEY}')==='1'||g('${SUPABASE_STORAGE_KEY}')!==null` +
  EXISTING_SUBSCRIBER_KEYS.map((k) => `||g('${k}')==='true'`).join('') +
  `}catch(e){}` +
  `if(!u){u=/(?:^|;\\s*)${MONEY_UNLOCK_COOKIE}=1(?:;|$)/.test(document.cookie)}` +
  `if(u)d.setAttribute('${MONEY_UNLOCK_ATTR}','')}}catch(e){}`;

/** Sync rules: format, disposable domain, junk local part (BRO-6339). The mail-server check is async, in submitMoneySignup. */
export function isValidMoneyEmail(email: string): boolean {
  return moneyEmailProblem(email) === null;
}

/**
 * Why this browser is unlocked, or null when it is not. A money-list sign-up
 * ('unlocked') wins over an account or subscription so reach by source adds up.
 */
export function moneyUnlockReason(): MoneyBypassReason | null {
  if (typeof window === 'undefined') return null;
  let existing: MoneyBypassReason | null = null;
  try {
    if (localStorage.getItem(MONEY_UNLOCK_KEY) === '1') return 'unlocked';
    existing = existingAccessReason((k) => localStorage.getItem(k));
  } catch { /* storage blocked: fall through to the cookie */ }
  try {
    if (new RegExp(`(?:^|;\\s*)${MONEY_UNLOCK_COOKIE}=1(?:;|$)`).test(document.cookie)) return 'unlocked';
  } catch { /* noop */ }
  return existing;
}

export function isMoneyUnlocked(): boolean {
  return moneyUnlockReason() !== null;
}

/**
 * Unlocks the gates on the current page only, for an existing reader
 * (sign-in or subscription mid-visit). Persists nothing: the next load
 * re-derives it from the same flags. Returns true when it unlocked the page.
 */
export function unlockForExistingReader(): boolean {
  if (typeof window === 'undefined') return false;
  if (document.documentElement.hasAttribute(MONEY_UNLOCK_ATTR)) return false;
  document.documentElement.setAttribute(MONEY_UNLOCK_ATTR, '');
  window.dispatchEvent(new Event(MONEY_UNLOCKED_EVENT));
  return true;
}

/** Unlocks every money gate in this browser and on the current page. */
export function markMoneyUnlocked(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(MONEY_UNLOCK_KEY, '1'); } catch { /* cookie below still persists it */ }
  try {
    document.cookie = `${MONEY_UNLOCK_COOKIE}=1; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`;
  } catch { /* noop */ }
  document.documentElement.setAttribute(MONEY_UNLOCK_ATTR, '');
  window.dispatchEvent(new Event(MONEY_UNLOCKED_EVENT));
}

/**
 * True while a locked money gate is on screen. The site's generic email
 * popups (exit intent, scroll depth, show follow banner) check this so they
 * never stack a second, unrelated ask over the Profitability Scorecard sign-up.
 */
export function isMoneyGateInView(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.hasAttribute(MONEY_UNLOCK_ATTR)) return false;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return Array.from(document.querySelectorAll('[data-money-gate]')).some((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < vh;
  });
}

export type MoneySignupResult = 'stored' | 'store_unavailable' | 'invalid' | 'no_mail_server';

/**
 * Sign-ups whose save failed, kept in this browser and retried on later page
 * views until stored (BRO-6289). The reader is unlocked either way, so
 * without this a store outage lost the address silently.
 */
export const MONEY_PENDING_KEY = 'bsc_money_pending';
const MAX_PENDING = 5;

interface PendingSignup {
  email: string;
  role: MoneyRole | '';
  page: string;
}

function readPending(): PendingSignup[] {
  try {
    const v = JSON.parse(localStorage.getItem(MONEY_PENDING_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.email === 'string') : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingSignup[]): void {
  try {
    if (list.length) localStorage.setItem(MONEY_PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
    else localStorage.removeItem(MONEY_PENDING_KEY);
  } catch { /* storage blocked: nothing to keep it in */ }
}

/** One save attempt against the sign-up function. */
async function storeMoneySignup(email: string, role: MoneyRole | '', page: string): Promise<MoneySignupResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return 'store_unavailable';
  try {
    const res = await fetch(`${url}/rest/v1/rpc/money_scorecard_signup`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_email: email.trim().toLowerCase(), p_role: role || null, p_page: page }),
    });
    if (res.ok) return 'stored';
    // The function refuses a malformed address with 22023 (HTTP 400).
    if (res.status === 400) {
      const body = await res.text().catch(() => '');
      if (body.includes('invalid email')) return 'invalid';
    }
    return 'store_unavailable';
  } catch {
    return 'store_unavailable';
  }
}

/**
 * Stores the sign-up. Anything but a bad address resolves (the reader is
 * unlocked either way: a store outage must never lock out someone who gave
 * their email); the caller reports 'store_unavailable' to analytics, and the
 * address waits in the outbox for retryPendingMoneySignups.
 */
export async function submitMoneySignup(email: string, role: MoneyRole | '', page: string): Promise<MoneySignupResult> {
  if (!isValidMoneyEmail(email)) return 'invalid';
  if ((await checkMailServer(email)) === 'no_mail_server') return 'no_mail_server';
  const result = await storeMoneySignup(email, role, page);
  if (result === 'store_unavailable') {
    const normalized = email.trim().toLowerCase();
    writePending([...readPending().filter((p) => p.email !== normalized), { email: normalized, role, page }]);
  }
  return result;
}

let retryStarted = false;

/**
 * Retries the outbox once per page load (every gated page calls it). An
 * address leaves the outbox when stored or refused as invalid; one that still
 * fails stays for the next page view.
 */
export async function retryPendingMoneySignups(): Promise<{ stored: number; remaining: number }> {
  if (retryStarted || typeof window === 'undefined') return { stored: 0, remaining: 0 };
  retryStarted = true;
  const pending = readPending();
  if (!pending.length) return { stored: 0, remaining: 0 };
  const left: PendingSignup[] = [];
  let stored = 0;
  for (const p of pending) {
    const r = await storeMoneySignup(p.email, p.role, p.page);
    if (r === 'stored') stored += 1;
    else if (r === 'store_unavailable') left.push(p);
  }
  writePending(left);
  return { stored, remaining: left.length };
}

/** Test hook: lets a test run the once-per-page retry again. */
export function resetMoneyRetryForTests(): void {
  retryStarted = false;
}

/** schema.org paywall markup: gated content stays in the HTML (not cloaking). */
export const MONEY_GATE_SELECTOR = '.money-gated';
export function moneyGatePaywallSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    isAccessibleForFree: false,
    hasPart: {
      '@type': 'WebPageElement',
      isAccessibleForFree: false,
      cssSelector: MONEY_GATE_SELECTOR,
    },
  };
}
