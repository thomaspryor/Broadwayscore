/**
 * Money Scorecard email gate (BRO-6210).
 *
 * The /biz section and each show page's Money Scorecard section are their own
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

export const MONEY_UNLOCK_KEY = 'bsc_money_unlocked';
export const MONEY_UNLOCK_COOKIE = 'bsc_money';
export const MONEY_UNLOCKED_EVENT = 'bsc_money_unlocked';
export const MONEY_UNLOCK_ATTR = 'data-money-unlocked';

/** What the gate tells readers their email is used for. Owner-editable. */
export const MONEY_EMAIL_USE =
  'Occasional Money Scorecard emails: new recoupments, closings and big estimate changes. Unsubscribe anytime. Separate from our newsletter.';

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

/** True when this browser already belongs to a subscriber or account holder. */
export function hasExistingAccess(getItem: (key: string) => string | null): boolean {
  try {
    if (getItem(EXISTING_SESSION_KEY) !== null) return true;
    return EXISTING_SUBSCRIBER_KEYS.some((k) => getItem(k) === 'true');
  } catch {
    return false;
  }
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

export function isValidMoneyEmail(email: string): boolean {
  const e = email.trim();
  return e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
}

export function isMoneyUnlocked(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (localStorage.getItem(MONEY_UNLOCK_KEY) === '1') return true;
    if (hasExistingAccess((k) => localStorage.getItem(k))) return true;
  } catch { /* storage blocked: fall through to the cookie */ }
  try {
    return new RegExp(`(?:^|;\\s*)${MONEY_UNLOCK_COOKIE}=1(?:;|$)`).test(document.cookie);
  } catch {
    return false;
  }
}

/**
 * Unlocks the gates on the current page only, for an existing reader
 * (sign-in or subscription mid-visit). Persists nothing: the next load
 * re-derives it from the same flags.
 */
export function unlockForExistingReader(): void {
  if (typeof window === 'undefined') return;
  if (document.documentElement.hasAttribute(MONEY_UNLOCK_ATTR)) return;
  document.documentElement.setAttribute(MONEY_UNLOCK_ATTR, '');
  window.dispatchEvent(new Event(MONEY_UNLOCKED_EVENT));
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
 * never stack a second, unrelated ask over the Money Scorecard sign-up.
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

export type MoneySignupResult = 'stored' | 'store_unavailable' | 'invalid';

/**
 * Stores the sign-up. Anything but a bad address resolves (the reader is
 * unlocked either way: a store outage must never lock out someone who gave
 * their email); the caller reports 'store_unavailable' to analytics.
 */
export async function submitMoneySignup(email: string, role: MoneyRole | '', page: string): Promise<MoneySignupResult> {
  if (!isValidMoneyEmail(email)) return 'invalid';
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
