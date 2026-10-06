'use client';

/**
 * Opens the one-time welcome sheet (BRO-4619) for a brand-new account, once.
 * Mounted for every page by UserProviders; renders nothing for everyone else.
 *
 * Order of checks: shouldOfferWelcome() on the loaded profile (no network),
 * then wait until nothing else is on screen (a pending rating from before
 * sign-in, the rating editor, any modal), then claim_onboarding() on the
 * server, which returns true for exactly one caller per account. Only then
 * does the sheet open.
 *
 * Where: straight away on hub pages (home, My Shows, market homes). On any
 * other page it waits until they move on from the page they landed on, so it
 * never covers the review they came to read (welcomeCanOpenOn).
 *
 * Dev preview: ?welcome=preview on localhost opens it without an account
 * (nothing is written or tracked), for visual QA.
 */

import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { getPendingAction } from '@/lib/deferred-auth';
import { supabaseRestRpc } from '@/lib/supabase-rest';
import { shouldOfferWelcome, welcomeCanOpenOn, welcomeSeenKey } from '@/lib/welcome-onboarding';

const WelcomeSheet = dynamic(() => import('./WelcomeSheet'), { ssr: false });
/** Same chunk as above; fetched before the claim so a failed download costs nothing. */
const loadSheet = () => import('./WelcomeSheet');

/** The gate wraps every page: a render error in the sheet must not take the page down. */
class SheetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('[welcome] sheet failed to render', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

const FIRST_CHECK_MS = 1200;
const BUSY_RETRY_MS = 1500;
/**
 * How long a pending sign-in action holds the welcome back: about 30 s on each
 * page (the count restarts when they move to another page). It is
 * replayed only on its show page and lives up to an hour, so one that is never
 * replayed (they signed in and went elsewhere) must not cost a new account its
 * welcome; after that the sheet opens anyway.
 */
const MAX_PENDING_RETRIES = 20;

/** 'modal': something is open on screen, wait however long it takes. */
function pageBusyReason(): 'modal' | 'pending' | null {
  if (document.querySelector('[role="dialog"][aria-modal="true"], [data-testid="rating-editor"]')) return 'modal';
  return getPendingAction() ? 'pending' : null;
}

export default function WelcomeGate() {
  const { user, profile } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState<'account' | 'preview' | null>(null);
  const userId = user?.id ?? null;
  const seenAt = profile?.onboarding_seen_at;
  const createdAt = profile?.created_at ?? null;
  const profileLoaded = !!profile;
  const onAuthPage = !!pathname?.startsWith('/auth');
  const mounted = useRef(true);
  // The page they were on when signed in (outside the sign-in screens).
  // Keyed to the account: Apple's popup signs in without a page load, so a
  // path remembered while signed out would be the wrong page.
  const landingPath = useRef<string | null>(null);
  const landingFor = useRef<string | null>(null);
  if (userId && pathname && !onAuthPage && landingFor.current !== userId) {
    landingFor.current = userId;
    landingPath.current = pathname;
  }
  const canOpenHere = !!pathname && welcomeCanOpenOn({ pathname, landingPath: landingPath.current });
  // Set on every mount: React's dev double-mount runs the cleanup once first.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Signed out (e.g. in another tab) while it is open: close it rather than
  // let it fall back to preview mode, which writes nothing.
  useEffect(() => {
    if (open === 'account' && !userId) setOpen(null);
  }, [open, userId]);

  useEffect(() => {
    if (window.location.hostname === 'localhost' && new URLSearchParams(window.location.search).get('welcome') === 'preview') {
      setOpen('preview');
    }
  }, []);

  useEffect(() => {
    if (!userId || !profileLoaded || onAuthPage || !canOpenHere || open) return;
    const key = welcomeSeenKey(userId);
    let locallySeen = false;
    try { locallySeen = localStorage.getItem(key) === '1'; } catch { /* private mode */ }
    if (!shouldOfferWelcome({ profile: { onboarding_seen_at: seenAt, created_at: createdAt }, now: Date.now(), locallySeen })) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let pendingTries = 0;
    const attempt = async () => {
      if (cancelled) return;
      const busy = pageBusyReason();
      if (busy === 'modal' || (busy === 'pending' && ++pendingTries <= MAX_PENDING_RETRIES)) {
        timer = setTimeout(attempt, BUSY_RETRY_MS);
        return;
      }
      // Load the sheet before claiming, so a failed download (e.g. a deploy
      // replaced the chunk) leaves the welcome unclaimed for the next page.
      try { await loadSheet(); } catch { return; }
      if (cancelled) return;
      const { data, error } = await supabaseRestRpc<boolean>('claim_onboarding');
      if (error) return; // e.g. the migration is not applied yet: show nothing
      try { localStorage.setItem(key, '1'); } catch { /* private mode */ }
      if (data !== true) return;
      // Once claimed it is spent, so open even if this effect re-ran meanwhile,
      // but never on top of a modal that opened while the claim was in flight.
      const openWhenFree = () => {
        if (!mounted.current) return;
        if (pageBusyReason() === 'modal') { setTimeout(openWhenFree, BUSY_RETRY_MS); return; }
        setOpen('account');
      };
      openWhenFree();
    };
    timer = setTimeout(attempt, FIRST_CHECK_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userId, profileLoaded, seenAt, createdAt, onAuthPage, canOpenHere, open, pathname]);

  if (!open) return null;
  if (open === 'account' && !userId) return null;
  return (
    <SheetBoundary>
      <WelcomeSheet userId={open === 'account' ? userId : null} onClose={() => setOpen(null)} />
    </SheetBoundary>
  );
}
