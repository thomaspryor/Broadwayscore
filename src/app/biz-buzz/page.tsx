'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /biz-buzz - Redirect to /biz
 *
 * This page serves as a client-side fallback redirect.
 * The primary redirect is handled by Vercel via vercel.json.
 * This client-side version ensures redirect works in local development
 * and non-Vercel environments.
 */
export default function BizBuzzRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/biz');
  }, [router]);

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center">
      <p className="text-gray-400">Redirecting to /biz...</p>
    </div>
  );
}
